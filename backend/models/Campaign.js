const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");


const campaignSchema = new mongoose.Schema(
{
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Event",
    required: function() { return this.campaignKind !== "program"; },
    index: true,
  },


  name: {
    type: String,
    required: true,
    trim: true,
  },


  type: {
    type: String,
    default: "event",
  },
  campaignKind: { type: String, enum: ["event", "program"], default: "event", index: true },
  programName: { type: String, default: "" },
  templateKey: { type: String, default: "event_investor" },
  brand: {
    logoUrl: { type: String, default: "" },
    flyerUrl: { type: String, default: "" },
    websiteUrl: { type: String, default: "" },
    accentColor: { type: String, default: "#173f36" },
  },


  audience: [
    {
      type: String,
    },
  ],
  audienceMatch: {
    matchedCount: { type: Number, default: 0 },
    lastMatchedAt: { type: Date, default: null },
  },


  content: {

    subject: {
      type: String,
      default: "Event Campaign",
    },


    body: {
      type: String,
      default: "Campaign created for event promotion.",
    },


    callToAction: {
      type: String,
      default: "Register Now",
    },


    callToActionUrl: {
      type: String,
      default: "",
    },

  },
  emailTemplate: {
    subject: { type: String, default: "", trim: true, maxlength: 300 },
    body: { type: String, default: "", maxlength: 300000 },
    // The Unlayer editor's design JSON for this body, so re-opening the
    // template loads the same drag-and-drop layout instead of just its
    // rendered HTML. Null for older campaigns saved before this editor.
    designJson: { type: mongoose.Schema.Types.Mixed, default: null },
    callToAction: { type: String, default: "", trim: true, maxlength: 120 },
    callToActionUrl: { type: String, default: "", trim: true, maxlength: 1000 },
    additionalButtons: [{
      label: { type: String, required: true, trim: true, maxlength: 120 },
      url: { type: String, required: true, trim: true, maxlength: 1000 },
    }],
    topic: {
      type: String,
      enum: ["event_invitations", "program_offers", "educational_newsletter"],
      default: function() { return this.campaignKind === "program" ? "program_offers" : "event_invitations"; },
    },
    status: { type: String, enum: ["draft", "approved"], default: "draft" },
    currentVersion: { type: Number, default: 0 },
    approvedAt: { type: Date, default: null },
  },
  emailAudienceTemplates: { type: mongoose.Schema.Types.Mixed, default: {} },
  activeAudienceTemplateKey: { type: String, default: "general" },

  registrationLinks: {
    eventbrite: {
      enabled: { type: Boolean, default: false },
      url: { type: String, default: "" },
      label: { type: String, default: "Register on Eventbrite" },
    },
    meetup: {
      enabled: { type: Boolean, default: false },
      url: { type: String, default: "" },
      label: { type: String, default: "View on Meetup" },
      eventId: { type: String, default: "" },
    },
  },


  metrics: {

    sent: {
      type: Number,
      default: 0,
    },

    delivered: {
      type: Number,
      default: 0,
    },

    opened: {
      type: Number,
      default: 0,
    },

    clicked: {
      type: Number,
      default: 0,
    },

    converted: {
      type: Number,
      default: 0,
    },
    bounced: {
      type: Number,
      default: 0,
    },
    complained: {
      type: Number,
      default: 0,
    },
    replied: {
      type: Number,
      default: 0,
    },

  },


  startDate: Date,


  ticketPrice: Number,


  ticketGoal: Number,


  ticketsSold: {
    type: Number,
    default: 0,
  },


  status: {
    type: String,
    enum:[
      "draft",
      "active",
      "completed",
      "paused",
    ],
    default:"active",
  },


},
{
 timestamps:true,
 collection:"campaigns",
}
);


campaignSchema.plugin(workspacePlugin);
module.exports = mongoose.model(
 "Campaign",
 campaignSchema
);
