const express = require("express");
const Partner = require("../models/Partner");
const Event = require("../models/Event");
const AffiliateSale = require("../models/AffiliateSale");
const { syncEvent } = require("../services/eventbriteLogisticsService");
const router = express.Router();

function trackingCode(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function existingTrackingCode(value) {
  return String(value || "").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function eventbriteAffiliateUrl(rawUrl, code) {
  const url = new URL(rawUrl);
  if (!/(^|\.)eventbrite\.com$/i.test(url.hostname)) throw new Error("This event does not have a valid Eventbrite registration URL.");
  url.searchParams.set("aff", code);
  return url.toString();
}

router.get("/", async (_req, res) => { try { res.json(await Partner.find().sort({ createdAt: -1 })); } catch { res.status(500).json({ message: "Unable to load partners" }); } });
router.get("/eventbrite-sales", async (req, res) => {
  try {
    const partners = await Partner.find({ $or: [{ workspaceId: req.auth.workspaceId }, { workspaceId: null }] }).select("_id").lean();
    const sales = await AffiliateSale.find({ partnerId: { $in: partners.map((partner) => partner._id) } }).populate("partnerId", "name commissionRate").sort({ purchasedAt: -1, createdAt: -1 }).limit(Math.min(100, Number(req.query.limit) || 25)).lean();
    return res.json(sales);
  } catch (_error) { return res.status(500).json({ message: "Unable to load affiliate sales." }); }
});
router.post("/eventbrite-links", async (req, res) => {
  try {
    const event = await Event.findById(req.body?.localEventId);
    if (!event) return res.status(404).json({ message: "Choose a valid event." });
    const eventbriteEventId = String(event.integrations?.eventbrite?.eventId || "").trim();
    const eventUrl = String(event.integrations?.eventbrite?.url || "").trim();
    if (!eventbriteEventId || !eventUrl) return res.status(400).json({ message: "Choose an event that is connected to Eventbrite." });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "Partner name is required." });
    const baseCode = trackingCode(req.body?.referralCode || name);
    if (baseCode.length < 3) return res.status(400).json({ message: "Enter the affiliate's full name so Growth Operator can create a unique link." });
    let referralCode = baseCode;
    let suffix = 2;
    while (await Partner.exists({ eventbriteEventId, referralCode: new RegExp(`^${referralCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) {
      referralCode = `${baseCode.slice(0, 55)}-${suffix}`;
      suffix += 1;
    }
    const referralLink = eventbriteAffiliateUrl(eventUrl, referralCode);
    const partner = await Partner.create({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user?._id || null,
      name,
      company: String(req.body?.company || "").trim(),
      email: String(req.body?.email || "").trim(),
      phone: String(req.body?.phone || "").trim(),
      type: "affiliate",
      localEventId: event._id,
      eventbriteEventId,
      eventName: event.name,
      trackingProvider: "eventbrite",
      referralCode,
      referralLink,
      commissionRate: Math.min(100, Math.max(0, Number(req.body?.commissionRate) || 0)),
      notes: String(req.body?.notes || "").trim(),
    });
    return res.status(201).json(partner);
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to create the Eventbrite affiliate link." });
  }
});
router.patch("/eventbrite-links/:id/link-existing", async (req, res) => {
  try {
    const [partner, event] = await Promise.all([Partner.findById(req.params.id), Event.findById(req.body?.localEventId)]);
    if (!partner) return res.status(404).json({ message: "Partner not found." });
    if (!event) return res.status(404).json({ message: "Choose the Eventbrite bootcamp event." });
    const eventbriteEventId = String(event.integrations?.eventbrite?.eventId || "").trim();
    const eventUrl = String(event.integrations?.eventbrite?.url || "").trim();
    if (!eventbriteEventId || !eventUrl) return res.status(400).json({ message: "Choose an event that is connected to Eventbrite." });

    let suppliedLink = String(req.body?.referralLink || "").trim();
    let codeFromLink = "";
    if (suppliedLink) {
      const parsed = new URL(suppliedLink);
      if (!/(^|\.)eventbrite\.com$/i.test(parsed.hostname)) return res.status(400).json({ message: "Paste the complete tracking link created by Eventbrite." });
      codeFromLink = existingTrackingCode(parsed.searchParams.get("aff"));
      if (!codeFromLink) return res.status(400).json({ message: "That URL has no Eventbrite affiliate code. Copy the exact tracking link, including its aff parameter." });
    }
    const referralCode = codeFromLink || existingTrackingCode(req.body?.referralCode);
    if (referralCode.length < 3) return res.status(400).json({ message: "Paste the existing Eventbrite tracking link or enter its tracking code." });
    const duplicate = await Partner.findOne({ _id: { $ne: partner._id }, eventbriteEventId, referralCode: new RegExp(`^${referralCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (duplicate) return res.status(409).json({ message: `That Eventbrite code is already linked to ${duplicate.name}.` });
    suppliedLink = suppliedLink || eventbriteAffiliateUrl(eventUrl, referralCode);

    partner.workspaceId = partner.workspaceId || req.auth.workspaceId;
    partner.userId = partner.userId || req.auth.user?._id || null;
    partner.localEventId = event._id;
    partner.eventbriteEventId = eventbriteEventId;
    partner.eventName = event.name;
    partner.trackingProvider = "eventbrite";
    partner.referralCode = referralCode;
    partner.referralLink = suppliedLink;
    await partner.save();

    let syncWarning = "";
    try { await syncEvent(event._id); } catch (error) { syncWarning = error.response?.data?.error_description || error.message || "The link was saved, but sales could not be refreshed yet."; }
    return res.json({ partner: await Partner.findById(partner._id), syncWarning });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to link this partner to Eventbrite." });
  }
});
router.post("/eventbrite-links/:id/sync", async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ message: "Partner not found" });
    if (!partner.localEventId || partner.trackingProvider !== "eventbrite") return res.status(400).json({ message: "This partner is not linked to an Eventbrite event." });
    await syncEvent(partner.localEventId);
    return res.json(await Partner.findById(partner._id));
  } catch (error) {
    await Partner.updateOne({ _id: req.params.id }, { $set: { lastSyncedAt: new Date(), lastSyncStatus: "failed", lastSyncError: error.response?.data?.error_description || error.message || "Unable to sync affiliate sales." } }).catch(() => {});
    return res.status(400).json({ message: error.response?.data?.error_description || error.message || "Unable to sync affiliate sales." });
  }
});
router.post("/eventbrite-links/:id/verify", async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ message: "Partner not found." });
    if (!partner.localEventId || partner.trackingProvider !== "eventbrite") {
      return res.status(400).json({ message: "Connect this partner to an Eventbrite event first." });
    }
    const event = await Event.findById(partner.localEventId);
    if (!event) return res.status(404).json({ message: "The connected event could not be found." });

    const referralUrl = new URL(String(partner.referralLink || ""));
    const eventUrl = new URL(String(event.integrations?.eventbrite?.url || ""));
    const linkCode = String(referralUrl.searchParams.get("aff") || "").trim().toLowerCase();
    const savedCode = String(partner.referralCode || "").trim().toLowerCase();
    const eventbriteEventId = String(event.integrations?.eventbrite?.eventId || "").trim();
    const validEventbriteLink = /(^|\.)eventbrite\.com$/i.test(referralUrl.hostname);
    const sameEventPage = referralUrl.origin === eventUrl.origin && (
      referralUrl.pathname.replace(/\/$/, "") === eventUrl.pathname.replace(/\/$/, "") ||
      Boolean(eventbriteEventId && referralUrl.pathname.includes(eventbriteEventId) && eventUrl.pathname.includes(eventbriteEventId))
    );
    const trackingCodeMatches = Boolean(linkCode && savedCode && linkCode === savedCode);
    const eventConnected = Boolean(eventbriteEventId && String(partner.eventbriteEventId || "") === eventbriteEventId);

    if (!validEventbriteLink || !trackingCodeMatches || !eventConnected || !sameEventPage) {
      return res.status(400).json({
        message: "This affiliate link needs attention before it is shared.",
        checks: { validEventbriteLink, trackingCodeMatches, eventConnected, sameEventPage, eventbriteSync: false },
      });
    }

    await syncEvent(partner.localEventId);
    const refreshed = await Partner.findById(partner._id);
    const checks = { validEventbriteLink, trackingCodeMatches, eventConnected, sameEventPage, eventbriteSync: true };
    return res.json({
      partner: refreshed,
      checks,
      message: refreshed.lastSaleAt
        ? "Tracking is working. Eventbrite has returned at least one purchase for this affiliate link."
        : "The link, event, tracking code, and Eventbrite connection all passed. No purchase has been attributed to this link yet.",
    });
  } catch (error) {
    await Partner.updateOne({ _id: req.params.id }, { $set: { lastSyncedAt: new Date(), lastSyncStatus: "failed", lastSyncError: error.response?.data?.error_description || error.message || "Unable to verify affiliate tracking." } }).catch(() => {});
    return res.status(400).json({ message: error.response?.data?.error_description || error.message || "Unable to verify affiliate tracking." });
  }
});
router.post("/", async (req, res) => { try { const partner = await Partner.create(req.body); res.status(201).json(partner); } catch (err) { res.status(400).json({ message: err.message || "Unable to create partner" }); } });
router.patch("/:id", async (req, res) => { try { const partner = await Partner.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }); if (!partner) return res.status(404).json({ message: "Partner not found" }); res.json(partner); } catch { res.status(400).json({ message: "Unable to update partner" }); } });
router.delete("/:id", async (req, res) => { try { const partner = await Partner.findByIdAndDelete(req.params.id); if (!partner) return res.status(404).json({ message: "Partner not found" }); res.json({ success: true }); } catch { res.status(400).json({ message: "Unable to delete partner" }); } });
module.exports = router;
