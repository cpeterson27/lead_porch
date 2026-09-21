const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const campaignTemplateVersionSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    version: { type: Number, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    body: { type: String, required: true, maxlength: 300000 },
    designJson: { type: mongoose.Schema.Types.Mixed, default: null },
    callToAction: { type: String, default: "", trim: true, maxlength: 120 },
    callToActionUrl: { type: String, default: "", trim: true, maxlength: 1000 },
    hideCallToAction: { type: Boolean, default: false },
    additionalButtons: [{
      label: { type: String, required: true, trim: true, maxlength: 120 },
      url: { type: String, required: true, trim: true, maxlength: 1000 },
    }],
    topic: {
      type: String,
      enum: ["event_invitations", "program_offers", "educational_newsletter"],
      required: true,
    },
    approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    approvedAt: { type: Date, default: Date.now, required: true },
  },
  { timestamps: true },
);

campaignTemplateVersionSchema.index({ workspaceId: 1, campaignId: 1, version: 1 }, { unique: true });
campaignTemplateVersionSchema.plugin(workspacePlugin);

module.exports = mongoose.model("CampaignTemplateVersion", campaignTemplateVersionSchema);
