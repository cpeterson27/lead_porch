const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const inAppNotificationSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  monitorId: { type: mongoose.Schema.Types.ObjectId, ref: "ResearchMonitor", default: null },
  signalId: { type: mongoose.Schema.Types.ObjectId, ref: "IntentSignal", default: null },
  type: { type: String, enum: ["social_authorization", "social_automation_attention", "social_automation_triggered", "high_scoring_lead", "published_email", "monitor_complete", "source_failure", "qualified_lead", "closer_assignment", "closer_follow_up", "privacy_request", "ambassador_profile_complete", "ambassador_welcome_ready", "ambassador_reminder", "coaching_application"], required: true },
  eventKey: { type: String, default: "", maxlength: 500 },
  privacyRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "PrivacyRequest", default: null, index: true },
  actionUrl: { type: String, default: "", maxlength: 500 },
  title: { type: String, required: true },
  message: { type: String, required: true },
  readAt: { type: Date, default: null },
}, { timestamps: true });

inAppNotificationSchema.index({ workspaceId: 1, readAt: 1, createdAt: -1 });
inAppNotificationSchema.index({ workspaceId: 1, userId: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: "string", $gt: "" } } });
inAppNotificationSchema.plugin(workspacePlugin);
module.exports = mongoose.model("InAppNotification", inAppNotificationSchema);
