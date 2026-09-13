/**
 * Contact Model
 *
 * One person = one Contact record
 *
 * Supports:
 * - Monday CRM
 * - imports and Growth Operator research
 * - Eventbrite
 * - Manual imports
 * - Future integrations
 */

const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");


const contactSchema = new mongoose.Schema(
  {

    // -------------------------------------------------------------------------
    // Basic identity
    // -------------------------------------------------------------------------

    name: {
      type: String,
      required: true,
      trim: true,
    },


    firstName: {
      type: String,
      trim: true,
      default: "",
    },


    lastName: {
      type: String,
      trim: true,
      default: "",
    },


    email: {
      type: String,
      set: (value) => {
        const email = String(value || "").trim().toLowerCase();
        return email || undefined;
      },
    },


    company: {
      type: String,
      trim: true,
      default: "",
    },

    phone: { type: String, default: "", trim: true },
    notes: { type: String, default: "" },
    mondayItemId: { type: String, default: "", index: true },
    mondaySyncStatus: { type: String, default: "pending" },
    mondaySyncedAt: { type: Date, default: null },
    mondaySyncError: { type: String, default: "" },
    // Canonical contact fields. `additionalFields` is reserved for
    // unknown/custom export columns only.
    companyNameForEmails: { type: String, default: "" }, emailStatus: { type: String, default: "" }, primaryEmailSource: { type: String, default: "" }, primaryEmailVerificationSource: { type: String, default: "" }, emailConfidence: { type: String, default: "" }, primaryEmailCatchAllStatus: { type: String, default: "" }, primaryEmailLastVerifiedAt: { type: Date, default: null },
    seniority: { type: String, default: "" }, departments: { type: [String], default: [] }, subDepartments: { type: [String], default: [] }, contactOwner: { type: String, default: "" }, workDirectPhone: { type: String, default: "" }, homePhone: { type: String, default: "" }, mobilePhone: { type: String, default: "" }, corporatePhone: { type: String, default: "" }, otherPhone: { type: String, default: "" }, doNotCall: { type: Boolean, default: false }, stage: { type: String, default: "" }, lists: { type: [String], default: [] }, lastContacted: { type: Date, default: null }, accountOwner: { type: String, default: "" }, keywords: { type: [String], default: [] }, website: { type: String, default: "" }, companyLinkedinUrl: { type: String, default: "" }, facebookUrl: { type: String, default: "" }, twitterUrl: { type: String, default: "" }, companyAddress: { type: String, default: "" }, companyCity: { type: String, default: "" }, companyState: { type: String, default: "" }, companyCountry: { type: String, default: "" }, companyPhone: { type: String, default: "" }, technologies: { type: [String], default: [] }, annualRevenue: { type: Number, default: null }, totalFunding: { type: Number, default: null }, latestFunding: { type: String, default: "" }, latestFundingAmount: { type: Number, default: null }, lastRaisedAt: { type: Date, default: null }, subsidiaryOf: { type: String, default: "" }, subsidiaryOrganizationId: { type: String, default: "" }, emailSent: { type: Boolean, default: false }, emailOpen: { type: Boolean, default: false }, emailBounced: { type: Boolean, default: false }, replied: { type: Boolean, default: false }, demoed: { type: Boolean, default: false }, retailLocations: { type: Number, default: null }, sicCodes: { type: [String], default: [] }, naicsCodes: { type: [String], default: [] }, secondaryEmail: { type: String, default: "" }, secondaryEmailSource: { type: String, default: "" }, secondaryEmailStatus: { type: String, default: "" }, secondaryEmailVerificationSource: { type: String, default: "" }, tertiaryEmail: { type: String, default: "" }, tertiaryEmailSource: { type: String, default: "" }, tertiaryEmailStatus: { type: String, default: "" }, tertiaryEmailVerificationSource: { type: String, default: "" }, qualifyContact: { type: Boolean, default: false }, additionalFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    researchStatus: { type: String, enum: ["needs_research", "ready_for_review", "qualified"], default: "needs_research", index: true },
    paymentSummary: { planId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentPlan", default: null }, status: { type: String, default: "", maxlength: 40 }, lastTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentTransaction", default: null }, lastAmountMinor: { type: Number, default: null }, lastPaidAt: { type: Date, default: null } },
    missingFields: { type: [String], default: [] },
    lastResearchedAt: { type: Date, default: null },


    // -------------------------------------------------------------------------
    // Organization relationship
    // -------------------------------------------------------------------------

    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },


    // -------------------------------------------------------------------------
    // External source tracking
    //
    // Example:
    //
    // sources:
    // [
    //   "monday",
    //   "public_web"
    // ]
    //
    // externalIds:
    // {
    //   monday:"12605053520",
    //   public_web:"abc123"
    // }
    //
    // -------------------------------------------------------------------------

    sources: {
      type: [String],
      default: [],
    },


    externalIds: {
      type: Object,
      default: {},
    },

    sourceProvider: {
      type: String,
      index: true,
    },

    providerContactId: {
      type: String,
      index: true,
    },

    providerRecordId: {
      type: String,
    },

    linkedin: {
      type: String,
      default: "",
      trim: true,
    },

    title: { type: String, default: "", trim: true },
    industry: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
    employeeCount: { type: Number, default: null },
    importedAt: { type: Date, default: null },
    lastImportBatchId: { type: String, default: "", index: true },
    lastImportFileName: { type: String, default: "", trim: true },
    lastImportedAt: { type: Date, default: null },

    linkedinOutreach: {
      status: { type: String, enum: ["not_started", "drafted", "approved", "sent", "replied", "not_interested"], default: "not_started" },
      draft: { type: String, default: "", maxlength: 3000 },
      tone: { type: String, default: "warm_direct" },
      approvedAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      followUpAt: { type: Date, default: null },
      lastGeneratedAt: { type: Date, default: null },
      // Unipile's internal id for this person, resolved from their public
      // LinkedIn URL. Required to send a connection request or, later, a
      // chat message once one is accepted.
      unipileProviderId: { type: String, default: "" },
      // Which connected SocialConnection (linkedin_unipile) sent the request.
      unipileAccountId: { type: String, default: "" },
      connectionStatus: { type: String, enum: ["none", "pending", "accepted", "declined"], default: "none" },
    },

    campaignIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      index: true,
    }],
    // Optional per-campaign audience-template selection. When absent or set to
    // "auto", outreach generation continues to route from the contact's title.
    campaignTemplateOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },


    // -------------------------------------------------------------------------
    // CRM lifecycle
    //
    // lead:
    //   Newly discovered prospect
    //
    // contact:
    //   Active relationship
    //
    // customer:
    //   Paying customer
    //
    // partner:
    //   Referral / strategic partner
    // -------------------------------------------------------------------------

    type: {
      type: String,
      enum: [
        "lead",
        "contact",
        "customer",
        "partner",
      ],
      default: "lead",
      index: true,
    },


    // -------------------------------------------------------------------------
    // Categorization
    // -------------------------------------------------------------------------

    tags: {
      type: [String],
      default: [],
    },

    // Human-confirmed targeting categories. Operational tags such as
    // "manual" or "needs-enrichment" must never be treated as audience data.
    audienceProfiles: {
      type: [String],
      default: [],
    },


    // -------------------------------------------------------------------------
    // Record status
    // -------------------------------------------------------------------------

    status: {
      type: String,
      enum: [
        "active",
        "prospect",
        "rejected",
        "inactive",
        "unsubscribed",
        "invalid",
        "archived",
      ],
      default: "active",
      index: true,
    },
    emailPreferences: {
      marketingStatus: {
        type: String,
        enum: ["unknown", "subscribed", "unsubscribed"],
        default: "unknown",
        index: true,
      },
      consentSource: { type: String, default: "" },
      consentAt: { type: Date, default: null },
      unsubscribedAt: { type: Date, default: null },
      unsubscribeSource: { type: String, default: "" },
      topics: {
        eventInvitations: { type: Boolean, default: false },
        programOffers: { type: Boolean, default: false },
        educationalNewsletter: { type: Boolean, default: false },
      },
    },
    eventParticipations: [{
      provider: { type: String, enum: ["eventbrite"], default: "eventbrite" },
      eventId: { type: String, default: "", trim: true },
      attendeeId: { type: String, default: "", trim: true },
      status: { type: String, enum: ["registered", "attended", "cancelled"], default: "registered" },
      checkedInAt: { type: Date, default: null },
      updatedAt: { type: Date, default: Date.now },
    }],
    socialAttribution: {
      first: { provider: { type: String, default: "" }, campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null }, contentId: { type: String, default: "" }, contentBriefId: { type: mongoose.Schema.Types.ObjectId, ref: "ContentBrief", default: null }, automationId: { type: mongoose.Schema.Types.ObjectId, ref: "SocialAutomation", default: null }, occurredAt: { type: Date, default: null }, utm: { type: mongoose.Schema.Types.Mixed, default: {} } },
      latest: { provider: { type: String, default: "" }, campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null }, contentId: { type: String, default: "" }, contentBriefId: { type: mongoose.Schema.Types.ObjectId, ref: "ContentBrief", default: null }, automationId: { type: mongoose.Schema.Types.ObjectId, ref: "SocialAutomation", default: null }, occurredAt: { type: Date, default: null }, utm: { type: mongoose.Schema.Types.Mixed, default: {} } },
    },


  },
  {
    timestamps: true,
  }
);



// -----------------------------------------------------------------------------
// Indexes
// -----------------------------------------------------------------------------


// One person = one email
// Prevent duplicate people across integrations
contactSchema.index(
  {
    workspaceId: 1,
    email: 1,
  },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string" } },
  }
);


// Find contacts by source
contactSchema.index({
  sources: 1,
});


// Find external provider IDs
contactSchema.index({
  externalIds: 1,
});


// Organization filtering
contactSchema.index({
  organizationId: 1,
  status: 1,
});


// CRM filtering
contactSchema.index({
  type: 1,
  status: 1,
});

contactSchema.index(
  { workspaceId: 1, sourceProvider: 1, providerContactId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerContactId: { $type: "string" } },
  },
);

contactSchema.index({ linkedin: 1 }, { sparse: true });


// Recent contacts
contactSchema.index({
  createdAt: -1,
});


contactSchema.plugin(workspacePlugin);
module.exports = mongoose.model(
  "Contact",
  contactSchema
);
