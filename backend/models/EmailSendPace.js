const mongoose = require("mongoose");

// Backs the hourly deliverability rate cap in services/email.js. Deliberately
// NOT workspace-scoped and NOT using workspacePlugin — this protects the one
// shared sending domain's reputation across the whole platform, not a single
// tenant's own limit. One document per real send; the TTL index expires each
// document an hour after it's written, so counting current documents IS the
// rolling-window count, with no separate cleanup job needed.
//
// Confirmed live: the previous in-memory-array version of this cap reset to
// zero on every server restart (every Manual Deploy on Render, and any
// platform-triggered restart), which is invisible during quiet periods but
// lets an active campaign send far past its intended cap when several
// deploys happen while it's running — confirmed against Outreach.sentAt
// timestamps: hourly sends of 166 and 192 against an intended ~100/hour cap,
// exactly because deploys during that window kept resetting the counter.
const emailSendPaceSchema = new mongoose.Schema({
  sentAt: { type: Date, default: Date.now },
});

emailSendPaceSchema.index({ sentAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model("EmailSendPace", emailSendPaceSchema);
