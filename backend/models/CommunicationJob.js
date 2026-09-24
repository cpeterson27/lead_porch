const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  kind: { type: String, enum: ["campaign_message", "session_reminder", "onboarding", "payment_reminder"], required: true, index: true },
  channel: { type: String, enum: ["email", "sms"], required: true, index: true },
  purpose: { type: String, enum: ["transactional", "marketing"], required: true },
  status: { type: String, enum: ["pending", "processing", "sent", "blocked", "failed", "cancelled"], default: "pending", index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "MarketingCampaign", default: null, index: true },
  coachingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingSession", default: null, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", default: null, index: true },
  scheduledFor: { type: Date, required: true, index: true },
  idempotencyKey: { type: String, required: true, maxlength: 500 },
  sessionStartsAtSnapshot: { type: Date, default: null },
  content: { subject: { type: String, default: "", maxlength: 500 }, previewText: { type: String, default: "", maxlength: 500 }, body: { type: String, required: true, maxlength: 50000 }, html: { type: String, default: "", maxlength: 200000 } },
  attempts: { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  blockReason: { type: String, default: "", maxlength: 1000 },
  providerMessageId: { type: String, default: "", maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: "communication_jobs" });

schema.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, scheduledFor: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("CommunicationJob", schema);
