// Regression coverage for the "My Referred Leads CRM" upgrade: ambassador
// self-submitted referrals (with required consent), safe duplicate handling
// that never discloses another promoter's confidential record, follow-up
// notes/reminders, and attribution dispute filing/resolution. Real MongoDB,
// no mocking — this exercises the real contactService + referralCommissionService wiring.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const ambassadorService = require("./services/ambassadorService");
const AmbassadorProfile = require("./models/AmbassadorProfile");
const ReferralAttribution = require("./models/ReferralAttribution");
const Contact = require("./models/Contact");
const CrmActivity = require("./models/CrmActivity");
const User = require("./models/User");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const userA = await User.create({ name: "Ambassador A", email: `amb-a-${Date.now()}@example.test`, passwordHash: "x" });
  const userB = await User.create({ name: "Ambassador B", email: `amb-b-${Date.now()}@example.test`, passwordHash: "x" });
  const profileA = await AmbassadorProfile.create({ workspaceId, userId: userA._id, displayName: "Ambassador A", status: "active", referralCode: `code-a-${Date.now()}`, referralSlug: `code-a-${Date.now()}-slug` });
  const profileB = await AmbassadorProfile.create({ workspaceId, userId: userB._id, displayName: "Ambassador B", status: "active", referralCode: `code-b-${Date.now()}`, referralSlug: `code-b-${Date.now()}-slug` });

  try {
   await runWithWorkspace(workspaceId, async () => {
    // Consent is mandatory.
    await assert.rejects(
      () => ambassadorService.submitReferral({ workspaceId, ambassadorProfileId: profileA._id, actorUserId: userA._id, name: "New Lead", email: "lead-1@example.test", consentGiven: false }),
      (error) => error.code === "REFERRAL_CONSENT_REQUIRED",
    );

    // A real submission creates a Contact and attributes it to the submitting ambassador.
    const first = await ambassadorService.submitReferral({ workspaceId, ambassadorProfileId: profileA._id, actorUserId: userA._id, name: "New Lead", email: "lead-1@example.test", phone: "555-0100", source: "event", consentGiven: true });
    assert.equal(first.duplicate, false);
    assert.equal(first.referral.referredPerson, "New L.");
    assert.equal(first.referral.consent.given, true);
    const contact = await Contact.findOne({ workspaceId, email: "lead-1@example.test" }).lean();
    assert.ok(contact, "submitting a referral must create a real CRM contact");

    // Re-submitting the SAME ambassador's own referral returns their own safe record, not an error.
    const resubmitSameAmbassador = await ambassadorService.submitReferral({ workspaceId, ambassadorProfileId: profileA._id, actorUserId: userA._id, name: "New Lead", email: "lead-1@example.test", consentGiven: true });
    assert.equal(resubmitSameAmbassador.duplicate, true);
    assert.equal(resubmitSameAmbassador.referral.referredPerson, "New L.");

    // A DIFFERENT ambassador submitting the same email must be told it's a
    // duplicate WITHOUT ever seeing ambassador A's confidential record.
    const crossAmbassador = await ambassadorService.submitReferral({ workspaceId, ambassadorProfileId: profileB._id, actorUserId: userB._id, name: "New Lead", email: "lead-1@example.test", consentGiven: true });
    assert.equal(crossAmbassador.duplicate, true);
    assert.equal(crossAmbassador.referral, null, "a duplicate belonging to another promoter must never disclose that promoter's record");
    assert.ok(crossAmbassador.reason);

    const attribution = await ReferralAttribution.findOne({ workspaceId, ambassadorProfileId: profileA._id }).lean();
    assert.equal(String(attribution.ambassadorProfileId), String(profileA._id), "the duplicate submission must never have reassigned attribution to ambassador B");

    // Follow-up notes are scoped to the submitting ambassador's own referral.
    const note = await ambassadorService.addFollowUpNote({ workspaceId, ambassadorProfileId: profileA._id, attributionId: attribution._id, userId: userA._id, note: "Called, will follow up next week", reminderAt: "2027-01-01" });
    assert.equal(note.note, "Called, will follow up next week");
    await assert.rejects(
      () => ambassadorService.addFollowUpNote({ workspaceId, ambassadorProfileId: profileB._id, attributionId: attribution._id, userId: userB._id, note: "Should fail" }),
      (error) => error.code === "REFERRAL_NOT_FOUND",
      "ambassador B must never be able to add a note to ambassador A's referral",
    );
    const withNotes = await ambassadorService.ownReferrals({ workspaceId, ambassadorProfileId: profileA._id });
    assert.equal(withNotes[0].followUpNotes.length, 1);

    // Dispute filing and admin resolution.
    const dispute = await ambassadorService.fileDispute({ workspaceId, ambassadorProfileId: profileA._id, attributionId: attribution._id, userId: userA._id, reason: "This should be my referral, not a duplicate" });
    assert.equal(dispute.status, "open");
    await assert.rejects(
      () => ambassadorService.fileDispute({ workspaceId, ambassadorProfileId: profileA._id, attributionId: attribution._id, userId: userA._id, reason: "Again" }),
      (error) => error.code === "DISPUTE_ALREADY_OPEN",
    );
    const resolved = await ambassadorService.resolveDispute({ workspaceId, attributionId: attribution._id, actorUserId: userA._id, status: "resolved", resolution: "Confirmed correct attribution" });
    assert.equal(resolved.dispute.status, "resolved");
    assert.equal(resolved.dispute.resolution, "Confirmed correct attribution");
    const disputeActivity = await CrmActivity.findOne({ workspaceId, "metadata.eventType": "ambassador.referral.dispute_filed" }).lean();
    assert.ok(disputeActivity, "filing a dispute must leave an audit trail");

    console.log("Ambassador Referred Leads CRM: consent-required submission, cross-ambassador duplicate non-disclosure, scoped follow-up notes, and dispute filing/resolution all passed.");
   });
  } finally {
    await ReferralAttribution.deleteMany({ workspaceId });
    await AmbassadorProfile.deleteMany({ workspaceId });
    await Contact.deleteMany({ workspaceId });
    await CrmActivity.deleteMany({ workspaceId });
    await User.deleteMany({ _id: { $in: [userA._id, userB._id] } });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
