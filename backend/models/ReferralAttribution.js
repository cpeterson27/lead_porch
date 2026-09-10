const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
  promoterType: { type: String, enum: ["coach", "ambassador"], default: "coach", index: true },
  coachProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachProfile", default: null, index: true },
  coachUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  ambassadorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "AmbassadorProfile", default: null, index: true },
  ambassadorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  referralCode: { type: String, required: true, trim: true, lowercase: true }, source: { type: String, default: "manual", trim: true, maxlength: 80 },
  state: { type: String, enum: ["referred", "applied", "qualified", "enrolled", "converted", "cancelled", "refunded"], default: "referred", index: true },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingApplication", default: null, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", default: null, index: true },
  attributedAt: { type: Date, default: Date.now, required: true }, correctedAt: { type: Date, default: null },
  correctionReason: { type: String, default: "", trim: true, maxlength: 2000 },
  previousCoachProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachProfile", default: null },
  previousAmbassadorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "AmbassadorProfile", default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  consent: { given: { type: Boolean, default: false }, source: { type: String, default: "", trim: true, maxlength: 200 }, capturedAt: { type: Date, default: null } },
  // Follow-up notes are the promoter's OWN reminders on their own referral —
  // never internal sales notes. Capped to keep the document bounded.
  followUpNotes: {
    type: [{
      note: { type: String, required: true, trim: true, maxlength: 2000 },
      reminderAt: { type: Date, default: null },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      createdAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  dispute: {
    status: { type: String, enum: ["none", "open", "resolved", "dismissed"], default: "none", index: true },
    reason: { type: String, default: "", trim: true, maxlength: 2000 },
    filedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    filedAt: { type: Date, default: null },
    resolution: { type: String, default: "", trim: true, maxlength: 2000 },
    resolvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
}, { timestamps: true, collection: "referral_attributions" });

schema.pre("validate", function capFollowUpNotes() {
  if (this.followUpNotes.length > 50) this.followUpNotes = this.followUpNotes.slice(-50);
});
schema.index({ workspaceId: 1, contactId: 1 }, { unique: true }); schema.plugin(workspacePlugin);
module.exports = mongoose.model("ReferralAttribution", schema);
