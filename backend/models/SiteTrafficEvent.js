const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
  eventId: { type: String, required: true, maxlength: 160 },
  sessionId: { type: String, required: true, maxlength: 80 },
  kind: { type: String, enum: ["page_view", "application_submitted", "discovery_call_booked", "guide_requested"], required: true },
  source: { type: String, required: true, maxlength: 30 },
  sourceGroup: { type: String, enum: ["ai", "other"], required: true },
  evidence: { type: String, enum: ["utm", "referrer", "unknown"], required: true },
  landingPath: { type: String, required: true, maxlength: 300 },
  pagePath: { type: String, required: true, maxlength: 300 },
  referrerHost: { type: String, default: "", maxlength: 253 },
  programId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null },
  createdAt: { type: Date, default: Date.now, required: true },
}, { collection: "site_traffic_events" });
schema.index({ workspaceId: 1, eventId: 1 }, { unique: true });
schema.index({ workspaceId: 1, sourceGroup: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("SiteTrafficEvent", schema);
