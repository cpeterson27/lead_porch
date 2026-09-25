const express = require("express");
const mongoose = require("mongoose");
const Testimonial = require("../models/Testimonial");
const PublicProfile = require("../models/PublicProfile");
const CoachingProgram = require("../models/CoachingProgram");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const service = require("../services/publicSiteService");
const applicationService = require("../services/publicApplicationService");
const leadMagnetService = require("../services/leadMagnetService");
const paymentService = require("../services/paymentService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const router = express.Router();
const attempts = new Map();
const CoachProfile = require("../models/CoachProfile");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const DiscoveryCallBooking = require("../models/DiscoveryCallBooking");
const googleCalendarService = require("../services/googleCalendarService");
const CommunicationConsent = require("../models/CommunicationConsent");
const { normalizePhone } = require("../services/communicationPolicyService");

function zonedDate(year, month, day, hour, minute, timezone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let value = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    value += target - shown;
  }
  return new Date(value);
}

async function discoveryConfig(req) {
  const ws = await service.workspace(req);
  const config = await runWithWorkspace(ws._id, () => WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).lean());
  const availability = config?.publicSite?.discoveryCallAvailability || {};
  if (!config?.publicSite?.discoveryCallEnabled || !availability.coachProfileId) throw Object.assign(new Error("Discovery call booking is not available yet"), { status: 404 });
  return { ws, config, availability };
}
function limited(req, res, next) {
  const key = String(req.ip || "local");
  const now = Date.now(),
    row = attempts.get(key) || [];
  const recent = row.filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 5)
    return res
      .status(429)
      .json({ error: "Please wait before submitting again" });
  recent.push(now);
  attempts.set(key, recent);
  next();
}
router.get("/site", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const data = await service.site(req);
    const legalPath = String(req.query.publicPath || "").match(
      /^\/(?:privacy(?:-policy)?|terms|data-deletion)\/?$/,
    );
    if (!data.publicSite?.published && !legalPath)
      return res.status(404).json({ error: "This website is not published." });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
router.get("/discovery-call/availability", async (req, res, next) => {
  try {
    const { ws, availability } = await discoveryConfig(req);
    const horizonDays = Math.min(90, Math.max(1, Number(availability.horizonDays || 30)));
    const durationMinutes = Math.min(180, Math.max(15, Number(availability.durationMinutes || 30)));
    const bufferMinutes = Math.min(120, Math.max(0, Number(availability.bufferMinutes || 15)));
    const probe = await runWithWorkspace(ws._id, () => googleCalendarService.busyWindow({ workspaceId: ws._id, coachProfileId: availability.coachProfileId, timeMin: new Date(), timeMax: new Date(Date.now() + (horizonDays + 1) * 86400000) }));
    const days = new Set((availability.days || [1, 2, 3, 4, 5]).map(Number));
    const weeklyHours = new Map((availability.weeklyHours || []).map((row) => [Number(row.day), row]));
    const busy = probe.busy.map((row) => ({ start: new Date(row.start).getTime() - bufferMinutes * 60000, end: new Date(row.end).getTime() + bufferMinutes * 60000 }));
    const slots = [];
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: probe.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (let offset = 1; offset <= horizonDays; offset += 1) {
      const noon = new Date(Date.now() + offset * 86400000);
      const [year, month, day] = localDate.format(noon).split("-").map(Number);
      const dateProbe = zonedDate(year, month, day, 12, 0, probe.timezone);
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: probe.timezone, weekday: "short" }).format(dateProbe);
      const weekdayNumber = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
      const schedule = weeklyHours.get(weekdayNumber);
      if (schedule ? schedule.enabled !== true : !days.has(weekdayNumber)) continue;
      const [startHour, startMinute] = String(schedule?.startTime || availability.startTime || "09:00").split(":").map(Number);
      const [endHour, endMinute] = String(schedule?.endTime || availability.endTime || "17:00").split(":").map(Number);
      const localStart = zonedDate(year, month, day, startHour, startMinute, probe.timezone);
      const localEnd = zonedDate(year, month, day, endHour, endMinute, probe.timezone);
      for (let start = localStart.getTime(); start + durationMinutes * 60000 <= localEnd.getTime(); start += (durationMinutes + bufferMinutes) * 60000) {
        const end = start + durationMinutes * 60000;
        if (start > Date.now() + 2 * 60 * 60 * 1000 && !busy.some((row) => start < row.end && end > row.start)) slots.push(new Date(start).toISOString());
      }
    }
    res.json({ success: true, data: { slots: slots.slice(0, 200), durationMinutes, timezone: probe.timezone } });
  } catch (error) { next(error); }
});
router.post("/discovery-call/book", limited, async (req, res, next) => {
  try {
    const { ws, availability } = await discoveryConfig(req);
    const name = String(req.body?.name || "").trim().slice(0, 180);
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 320);
    const startsAt = new Date(req.body?.startsAt);
    const durationMinutes = Math.min(180, Math.max(15, Number(availability.durationMinutes || 30)));
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || Number.isNaN(startsAt.getTime())) return res.status(400).json({ error: "Name, email, and a valid appointment time are required" });
    const requestedProgramId = String(req.body?.programId || "").trim();
    let selectedProgram = null;
    if (requestedProgramId && requestedProgramId !== "not_sure") {
      if (!mongoose.isValidObjectId(requestedProgramId)) return res.status(400).json({ error: "Please choose an available coaching program" });
      selectedProgram = await runWithWorkspace(ws._id, () => CoachingProgram.findOne({
        _id: requestedProgramId,
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      }).select("name publicPresentation.title publicPresentation.slug").lean());
      if (!selectedProgram) return res.status(400).json({ error: "Please choose an available coaching program" });
    }
    const programSnapshot = requestedProgramId === "not_sure"
      ? { name: "Not sure yet — help me choose", slug: "" }
      : selectedProgram
        ? { name: selectedProgram.publicPresentation?.title || selectedProgram.name, slug: selectedProgram.publicPresentation?.slug || "" }
        : { name: "", slug: "" };
    const qualification = {
      experience: String(req.body?.qualification?.experience || "").trim().slice(0, 160),
      primaryGoal: String(req.body?.qualification?.primaryGoal || "").trim().slice(0, 500),
      timeline: String(req.body?.qualification?.timeline || "").trim().slice(0, 160),
    };
    const qualificationSummary = [qualification.experience, qualification.timeline, qualification.primaryGoal].filter(Boolean).join(" · ");
    const check = await runWithWorkspace(ws._id, () => googleCalendarService.availability({ workspaceId: ws._id, coachProfileId: availability.coachProfileId, startsAt, durationMinutes }));
    if (!check.available) return res.status(409).json({ error: "That time was just booked. Please choose another available time." });
    const scheduled = await runWithWorkspace(ws._id, () => googleCalendarService.scheduleDiscoveryCall({ workspaceId: ws._id, coachProfileId: availability.coachProfileId, startsAt, durationMinutes, name, email, phone: String(req.body?.phone || "").slice(0, 80), notes: String(req.body?.notes || "").slice(0, 2000), programName: programSnapshot.name, qualificationSummary }));
    const booking = await runWithWorkspace(ws._id, () => DiscoveryCallBooking.create({ workspaceId: ws._id, coachProfileId: availability.coachProfileId, name, email, phone: String(req.body?.phone || "").slice(0, 80), notes: String(req.body?.notes || "").slice(0, 2000), coachingProgramId: selectedProgram?._id || null, programSnapshot, qualification, startsAt, durationMinutes, timezone: scheduled.timezone, calendar: { connectionId: scheduled.connection._id, calendarId: scheduled.calendarId, eventId: scheduled.event.id, htmlLink: scheduled.event.htmlLink || "", meetUrl: scheduled.meetUrl } }));
    const smsAddress = normalizePhone(req.body?.phone);
    if (req.body?.smsConsent === true && smsAddress)
      await runWithWorkspace(ws._id, () => CommunicationConsent.findOneAndUpdate(
        { workspaceId: ws._id, channel: "sms", address: smsAddress, purpose: "all" },
        { $set: { status: "opted_in", source: "web_form", proof: `${name} <${email}> checked SMS opt-in on the discovery call booking form`, consentedAt: new Date(), revokedAt: null } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ));
    res.status(201).json({ success: true, data: { id: booking._id, startsAt: booking.startsAt, durationMinutes, timezone: booking.timezone } });
  } catch (error) { next(error); }
});
router.get("/programs", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const rows = await runWithWorkspace(ws._id, () =>
      CoachingProgram.find({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      })
        .sort({ "publicPresentation.sortOrder": 1 })
        .lean(),
    );
    res.json({ success: true, data: rows.map(service.programProjection) });
  } catch (error) {
    next(error);
  }
});
router.get("/programs/:slug", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const row = await runWithWorkspace(ws._id, () =>
      CoachingProgram.findOne({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
        "publicPresentation.slug": String(req.params.slug).toLowerCase(),
      }).lean(),
    );
    if (!row) return res.status(404).json({ error: "Program not found" });
    res.json({ success: true, data: service.programProjection(row) });
  } catch (error) {
    next(error);
  }
});
router.get("/application", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const config = await runWithWorkspace(ws._id, () =>
      WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).lean(),
    );
    const programs = await runWithWorkspace(ws._id, () =>
      CoachingProgram.find({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      })
        .sort({ "publicPresentation.sortOrder": 1 })
        .lean(),
    );
    res.json({
      success: true,
      data: {
        ...applicationService.publicConfig(config),
        programs: programs.map(service.programProjection),
      },
    });
  } catch (error) {
    next(error);
  }
});
router.post("/application/start", limited, async (req, res) => {
  try {
    const ws = await service.workspace(req);
    await runWithWorkspace(ws._id, () => applicationService.start({ workspaceId: ws._id, email: req.body?.email, firstName: req.body?.firstName }));
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/application", limited, async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const item = await runWithWorkspace(ws._id, () =>
      applicationService.submit({
        workspaceId: ws._id,
        input: req.body || {},
        requestFingerprint: String(req.ip || ""),
      }),
    );
    const config = await runWithWorkspace(ws._id, () =>
      WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).lean(),
    );
    const qualified = item.status === "qualified";
    res.status(201).json({
      success: true,
      data: {
        applicationId: item._id,
        qualified,
        bookingUrl: qualified ? "/book-a-call" : "",
        message: qualified
          ? "You're all set — pick a time that works for you below."
          : applicationService.publicConfig(config).confirmationMessage,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/lead-magnet/optin", limited, async (req, res) => {
  try {
    const ws = await service.workspace(req);
    await runWithWorkspace(ws._id, () => leadMagnetService.optIn({ workspaceId: ws._id, email: req.body?.email, firstName: req.body?.firstName }));
    res.status(201).json({ success: true, data: { message: "Check your email — it's on its way." } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/programs/:slug/checkout", limited, async (req, res) => {
  try {
    const ws = await service.workspace(req);
    const program = await runWithWorkspace(ws._id, () =>
      CoachingProgram.findOne({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
        "publicPresentation.slug": String(req.params.slug).toLowerCase(),
      }).select("_id").lean(),
    );
    if (!program) return res.status(404).json({ error: "Program not found" });
    const result = await runWithWorkspace(ws._id, () =>
      paymentService.beginPublicProgramCheckout({
        workspaceId: ws._id,
        programId: program._id,
        input: req.body || {},
      }),
    );
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "PAYMENT_REQUEST_FAILED" });
  }
});
router.get("/testimonials", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const rows = await runWithWorkspace(ws._id, () =>
      Testimonial.find({ workspaceId: ws._id, status: "approved" })
        .sort({ featured: -1, sortOrder: 1, approvedAt: -1 })
        .lean(),
    );
    res.json({ success: true, data: rows.map(service.testimonialProjection) });
  } catch (error) {
    next(error);
  }
});
router.post("/testimonials", limited, async (req, res, next) => {
  try {
    if (req.body?.consentConfirmed !== true)
      return res
        .status(400)
        .json({ error: "Consent for public display is required" });
    const ws = await service.workspace(req);
    const displayName = String(req.body?.displayName || "").trim(),
      body = String(req.body?.body || "").trim();
    if (displayName.length < 2 || body.length < 20)
      return res.status(400).json({
        error: "Add your name and a testimonial of at least 20 characters",
      });
    await runWithWorkspace(ws._id, () =>
      Testimonial.create({
        workspaceId: ws._id,
        displayName,
        headline: String(req.body?.headline || "").slice(0, 300),
        body: body.slice(0, 8000),
        rating: Number(req.body?.rating) || null,
        videoUrl: service.safeUrl(req.body?.videoUrl),
        consentConfirmed: true,
        status: "pending",
      }),
    );
    res.status(202).json({
      success: true,
      message: "Thank you. Your testimonial was submitted for review.",
    });
  } catch (error) {
    next(error);
  }
});
router.get("/profiles/:slug", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const row = await runWithWorkspace(ws._id, () =>
      PublicProfile.findOne({
        workspaceId: ws._id,
        slug: String(req.params.slug).toLowerCase(),
        status: "published",
      }).lean(),
    );
    if (!row) return res.status(404).json({ error: "Profile not found" });
    if (row.ownerType === "coach") {
      const coach = await runWithWorkspace(ws._id, () =>
        CoachProfile.findOne({
          _id: row.coachProfileId,
          workspaceId: ws._id,
          status: "active",
        })
          .select("userId")
          .lean(),
      );
      const member = coach
        ? await runWithWorkspace(ws._id, () =>
            WorkspaceMembership.exists({
              workspaceId: ws._id,
              userId: coach.userId,
              status: "active",
            }),
          )
        : null;
      if (!coach || !member || !row.displayName || !row.bio)
        return res.status(404).json({ error: "Profile not found" });
    }
    res.json({ success: true, data: service.profileProjection(row) });
  } catch (error) {
    next(error);
  }
});
router.get("/profile-edit/:token", limited, async (req, res, next) => {
  try {
    const found = await service.tokenProfile(req.params.token);
    if (!found)
      return res
        .status(404)
        .json({ error: "This profile-edit link is invalid or expired" });
    res.json({
      success: true,
      data: service.profileProjection(found.profile),
      status: found.profile.status,
    });
  } catch (error) {
    next(error);
  }
});
router.patch("/profile-edit/:token", limited, async (req, res, next) => {
  try {
    const found = await service.tokenProfile(req.params.token);
    if (!found)
      return res
        .status(404)
        .json({ error: "This profile-edit link is invalid or expired" });
    Object.assign(
      found.profile,
      service.profileInput({ ...found.profile.toObject(), ...req.body }),
    );
    await found.profile.save();
    res.json({
      success: true,
      data: service.profileProjection(found.profile),
      status: found.profile.status,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
module.exports = router;
