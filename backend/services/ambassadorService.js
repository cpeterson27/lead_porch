const AmbassadorProfile = require("../models/AmbassadorProfile");
const ReferralAttribution = require("../models/ReferralAttribution");
const CommissionLedger = require("../models/CommissionLedger");
const Contact = require("../models/Contact");
const CoachingApplication = require("../models/CoachingApplication");
const Enrollment = require("../models/Enrollment");
const CrmActivity = require("../models/CrmActivity");
const User = require("../models/User"); const WorkspaceConfig = require("../models/WorkspaceConfig"); const welcome = require("./ambassadorWelcomeService");
const referralIdentity = require("./ambassadorReferralIdentityService");
const contactService = require("./contactService");
const referralCommissionService = require("./referralCommissionService");
const auditService = require("./auditService");
const deps = { AmbassadorProfile, ReferralAttribution, CommissionLedger, Contact, CoachingApplication, Enrollment, CrmActivity, User, WorkspaceConfig, contactService, referralCommissionService };
function fail(message, code) { const error = new Error(message); error.code = code; return error; }
const referralUrl = referralIdentity.referralUrl;
async function ownProfile({ workspaceId, userId }, models = deps) { const profile = await models.AmbassadorProfile.findOne({ workspaceId, userId, status: "active" }).populate("userId", require("./userProfileService").selection).lean(); if (!profile) throw fail("Active ambassador profile not found", "AMBASSADOR_NOT_FOUND"); const identity = require("./userProfileService").resolveProfile(profile.userId, profile); return { ...profile, ...identity, displayName: identity.name, publicLocation: identity.location, referralUrl: referralUrl(profile.referralSlug || profile.referralCode) }; }
async function ownProfileWithCompleteness({ workspaceId, userId }, models = deps) { const [profile, config] = await Promise.all([ownProfile({ workspaceId, userId }, models), models.WorkspaceConfig.findOne({ workspaceId, key: "primary" }).lean()]); return { ...profile, completeness: welcome.completeness(profile, profile.userId, config?.ambassadorOnboarding?.requiredFields) }; }
async function updateOwnProfile({ workspaceId, userId, changes }, models = deps) {
  await ownProfile({ workspaceId, userId }, models);
  const identity = { ...changes };
  delete identity.notificationPreferences;
  if (identity.displayName !== undefined) { identity.name = identity.displayName; delete identity.displayName; }
  if (identity.publicLocation !== undefined) { identity.location = identity.publicLocation; delete identity.publicLocation; }
  await require("./userProfileService").save({ workspaceId, userId }, identity, models);
  if (changes.notificationPreferences) await models.AmbassadorProfile.updateOne({ workspaceId, userId, status: "active" }, { $set: { "notificationPreferences.email": changes.notificationPreferences.email !== false, "notificationPreferences.inApp": changes.notificationPreferences.inApp !== false } });
  return ownProfileWithCompleteness({ workspaceId, userId }, models);
}
async function referrals({ workspaceId, ambassadorProfileId }, models = deps) { return models.ReferralAttribution.find({ workspaceId, ambassadorProfileId, promoterType: "ambassador" }).populate("contactId", "name firstName lastName email status").populate("applicationId", "status submittedAt coachingProgramId").populate("enrollmentId", "status startsAt coachingProgramId").sort({ attributedAt: -1 }).lean(); }
async function payouts({ workspaceId, ambassadorProfileId }, models = deps) { return models.CommissionLedger.find({ workspaceId, ambassadorProfileId, beneficiaryType: "ambassador" }).populate("contactId", "name firstName lastName email").populate("coachingProgramId", "name").sort({ calculatedAt: -1 }).lean(); }
function privateReferral(row) { const first = String(row.contactId?.firstName || row.contactId?.name || "Referred person").trim().split(/\s+/)[0]; const last = String(row.contactId?.lastName || "").trim(); return { _id: row._id, referredPerson: last ? `${first} ${last[0]}.` : first, state: row.state, source: row.source, attributedAt: row.attributedAt, applicationStatus: row.applicationId?.status || "", applicationSubmittedAt: row.applicationId?.submittedAt || null, enrollmentStatus: row.enrollmentId?.status || "", enrollmentStartsAt: row.enrollmentId?.startsAt || null, consent: row.consent || null, followUpNotes: row.followUpNotes || [], dispute: row.dispute || null }; }
function privatePayout(row) { return { _id: row._id, productLabel: row.productLabel, commissionAmountMinor: row.commissionAmountMinor, currency: row.currency, status: row.status, calculatedAt: row.calculatedAt, approvedAt: row.approvedAt, paidAt: row.paidAt, reversedAt: row.reversedAt }; }
async function ownReferrals({ workspaceId, ambassadorProfileId }, models = deps) { const rows = await models.ReferralAttribution.find({ workspaceId, ambassadorProfileId, promoterType: "ambassador" }).populate("contactId", "firstName lastName").populate("applicationId", "status submittedAt").populate("enrollmentId", "status startsAt").sort({ attributedAt: -1 }).lean(); return rows.map(privateReferral); }
async function ownPayouts({ workspaceId, ambassadorProfileId }, models = deps) { const rows = await models.CommissionLedger.find({ workspaceId, ambassadorProfileId, beneficiaryType: "ambassador" }).select("productLabel commissionAmountMinor currency status calculatedAt approvedAt paidAt reversedAt").sort({ calculatedAt: -1 }).lean(); return rows.map(privatePayout); }

/**
 * An ambassador submitting a referral themselves (as opposed to the
 * automatic link-based attribution flow). Requires explicit consent and
 * always attributes to the CALLER's own referral code — an ambassador can
 * never attribute a referral to a different promoter's code. Safe duplicate
 * handling: if this email already has an attribution (to anyone), the
 * existing safe (privacy-scrubbed) record is returned rather than a
 * confidential cross-ambassador record ever being disclosed.
 */
async function submitReferral({ workspaceId, ambassadorProfileId, actorUserId, name, email, phone = "", source = "ambassador_manual", consentGiven }, models = deps) {
  if (!consentGiven) throw fail("Consent must be recorded before submitting a referral", "REFERRAL_CONSENT_REQUIRED");
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !name?.trim()) throw fail("A name and email are required", "REFERRAL_INPUT_INVALID");
  const profile = await models.AmbassadorProfile.findOne({ _id: ambassadorProfileId, workspaceId, status: "active" }).lean();
  if (!profile) throw fail("Active ambassador profile not found", "AMBASSADOR_NOT_FOUND");

  // Resolve any existing contact by email first, then check for an existing
  // attribution on it. If it's already attributed to THIS ambassador, show
  // their own safe record; if it belongs to anyone else, confirm only that
  // it's a duplicate — never disclose another promoter's record, even in
  // its privacy-scrubbed form.
  const existingContact = await models.Contact.findOne({ workspaceId, email: cleanEmail }).lean();
  if (existingContact) {
    const existing = await models.ReferralAttribution.findOne({ workspaceId, contactId: existingContact._id }).populate("contactId", "firstName lastName").populate("applicationId", "status submittedAt").populate("enrollmentId", "status startsAt").lean();
    if (existing && String(existing.ambassadorProfileId) === String(ambassadorProfileId)) return { referral: privateReferral(existing), duplicate: true };
    if (existing) return { referral: null, duplicate: true, reason: "This person has already been referred through another promoter." };
  }

  const [firstName, ...restName] = String(name).trim().split(/\s+/);
  const contact = await models.contactService.upsertContact({ name: name.trim(), firstName, lastName: restName.join(" "), email: cleanEmail, phone, source: "ambassador_referral", tags: ["ambassador-referral"], status: "active" });
  const created = await models.referralCommissionService.attributeReferral({ workspaceId, contactId: contact._id, referralCode: profile.referralCode, source, actorUserId }, models);
  await models.ReferralAttribution.updateOne({ _id: created._id }, { $set: { consent: { given: true, source: source, capturedAt: new Date() } } });
  const populated = await models.ReferralAttribution.findById(created._id).populate("contactId", "firstName lastName").populate("applicationId", "status submittedAt").populate("enrollmentId", "status startsAt").lean();
  await auditService.record({ workspaceId, actorUserId, action: "referral.submitted", targetType: "ReferralAttribution", targetId: created._id, after: { source, ambassadorProfileId }, success: true });
  return { referral: privateReferral(populated), duplicate: false };
}

/** A follow-up note/reminder the promoter keeps on their own referral — never an internal sales note. */
async function addFollowUpNote({ workspaceId, ambassadorProfileId, attributionId, userId, note, reminderAt = null }, models = deps) {
  if (!note?.trim()) throw fail("A note is required", "FOLLOW_UP_NOTE_REQUIRED");
  const row = await models.ReferralAttribution.findOne({ _id: attributionId, workspaceId, ambassadorProfileId, promoterType: "ambassador" });
  if (!row) throw fail("Referral not found", "REFERRAL_NOT_FOUND");
  row.followUpNotes.push({ note: note.trim(), reminderAt: reminderAt ? new Date(reminderAt) : null, createdBy: userId });
  await row.save();
  return row.followUpNotes.at(-1);
}

/** An ambassador reporting that a referral's attribution looks wrong — never resolved by the ambassador themselves. */
async function fileDispute({ workspaceId, ambassadorProfileId, attributionId, userId, reason }, models = deps) {
  if (!reason?.trim()) throw fail("A reason is required to file a dispute", "DISPUTE_REASON_REQUIRED");
  const row = await models.ReferralAttribution.findOne({ _id: attributionId, workspaceId, ambassadorProfileId, promoterType: "ambassador" });
  if (!row) throw fail("Referral not found", "REFERRAL_NOT_FOUND");
  if (row.dispute?.status === "open") throw fail("A dispute is already open for this referral", "DISPUTE_ALREADY_OPEN");
  row.dispute = { status: "open", reason: reason.trim(), filedByUserId: userId, filedAt: new Date(), resolution: "", resolvedByUserId: null, resolvedAt: null };
  await row.save();
  await models.CrmActivity.create({ workspaceId, contactId: row.contactId, type: "system", source: "crm", title: "Ambassador filed an attribution dispute", createdBy: userId, metadata: { eventType: "ambassador.referral.dispute_filed", referralAttributionId: row._id, reason: reason.trim() } });
  await auditService.record({ workspaceId, actorUserId: userId, action: "referral.dispute_filed", targetType: "ReferralAttribution", targetId: row._id, after: { reason: reason.trim() }, success: true });
  return row.dispute;
}

async function resolveDispute({ workspaceId, attributionId, actorUserId, status, resolution = "" }, models = deps) {
  if (!["resolved", "dismissed"].includes(status)) throw fail("Invalid dispute resolution status", "DISPUTE_STATUS_INVALID");
  const row = await models.ReferralAttribution.findOne({ _id: attributionId, workspaceId, "dispute.status": "open" });
  if (!row) throw fail("Open dispute not found", "DISPUTE_NOT_FOUND");
  row.dispute.status = status; row.dispute.resolution = resolution.trim(); row.dispute.resolvedByUserId = actorUserId; row.dispute.resolvedAt = new Date();
  await row.save();
  await models.CrmActivity.create({ workspaceId, contactId: row.contactId, type: "system", source: "crm", title: `Attribution dispute ${status}`, createdBy: actorUserId, metadata: { eventType: `ambassador.referral.dispute_${status}`, referralAttributionId: row._id, resolution: resolution.trim() } });
  await auditService.record({ workspaceId, actorUserId, action: "referral.dispute_resolved", targetType: "ReferralAttribution", targetId: row._id, after: { status, resolution: resolution.trim() }, success: true });
  return row;
}
async function updateProfile({ workspaceId, profileId, changes }, models = deps) { const update = {}; for (const key of ["displayName", "notes", "startDate", "contactId"]) if (changes[key] !== undefined) update[key] = changes[key]; if (changes.communityUrl !== undefined) update.communityUrl = referralIdentity.validateCommunityUrl(changes.communityUrl); if (changes.commissionConfig) update.commissionConfig = changes.commissionConfig; const profile = await models.AmbassadorProfile.findOneAndUpdate({ _id: profileId, workspaceId }, { $set: update }, { new: true, runValidators: true }); if (!profile) throw fail("Ambassador profile not found", "AMBASSADOR_NOT_FOUND"); const result = typeof profile.toObject === "function" ? profile.toObject() : profile; return { ...result, referralUrl: referralUrl(profile.referralSlug || profile.referralCode) }; }
async function setStatus({ workspaceId, profileId, status }, models = deps) { if (!["active", "inactive"].includes(status)) throw fail("Valid ambassador status required", "AMBASSADOR_STATUS_INVALID"); const profile = await models.AmbassadorProfile.findOneAndUpdate({ _id: profileId, workspaceId }, { $set: { status, deactivatedAt: status === "inactive" ? new Date() : null } }, { new: true }); if (!profile) throw fail("Ambassador profile not found", "AMBASSADOR_NOT_FOUND"); return profile; }
async function transitionReferral({ workspaceId, attributionId, state, actorUserId }, models = deps) { const allowed = ["referred", "applied", "qualified", "enrolled", "converted", "cancelled", "refunded"]; if (!allowed.includes(state)) throw fail("Invalid referral state", "REFERRAL_STATE_INVALID"); const row = await models.ReferralAttribution.findOne({ _id: attributionId, workspaceId, promoterType: "ambassador" }); if (!row) throw fail("Ambassador referral not found", "REFERRAL_NOT_FOUND"); row.state = state; await row.save(); await models.CrmActivity.create({ workspaceId, contactId: row.contactId, type: "system", source: "crm", title: `Ambassador referral marked ${state}`, createdBy: actorUserId, metadata: { eventType: "ambassador.referral.state_changed", referralAttributionId: row._id, state } }); return row; }
async function createPayout(input, models = deps) {
  const attribution = await models.ReferralAttribution.findOne({ _id: input.referralAttributionId, workspaceId: input.workspaceId, promoterType: "ambassador" }).lean(); if (!attribution) throw fail("Ambassador referral not found", "REFERRAL_NOT_FOUND");
  const profile = await models.AmbassadorProfile.findOne({ _id: attribution.ambassadorProfileId, workspaceId: input.workspaceId }).lean(); if (!profile) throw fail("Ambassador profile not found", "AMBASSADOR_NOT_FOUND");
  let enrollment = null; if (input.enrollmentId) { enrollment = await models.Enrollment.findOne({ _id: input.enrollmentId, workspaceId: input.workspaceId, contactId: attribution.contactId }).lean(); if (!enrollment) throw fail("Enrollment must belong to the referred Contact and workspace", "ENROLLMENT_MISMATCH"); }
  const gross = Math.max(0, Math.round(Number(input.grossAmountMinor) || 0)), config = profile.commissionConfig || { mode: "manual" };
  const amount = config.mode === "percent" ? Math.round(gross * (Number(config.rateBps) || 0) / 10000) : config.mode === "fixed" ? Number(config.fixedAmountMinor) || 0 : Math.max(0, Math.round(Number(input.commissionAmountMinor) || 0));
  const saleReference = String(input.saleReference || `ambassador:${attribution._id}:${enrollment?._id || "manual"}`);
  const existing = await models.CommissionLedger.findOne({ workspaceId: input.workspaceId, saleType: "manual", saleReference }); if (existing) return existing;
  const row = await models.CommissionLedger.create({ workspaceId: input.workspaceId, referralAttributionId: attribution._id, beneficiaryType: "ambassador", ambassadorProfileId: profile._id, ambassadorUserId: profile.userId, contactId: attribution.contactId, coachingProgramId: enrollment?.coachingProgramId || null, productLabel: input.productLabel || enrollment?.programSnapshot?.name || "Ambassador referral", saleType: "manual", saleReference, grossAmountMinor: gross, rateBps: config.mode === "percent" ? config.rateBps : 0, commissionAmountMinor: amount, currency: config.currency || input.currency || "USD", status: "pending", calculatedAt: new Date(), ruleSnapshot: { source: "ambassador_profile", mode: config.mode, rateBps: config.rateBps || 0, fixedAmountMinor: config.fixedAmountMinor || 0 }, payoutNotes: String(input.notes || "").trim(), createdBy: input.actorUserId });
  await models.CrmActivity.create({ workspaceId: input.workspaceId, contactId: attribution.contactId, type: "system", source: "crm", title: "Ambassador payout created", createdBy: input.actorUserId, metadata: { eventType: "ambassador.payout.created", commissionLedgerId: row._id, ambassadorProfileId: profile._id, commissionAmountMinor: amount } }); return row;
}
async function transitionPayout({ workspaceId, payoutId, status, notes = "", actorUserId }, models = deps) { const row = await models.CommissionLedger.findOne({ _id: payoutId, workspaceId, beneficiaryType: "ambassador" }); if (!row) throw fail("Ambassador payout not found", "PAYOUT_NOT_FOUND"); const allowed = { pending: ["approved", "void"], approved: ["paid", "void"], paid: ["void"], void: [] }; if (!allowed[row.status]?.includes(status)) throw fail("Invalid payout status transition", "PAYOUT_STATUS_INVALID"); row.status = status; row.updatedBy = actorUserId; row.payoutNotes = String(notes || row.payoutNotes || "").trim(); if (status === "approved") row.approvedAt = new Date(); if (status === "paid") row.paidAt = new Date(); if (status === "void") { row.reversedAt = new Date(); row.reversalReason = row.payoutNotes || "Voided by administrator"; } await row.save(); await models.CrmActivity.create({ workspaceId, contactId: row.contactId, type: "system", source: "crm", title: `Ambassador payout ${status}`, createdBy: actorUserId, metadata: { eventType: `ambassador.payout.${status}`, commissionLedgerId: row._id, notes: row.payoutNotes } }); return row; }
module.exports = { addFollowUpNote, createPayout, fileDispute, ownPayouts, ownProfile, ownProfileWithCompleteness, ownReferrals, payouts, privatePayout, privateReferral, referralUrl, referrals, resolveDispute, setStatus, submitReferral, transitionPayout, transitionReferral, updateOwnProfile, updateProfile };
