const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// A step-based LinkedIn outreach campaign definition. An enrollment
// (models/LinkedinSequenceEnrollment.js) tracks one contact's progress
// through these steps. The first step is always effectively a connection
// request — LinkedIn requires an accepted connection (or an InMail credit,
// which this integration does not use) before any further message can send.
const stepSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["connection_request", "message"], required: true },
    // Minutes to wait after the previous step's outcome before this step is
    // eligible to run (e.g. wait 2 days after a connection is accepted
    // before sending the opener).
    delayMinutes: { type: Number, default: 0, min: 0, max: 43200 },
    messageTemplate: { type: String, default: "", maxlength: 3000 },
    // When true, a reply to this step's message is handed to the AI to draft
    // (and, only if the sequence's autonomousSendEnabled is also true, send)
    // an objection-handling / meeting-booking response.
    aiHandlesReplies: { type: Boolean, default: true },
  },
  { _id: true },
);

const schema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    description: { type: String, default: "", maxlength: 2000 },
    status: { type: String, enum: ["draft", "active", "paused", "archived"], default: "draft", index: true },
    steps: {
      type: [stepSchema],
      validate: {
        validator: (steps) => steps.length > 0 && steps[0].type === "connection_request",
        message: "A sequence must start with a connection_request step",
      },
    },
    // Per-connected-account daily send cap, enforced by the sequence runner
    // in addition to whatever limit the LinkedIn account itself allows
    // (LinkedIn caps around 80-100 invitations/day on paid accounts).
    dailyInvitationLimit: { type: Number, default: 20, min: 1, max: 100 },
    // A reply is always drafted by AI; it is only ever SENT without a human
    // click when this is explicitly turned on for the sequence. Defaults to
    // off — every new sequence starts human-reviewed.
    autonomousSendEnabled: { type: Boolean, default: false },
    calendarBookingUrl: { type: String, default: "", maxlength: 2000 },
    unipileAccountId: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

schema.index({ workspaceId: 1, status: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("LinkedinSequence", schema);
