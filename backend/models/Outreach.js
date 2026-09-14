const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");


const outreachSchema = new mongoose.Schema(
  {

    // ======================================
    // CAMPAIGN RELATIONSHIP
    // ======================================

    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },


    // ======================================
    // CONTACT RELATIONSHIP
    // ======================================

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },

    retryOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outreach",
      default: null,
      index: true,
    },


    // ======================================
    // CONTACT SNAPSHOT
    // Keeps outreach history intact
    // ======================================

    organization: {
      type: String,
      required: true,
      trim: true,
    },


    contactName: {
      type: String,
      default: "",
      trim: true,
    },


    contactEmail: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      index: true,
    },


    contactRole: {
      type: String,
      default: "",
      trim: true,
    },


    // ======================================
    // GENERATED OUTREACH CONTENT
    // ======================================

    reason: {
      type: String,
      default: "",
      trim: true,
    },


    emailDraft: {
      type: String,
      default: "",
    },


    htmlBody: {
      type: String,
      default: "",
    },


    eventLink: {
      type: String,
      default: "",
    },


    flyerUrl: {
      type: String,
      default: "",
    },


    subject: {
      type: String,
      default: "",
      trim: true,
    },
    templateVersion: { type: Number, default: 0 },
    templateAudienceKey: { type: String, default: "general" },
    templateAudienceLabel: { type: String, default: "All campaign contacts" },
    emailTopic: {
      type: String,
      enum: ["event_invitations", "program_offers", "educational_newsletter"],
      default: "event_invitations",
    },


    // ======================================
    // OUTREACH LIFECYCLE
    //
    // pending  = Generated waiting approval
    // approved = Ready to send
    // sent     = Successfully delivered
    // replied  = Contact responded
    // failed   = Sending failed
    // ======================================

    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "sent",
        "replied",
        "failed",
      ],
      default: "pending",
      index: true,
    },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    complainedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastEmailEventAt: { type: Date, default: null },
    deliveryStatus: {
      type: String,
      enum: ["", "accepted", "delivered", "delayed", "bounced", "failed", "complained", "suppressed"],
      default: "",
      index: true,
    },


    // ======================================
    // EMAIL TRACKING
    // ======================================

    sentAt: {
      type: Date,
      default: null,
    },


    messageId: {
      type: String,
      default: "",
      trim: true,
    },


    // ======================================
    // REPLY TRACKING
    // ======================================

    repliedAt: {
      type: Date,
      default: null,
    },


    replyText: {
      type: String,
      default: "",
    },


    aiReplyDraft: {
      type: String,
      default: "",
    },
    replyCategory: {
      type: String,
      enum: ["", "interested", "partnership", "not_now", "not_interested", "unsubscribe", "out_of_office", "needs_review"],
      default: "",
      index: true,
    },
    replyUrgency: {
      type: String,
      enum: ["", "low", "medium", "high"],
      default: "",
    },


    // ======================================
    // ERROR HANDLING
    // ======================================

    errorMessage: {
      type: String,
      default: "",
    },
    bounceType: { type: String, default: "" },
    bounceSubType: { type: String, default: "" },
    bounceMessage: { type: String, default: "" },


  },
  {
    timestamps: true,
  }
);



// ======================================
// INDEXES
// ======================================


// Prevent duplicate outreach
// Same campaign + same email
outreachSchema.index(
  {
    workspaceId: 1,
    campaignId: 1,
    contactEmail: 1,
  },
  {
    unique: true,
  }
);


// Campaign dashboard filtering
outreachSchema.index({
  campaignId: 1,
  status: 1,
});


// Sent history sorting
outreachSchema.index({
  status: 1,
  sentAt: -1,
});

// Resend message lookup
outreachSchema.index(
  {
    messageId: 1,
  },
  {
    sparse: true,
  }
);


// Reply inbox sorting
outreachSchema.index({
  status: 1,
  repliedAt: -1,
});



outreachSchema.plugin(workspacePlugin);
module.exports = mongoose.model(
  "Outreach",
  outreachSchema
);
