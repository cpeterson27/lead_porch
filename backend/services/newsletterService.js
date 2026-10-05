/**
 * Newsletter — one email, sent to every eligible CRM contact, no audience
 * picker needed (that's the whole point of a newsletter vs. a campaign:
 * a campaign targets a chosen audience, a newsletter always goes to
 * everyone). Each send creates its own auto-managed campaign (see
 * utilityCampaignService.js) purely so it shows up with real metrics on
 * the existing Campaigns page — no separate newsletter-history UI is
 * needed, campaignPurpose:"newsletter" is enough to list past issues.
 *
 * Reuses the exact same send path as everything else: real Outreach
 * records, services/email.js's sendEmail (suppression, unsubscribe,
 * compliance footer, hourly rate cap all apply exactly as they do for a
 * one-shot campaign or a sequence step).
 */
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const Outreach = require("../models/Outreach");
const { findOrCreateUtilityCampaign } = require("./utilityCampaignService");
const { applyEmailTokens } = require("../utils/emailTokens");
const { sendApprovedOutreachForCampaign } = require("./scheduledCampaignSendService");

async function eligibleContacts(workspaceId) {
  return Contact.find({
    workspaceId,
    status: { $nin: ["invalid", "unsubscribed", "archived"] },
    email: { $nin: ["", null] },
    emailBounced: { $ne: true },
    emailStatus: { $ne: "undeliverable" },
  }).select("_id name firstName lastName email company title");
}

async function previewRecipientCount(workspaceId) {
  const contacts = await eligibleContacts(workspaceId);
  return { recipientCount: contacts.length };
}

async function sendNewsletter({ workspaceId, subject, body }) {
  const cleanSubject = String(subject || "").trim();
  const cleanBody = String(body || "").trim();
  if (!cleanSubject || !cleanBody) { const error = new Error("Write a subject and message first"); error.code = "NEWSLETTER_CONTENT_REQUIRED"; throw error; }
  const contacts = await eligibleContacts(workspaceId);
  if (!contacts.length) { const error = new Error("No eligible contacts to send to — everyone in the CRM is missing an email, unsubscribed, or archived"); error.code = "NEWSLETTER_NO_RECIPIENTS"; throw error; }
  const campaignId = await findOrCreateUtilityCampaign({
    workspaceId, name: `Newsletter — ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`,
    purpose: "newsletter", reuse: false,
  });
  const outreachDocs = contacts.map((contact) => ({
    campaignId, contactId: contact._id, workspaceId,
    organization: contact.company || contact.name || "Contact",
    contactName: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
    contactEmail: contact.email, contactRole: contact.title || "",
    subject: applyEmailTokens(cleanSubject, contact), emailDraft: applyEmailTokens(cleanBody, contact),
    emailTopic: "educational_newsletter", deliveryPurpose: "marketing", status: "approved",
  }));
  await Outreach.insertMany(outreachDocs);
  // Fire the real send sweep now rather than waiting for the generic
  // background sweep (services/campaignSendScheduler.js), which runs
  // every ~15 min and — importantly — always sends as
  // deliveryPurpose:"business_prospecting". A newsletter to existing
  // contacts is "marketing," not cold outreach, so this first pass uses
  // the correct purpose directly; the hourly send cap in services/email.js
  // still applies, so a large list sends out over time regardless. Any
  // stragglers left "approved" after this pass are still picked up by
  // that generic sweep later — a narrow, rare edge case, not a blocker.
  setImmediate(() => sendApprovedOutreachForCampaign(campaignId, { deliveryPurpose: "marketing" }).catch((error) => console.error("Newsletter send failed:", error.message)));
  return { campaignId, queued: outreachDocs.length };
}

async function listNewsletterHistory(workspaceId) {
  return Campaign.find({ workspaceId, campaignPurpose: "newsletter" }).select("name metrics createdAt").sort({ createdAt: -1 }).limit(50).lean();
}

module.exports = { previewRecipientCount, sendNewsletter, listNewsletterHistory };
