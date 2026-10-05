const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// A step-based, timed email nurture sequence — the email equivalent of
// models/LinkedinSequence.js, which already does this for LinkedIn. Each
// step is sent as a real Outreach record under this sequence's campaignId,
// reusing that campaign's sender identity, compliance footer, and
// suppression/unsubscribe handling rather than reimplementing any of it.
const stepSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    // Plain text with {{firstName}}/{{lastName}}/{{company}} tokens — kept
    // deliberately simple (no AI drafting, no rich token set) for a first
    // version; services/email.js's own HTML wrapping/compliance footer
    // still applies on send exactly as it does for a one-shot campaign.
    body: { type: String, required: true, maxlength: 20000 },
    // Days after enrollment (step 0) or after the previous step actually
    // sent (step 1+) before this step becomes eligible to send.
    delayDays: { type: Number, default: 0, min: 0, max: 365 },
  },
  { _id: true },
);

const schema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    description: { type: String, default: "", maxlength: 2000 },
    status: { type: String, enum: ["draft", "active", "paused", "archived"], default: "draft", index: true },
    // Reuses an existing Campaign for sender identity, compliance footer,
    // and emailTopic/deliveryPurpose classification — never duplicated here.
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    steps: {
      type: [stepSchema],
      validate: { validator: (steps) => steps.length > 0, message: "A sequence needs at least one step" },
    },
    // Off by default, matching the LinkedIn sequence's conservative default:
    // a contact who replies to any step stops receiving further steps
    // automatically, so a nurture sequence can never talk over a real
    // conversation that's already started.
    stopOnReply: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

schema.index({ workspaceId: 1, status: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("EmailSequence", schema);
