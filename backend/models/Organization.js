const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const organizationSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    // -------------------------------------------------------------------------
    // Identity — domain is the preferred deduplication key.
    // -------------------------------------------------------------------------

    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Stable workspace-local key used to connect legacy contact company text
    // without merging distinct companies through fuzzy matching.
    normalizedName: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },

    domain: {
      type: String,
      required: false,
      // Leave unknown domains absent. The legacy sparse unique index permits
      // many missing values but only one explicit null value.
      default: undefined,
      lowercase: true,
      trim: true,
    },

    source: {
      type: String,
      enum: ["manual", "import", "eventbrite", "meetup", "public_web", "vertex_grounding", "legacy"],
      required: true,
      default: "manual",
    },

    // -------------------------------------------------------------------------
    // Optional source evidence and identifiers for future refreshes.
    // -------------------------------------------------------------------------

    externalSources: { type: mongoose.Schema.Types.Mixed, default: {} },

    // -------------------------------------------------------------------------
    // Company intelligence — populated from organizations/enrich.
    // -------------------------------------------------------------------------

    website: {
      type: String,
      default: "",
      trim: true,
    },

    industry: {
      type: String,
      default: "",
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    employeeCount: {
      type: Number,
      default: null,
    },

    location: {
      type: String,
      default: "",
    },

    linkedinUrl: {
      type: String,
      default: "",
    },

    founded: {
      type: Number,
      default: null,
    },

    phone: {
      type: String,
      default: "",
    },

    keywords: {
      type: [String],
      default: [],
    },

    locationCount: { type: Number, default: null, min: 0 },
    rating: { type: Number, default: null, min: 0, max: 5 },
    reviewCount: { type: Number, default: null, min: 0 },
    researchEvidence: [{
      sourceType: { type: String, default: "" },
      sourceUrl: { type: String, default: "" },
      field: { type: String, default: "" },
      observedValue: { type: String, default: "" },
      observedAt: { type: Date, default: null },
    }],
    lastResearchVerifiedAt: { type: Date, default: null },
    decisionMakers: [{
      name: { type: String, default: "" },
      title: { type: String, default: "" },
      linkedinUrl: { type: String, default: "" },
      email: { type: String, default: "", lowercase: true, trim: true },
      emailStatus: { type: String, enum: ["unknown", "published_unverified", "verified", "invalid"], default: "unknown" },
      evidenceUrl: { type: String, default: "" },
      observedAt: { type: Date, default: null },
    }],

    // -------------------------------------------------------------------------
    // Audience intelligence — scored by Growth Operator.
    // audienceScore: 0–100 composite fit score.
    // audienceTier:  human-readable priority tier derived from score.
    // scoreReasons:  plain-language explanations for the score.
    // -------------------------------------------------------------------------

    audienceScore: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 100,
    },

    audienceTier: {
      type: String,
      enum: ["high", "medium", "low", "unscored"],
      required: true,
      default: "unscored",
    },

    scoreReasons: {
      type: [String],
      default: [],
      // Example values:
      // "Real estate industry"
      // "Multifamily keyword match"
      // "Target employee range (5–500)"
    },

    // -------------------------------------------------------------------------
    // Provenance — when and how this org was discovered and last updated.
    // -------------------------------------------------------------------------

    discoveredAt: {
      type: Date,
      default: Date.now,
    },

    // Growth Operator-level enrichment timestamp — set when Growth Operator processes and
    // scores this org, regardless of which external source was used.
    enrichedAt: {
      type: Date,
      default: null,
    },

    // -------------------------------------------------------------------------
    // Organization priority and action readiness.
    // Priority is different from audienceScore:
    // - audienceScore: "How well does this org match the audience?"
    // - priorityScore: "How important should Growth Operator consider this org right now?"
    // -------------------------------------------------------------------------

    priorityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    priorityTier: {
      type: String,
      enum: ["hot", "warm", "cold"],
      default: "cold",
    },

    priorityReasons: {
      type: [String],
      default: [],
      // Example values:
      // "High audience fit score (90/100)"
      // "Real estate industry match"
      // "Strong multifamily keyword overlap"
      // "Recently discovered (2 days ago)"
    },

    // Breakdown of signals used to calculate priority
    prioritySignals: {
      audienceFit: { type: Number, default: 0, min: 0, max: 40 },
      industryMatch: { type: Number, default: 0, min: 0, max: 15 },
      companySize: { type: Number, default: 0, min: 0, max: 15 },
      keywordMatch: { type: Number, default: 0, min: 0, max: 10 },
      dataQuality: { type: Number, default: 0, min: 0, max: 10 },
      recency: { type: Number, default: 0, min: 0, max: 10 },
    },

    // Timestamp when priority was last calculated (triggers recalc if stale)
    priorityCalculatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // Adds createdAt and updatedAt automatically.
    timestamps: true,
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Domain dedup — sparse so that domain-less orgs (manual, Meetup, etc.)
// do not collide on null. Only one record allowed per unique domain value.
organizationSchema.index({ domain: 1 }, { unique: true, sparse: true });
organizationSchema.index(
  { workspaceId: 1, normalizedName: 1 },
  { unique: true, partialFilterExpression: { normalizedName: { $type: "string", $gt: "" } } },
);


// Audience filtering — Growth Operator queries orgs by tier for outreach targeting.
organizationSchema.index({ audienceTier: 1 });

// Score sorting — for ranked org lists in discovery results.
organizationSchema.index({ audienceScore: -1 });

// Source + tier composite — for filtered discovery queries per provider.
organizationSchema.index({ source: 1, audienceTier: 1 });

// Priority sorting — for prioritized org lists and filtering.
organizationSchema.index({ priorityScore: -1 });

// Priority tier filtering — for hot/warm/cold views.
organizationSchema.index({ priorityTier: 1 });

// Priority recency — identify stale priorities that need recalculation.
organizationSchema.index({ priorityCalculatedAt: -1 });

organizationSchema.pre("validate", function normalizeRetiredSource() {
  const activeSources = new Set(["manual", "import", "eventbrite", "meetup", "public_web", "legacy"]);
  if (!activeSources.has(this.source)) this.source = "legacy";
});

// Composite: priority + audience tier — for combined views.
organizationSchema.index({ priorityTier: 1, audienceTier: 1 });

organizationSchema.plugin(workspacePlugin);
module.exports = mongoose.model("Organization", organizationSchema);
