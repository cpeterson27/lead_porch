const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// One contact's progress through an EmailSequence — the email equivalent of
// models/LinkedinSequenceEnrollment.js. The runner
// (services/emailSequenceService.js's runDueEmailSequenceEnrollments) leases
// due enrollments the same way services/researchMonitorService.js leases
// due monitors, so multiple app instances never send the same step twice.
const historyEntrySchema = new mongoose.Schema(
  {
    stepIndex: { type: Number, required: true },
    outreachId: { type: mongoose.Schema.Types.ObjectId, ref: "Outreach", default: null },
    occurredAt: { type: Date, default: Date.now },
    result: { type: String, default: "" },
    detail: { type: String, default: "", maxlength: 500 },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailSequence", required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
    status: {
      type: String,
      enum: ["active", "paused", "completed", "stopped", "failed"],
      default: "active",
      index: true,
    },
    // -1 = no step sent yet; the runner treats this as "step 0 is next".
    currentStepIndex: { type: Number, default: -1 },
    nextActionDueAt: { type: Date, default: () => new Date(), index: true },
    leaseOwner: { type: String, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    stoppedReason: { type: String, default: "" },
    history: { type: [historyEntrySchema], default: [] },
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

schema.index({ workspaceId: 1, sequenceId: 1, contactId: 1 }, { unique: true });
schema.index({ status: 1, nextActionDueAt: 1, leaseExpiresAt: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("EmailSequenceEnrollment", schema);
