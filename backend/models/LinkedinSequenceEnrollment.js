const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// One contact's progress through a LinkedinSequence. The runner
// (services/linkedinSequenceRunnerService.js) leases due enrollments the
// same way services/researchMonitorService.js leases due monitors, so
// multiple app instances never send the same step twice.
const historyEntrySchema = new mongoose.Schema(
  {
    stepIndex: { type: Number, required: true },
    type: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
    result: { type: String, default: "" },
    detail: { type: String, default: "", maxlength: 2000 },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: "LinkedinSequence", required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
    status: {
      type: String,
      enum: [
        "pending",
        "connection_sent",
        "connection_accepted",
        "connection_declined",
        "in_progress",
        "awaiting_reply",
        "meeting_booked",
        "stopped",
        "failed",
        "completed",
      ],
      default: "pending",
      index: true,
    },
    currentStepIndex: { type: Number, default: 0 },
    // When this enrollment next becomes eligible for the runner to act on it
    // (e.g. a step's delayMinutes, or a re-check interval while waiting for a
    // connection to be accepted). Null means it needs immediate attention.
    nextActionDueAt: { type: Date, default: () => new Date(), index: true },
    leaseOwner: { type: String, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    unipileProviderId: { type: String, default: "" },
    unipileAccountId: { type: String, default: "" },
    unipileChatId: { type: String, default: "" },
    stoppedReason: { type: String, default: "" },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

schema.index({ workspaceId: 1, sequenceId: 1, contactId: 1 }, { unique: true });
schema.index({ status: 1, nextActionDueAt: 1, leaseExpiresAt: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("LinkedinSequenceEnrollment", schema);
