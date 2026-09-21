const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const audienceSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    // -------------------------------------------------------------------------
    // Core identity
    // -------------------------------------------------------------------------

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      required: true,
      default: "draft",
    },

    // -------------------------------------------------------------------------
    // Source — how this audience was created
    // -------------------------------------------------------------------------

    source: {
      type: String,
      enum: ["manual", "ai", "import"],
      required: true,
      default: "manual",
    },

    // -------------------------------------------------------------------------
    // Discovery criteria used by Growth Operator's organization research engine
    // and used to filter/score saved organizations.
    // -------------------------------------------------------------------------

    criteria: {
      // Business keywords (e.g. "multifamily", "real estate")
      keywords: {
        type: [String],
        default: [],
      },

      // Industry filters (e.g. "real estate", "real estate investment trust")
      industries: {
        type: [String],
        default: [],
      },

      // Geographic filters (e.g. "United States", "California")
      locations: {
        type: [String],
        default: [],
      },

      // Company size filter — both optional so any size is acceptable if not set
      employeeRange: {
        min: { type: Number, default: null },
        max: { type: Number, default: null },
      },

      revenueRange: {
        min: { type: Number, default: null },
        max: { type: Number, default: null },
      },

      fundingRange: {
        min: { type: Number, default: null },
        max: { type: Number, default: null },
      },

      technologiesAny: {
        type: [String],
        default: [],
      },

      // Only organizations scoring at or above this threshold are linked to this audience
      minimumScore: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },

      // If set, only link organizations with this tier or better (high > medium > low > unscored)
      // null = accept all tiers
      targetTier: {
        type: String,
        enum: ["high", "medium", "low", "unscored", null],
        default: null,
      },
    },

    // -------------------------------------------------------------------------
    // Relationships — soft references, not foreign key constraints
    // -------------------------------------------------------------------------

    // Organization ObjectIds discovered/linked to this audience.
    // Soft reference only — no cascade delete, no validation constraint.
    organizationIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },

    // -------------------------------------------------------------------------
    // Discovery tracking
    // -------------------------------------------------------------------------

    lastDiscoveredAt: {
      type: Date,
      default: null,
    },

    totalOrgs: {
      type: Number,
      default: 0,
    },

    // -------------------------------------------------------------------------
    // Optional daily auto-rerun of this saved search — see
    // services/researchScheduledSearchRunner.js. Reuses the plan/question
    // from this audience's most recent research job every time it fires, so
    // newly matching organizations keep getting added to the same saved
    // audience without anyone re-running it by hand. lastRunDateKey is a
    // "YYYY-MM-DD" string computed in `timezone`, so the poller (which may
    // tick many times a day) only ever runs it once per calendar day.
    scheduledSearch: {
      enabled: { type: Boolean, default: false },
      time: { type: String, default: "08:00" },
      timezone: { type: String, default: "America/New_York" },
      days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
      lastRunAt: { type: Date, default: null },
      lastRunDateKey: { type: String, default: "" },
    },
  },
  {
    // Adds createdAt and updatedAt automatically
    timestamps: true,
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Query by status for discovery workflows (active audiences)
audienceSchema.index({ status: 1 });

// Query by source for reporting/filtering
audienceSchema.index({ source: 1 });

// Most recent audiences for discovery UI
audienceSchema.index({ createdAt: -1 });

// Last discovered, for re-trigger workflows
audienceSchema.index({ lastDiscoveredAt: -1 });

// Composite: status + source for common queries
audienceSchema.index({ status: 1, source: 1 });

// Partial index: only active audiences
audienceSchema.index(
  { name: 1 },
  { partialFilterExpression: { status: "active" } },
);

audienceSchema.plugin(workspacePlugin);
module.exports = mongoose.model("Audience", audienceSchema);
