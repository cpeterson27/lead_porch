const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const workspaceConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "primary", index: true },
    workspaceName: {
      type: String,
      default: "Lead Porch",
      trim: true,
      maxlength: 120,
    },
    moduleAccess: {
      coaching: { type: Boolean, default: false },
      ambassadors: { type: Boolean, default: false },
      publicProof: { type: Boolean, default: false },
    },
    legalBusinessName: {
      type: String,
      default: "Ellie's Coaching",
      trim: true,
      maxlength: 160,
    },
    postalAddress: { type: String, default: "", trim: true, maxlength: 300 },
    addressLine1: { type: String, default: "", trim: true, maxlength: 160 },
    addressLine2: { type: String, default: "", trim: true, maxlength: 160 },
    addressCity: { type: String, default: "", trim: true, maxlength: 100 },
    addressRegion: { type: String, default: "", trim: true, maxlength: 100 },
    addressPostalCode: { type: String, default: "", trim: true, maxlength: 30 },
    addressCountry: { type: String, default: "", trim: true, maxlength: 100 },
    websiteUrl: { type: String, default: "", trim: true, maxlength: 300 },
    organizationLogoUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 600,
    },
    invitationIdentity: {
      senderName: { type: String, default: "", trim: true, maxlength: 120 },
      senderEmail: {
        type: String,
        default: "",
        trim: true,
        lowercase: true,
        maxlength: 320,
      },
      replyToEmail: {
        type: String,
        default: "",
        trim: true,
        lowercase: true,
        maxlength: 320,
      },
    },
    branding: {
      logoUrl: { type: String, default: "", maxlength: 1000 },
      faviconUrl: { type: String, default: "", maxlength: 1000 },
      primaryColor: { type: String, default: "#173f36" },
      accentColor: { type: String, default: "#a8d65e" },
      surfaceMode: {
        type: String,
        enum: ["light", "dark", "charcoal"],
        default: "light",
      },
      publicSiteName: { type: String, default: "", maxlength: 160 },
      publicSiteLogoUrl: { type: String, default: "", maxlength: 1000 },
      publicSiteLogoDarkUrl: {
        type: String,
        default: "/elliescoachinglogo-white.png",
        maxlength: 1000,
      },
      poweredByGrowthOperator: { type: Boolean, default: false },
    },
    appBranding: {
      logoUrl: { type: String, default: "", maxlength: 1000 },
      logoLightUrl: { type: String, default: "", maxlength: 1000 },
      logoDarkUrl: { type: String, default: "", maxlength: 1000 },
      compactLogoUrl: { type: String, default: "", maxlength: 1000 },
      faviconUrl: { type: String, default: "", maxlength: 1000 },
      sidebarBackgroundColor: { type: String, default: "#102a24" },
      sidebarTextColor: { type: String, default: "#f7faf8" },
      headerColor: { type: String, default: "#ffffff" },
      primaryActionColor: { type: String, default: "#16624f" },
      accentColor: { type: String, default: "#8bc53f" },
      backgroundColor: { type: String, default: "#f5f7f6" },
      surfaceMode: {
        type: String,
        enum: ["light", "dark", "system"],
        default: "light",
      },
    },
    publicSite: {
      published: { type: Boolean, default: false },
      headline: { type: String, default: "", maxlength: 300 },
      headlineAccent: { type: String, default: "Discipline", maxlength: 160 },
      subheadline: { type: String, default: "", maxlength: 1200 },
      introTitle: { type: String, default: "", maxlength: 300 },
      introTitleAccent: {
        type: String,
        default: "real operators",
        maxlength: 160,
      },
      introLabel: {
        type: String,
        default: "WHY ELLIE COACHING",
        maxlength: 160,
      },
      introBody: { type: String, default: "", maxlength: 5000 },
      aboutBody: { type: String, default: "", maxlength: 12000 },
      aboutQuote: {
        type: String,
        default:
          "Successful investing is not about chasing shortcuts. It's about playing the infinite game, surrounding yourself with like-minded people, and consistently doing the work.",
        maxlength: 2000,
      },
      heroQuoteAttribution: {
        type: String,
        default: "ELLIE BAXTER",
        maxlength: 160,
      },
      aboutImageUrl: { type: String, default: "", maxlength: 1000 },
      eyebrow: { type: String, default: "", maxlength: 160 },
      heroMediaUrl: { type: String, default: "", maxlength: 1000 },
      introVideoUrl: { type: String, default: "", maxlength: 1000 },
      introVideoPosterUrl: { type: String, default: "", maxlength: 1000 },
      introVideoEyebrow: { type: String, default: "", maxlength: 160 },
      introVideoTitle: { type: String, default: "", maxlength: 300 },
      introVideoCopy: { type: String, default: "", maxlength: 1200 },
      primaryCtaLabel: { type: String, default: "Apply Now", maxlength: 80 },
      primaryCtaUrl: { type: String, default: "/apply", maxlength: 1000 },
      secondaryCtaLabel: { type: String, default: "", maxlength: 80 },
      secondaryCtaUrl: { type: String, default: "", maxlength: 1000 },
      finalCtaEyebrow: { type: String, default: "", maxlength: 160 },
      finalCtaTitle: { type: String, default: "", maxlength: 400 },
      finalCtaCopy: { type: String, default: "", maxlength: 1200 },
      finalCtaLabel: { type: String, default: "", maxlength: 80 },
      finalCtaUrl: { type: String, default: "", maxlength: 1000 },
      communityTitle: { type: String, default: "", maxlength: 300 },
      communityBody: { type: String, default: "", maxlength: 3000 },
      communityCtaLabel: { type: String, default: "", maxlength: 80 },
      communityCtaUrl: { type: String, default: "", maxlength: 1000 },
      heroOverline: {
        type: String,
        default: "Structured programs",
        maxlength: 160,
      },
      heroTagline: {
        type: String,
        default: "Real people · practical work · accountable progress",
        maxlength: 300,
      },
      aboutEyebrow: {
        type: String,
        default: "Why Ellie Coaching",
        maxlength: 160,
      },
      aboutTitle: {
        type: String,
        default: "Experience, perspective, and practical support.",
        maxlength: 300,
      },
      valuePropositions: {
        type: [
          {
            _id: false,
            title: { type: String, maxlength: 160 },
            body: { type: String, maxlength: 800 },
          },
        ],
        default: [],
      },
      programsEyebrow: { type: String, default: "Programs", maxlength: 160 },
      programsTitle: {
        type: String,
        default: "Choose the support that meets you where you are.",
        maxlength: 300,
      },
      journeyEyebrow: { type: String, default: "Your path", maxlength: 160 },
      journeyTitle: {
        type: String,
        default: "From exploring a program to doing the work.",
        maxlength: 300,
      },
      journeyCopy: {
        type: String,
        default:
          "Applying starts a conversation. Enrollment is not automatic or guaranteed.",
        maxlength: 1200,
      },
      journeySteps: { type: [String], default: [] },
      eventEyebrow: {
        type: String,
        default: "Upcoming training",
        maxlength: 160,
      },
      eventTitle: { type: String, default: "", maxlength: 300 },
      eventSummary: { type: String, default: "", maxlength: 1200 },
      eventCtaLabel: { type: String, default: "Event details", maxlength: 80 },
      allowThemeToggle: { type: Boolean, default: false },
      headingFont: {
        type: String,
        enum: ["editorial", "modern", "classic"],
        default: "editorial",
      },
      bodyFont: {
        type: String,
        enum: ["modern", "classic"],
        default: "modern",
      },
      baseFontSize: { type: Number, min: 14, max: 20, default: 16 },
      headingScale: { type: Number, min: 0.8, max: 1.2, default: 1 },
      sectionVisibility: {
        video: { type: Boolean, default: true },
        proof: { type: Boolean, default: true },
        programs: { type: Boolean, default: true },
        journey: { type: Boolean, default: true },
        team: { type: Boolean, default: true },
        testimonials: { type: Boolean, default: true },
        results: { type: Boolean, default: false },
        event: { type: Boolean, default: true },
        community: { type: Boolean, default: true },
      },
      trustMetrics: {
        type: [
          {
            _id: false,
            value: { type: String, maxlength: 80 },
            label: { type: String, maxlength: 120 },
          },
        ],
        default: [],
      },
      contactEmail: { type: String, default: "", maxlength: 320 },
      contactPhone: { type: String, default: "", maxlength: 80 },
      footerText: { type: String, default: "", maxlength: 1000 },
      socialLinks: {
        type: [
          {
            _id: false,
            label: { type: String, maxlength: 60 },
            url: { type: String, maxlength: 1000 },
          },
        ],
        default: [],
      },
    },
    publicApplication: {
      enabled: { type: Boolean, default: true },
      heading: { type: String, default: "Apply for coaching", maxlength: 240 },
      intro: {
        type: String,
        default: "Tell us where you are and where you want to go.",
        maxlength: 1200,
      },
      confirmationMessage: {
        type: String,
        default: "Thank you. Your application has been received.",
        maxlength: 1000,
      },
      questionLabels: {
        investingExperience: {
          type: String,
          default: "Investing experience",
          maxlength: 160,
        },
        currentSituation: {
          type: String,
          default: "Current situation",
          maxlength: 160,
        },
        goals: { type: String, default: "Goals", maxlength: 160 },
        desiredStartTimeline: {
          type: String,
          default: "Desired start timeline",
          maxlength: 160,
        },
        message: {
          type: String,
          default: "Anything else we should know?",
          maxlength: 160,
        },
      },
      timelineOptions: { type: [String], default: [] },
      nextStepCta: {
        label: { type: String, default: "", maxlength: 120 },
        url: { type: String, default: "", maxlength: 1000 },
      },
      privacyUrl: { type: String, default: "/privacy", maxlength: 1000 },
      termsUrl: { type: String, default: "/terms", maxlength: 1000 },
      heroImageUrl: { type: String, default: "", maxlength: 1000 },
      defaultAssigneeUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      notificationRecipientUserIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
      },
      programAssignments: {
        type: [
          {
            _id: false,
            coachingProgramId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "CoachingProgram",
              required: true,
            },
            userId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "User",
              required: true,
            },
          },
        ],
        default: [],
      },
    },
    customContactFields: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, required: true },
          type: {
            type: String,
            enum: ["text", "number", "date", "boolean"],
            default: "text",
          },
        },
      ],
      default: [],
    },
    contactLabels: {
      type: [String],
      default: [],
    },
    ambassadorOnboarding: {
      requiredFields: {
        type: [String],
        enum: [
          "headshot",
          "bio",
          "instagram",
          "linkedin",
          "company",
          "website",
          "timezone",
        ],
        default: ["headshot", "bio"],
      },
      welcomeDraftOnComplete: { type: Boolean, default: false },
    },
    ai: {
      enabled: { type: Boolean, default: true },
      monthlyLimitUsd: { type: Number, default: null, min: 0 },
      warningThresholdPercent: { type: Number, default: 80, min: 1, max: 100 },
      agentEnabled: {
        jarvis: { type: Boolean, default: true },
        lead: { type: Boolean, default: true },
        social: { type: Boolean, default: true },
        sales: { type: Boolean, default: true },
        content: { type: Boolean, default: true },
        coaching: { type: Boolean, default: true },
        research: { type: Boolean, default: true },
        system: { type: Boolean, default: true },
      },
    },
    // Google Gemini Developer API provider — optional, off by default. Two
    // independently switchable capabilities: Workspace Context (answers a
    // question via prompt-stuffing from this workspace's own already-approved
    // knowledge/structured data — NOT a search index) and Grounding
    // (controlled public-web discovery via Gemini's Google Search grounding).
    // Neither capability works at all unless GEMINI_ENABLED/GEMINI_API_KEY are
    // also set server-side — this block only controls whether THIS workspace
    // has opted in, on top of that platform-level switch. See `vertex` below
    // for the separate, real Vertex AI Search (Discovery Engine) Agent Search.
    gemini: {
      workspaceContextEnabled: { type: Boolean, default: false },
      groundingEnabled: { type: Boolean, default: false },
      monthlyLimitUsd: { type: Number, default: null, min: 0 },
    },
    // Optional Vertex AI provider — a SEPARATE Google product from the Gemini
    // Developer API block above, with its own server-side service-account
    // credential (never GEMINI_API_KEY). Two independently switchable
    // capabilities: groundingEnabled (Vertex AI Gemini + Google Search
    // grounding, services/vertexGroundingService.js) and agentSearchEnabled
    // (real indexed, tenant-isolated retrieval over this workspace's approved
    // Knowledge Center documents via Vertex AI Search / Discovery Engine,
    // services/discoveryEngineService.js). Neither works unless VERTEX_ENABLED
    // and the Google Cloud project/location/data-store env vars are also set
    // server-side — see services/vertexConfigService.js.
    vertex: {
      groundingEnabled: { type: Boolean, default: false },
      agentSearchEnabled: { type: Boolean, default: false },
      monthlyLimitUsd: { type: Number, default: null, min: 0 },
    },
    socialAi: {
      analysisEnabled: { type: Boolean, default: false },
      suggestedRepliesEnabled: { type: Boolean, default: true },
      qualificationAssistanceEnabled: { type: Boolean, default: true },
      humanApprovalRequired: { type: Boolean, default: true },
      confidenceThreshold: { type: Number, default: 0.78, min: 0, max: 1 },
      allowedIntents: {
        type: [String],
        default: [
          "general_question",
          "program_interest",
          "pricing_question",
          "application_interest",
          "coaching_interest",
          "buying_intent",
          "objection",
          "support",
          "partnership",
          "human_requested",
          "unknown",
        ],
      },
    },
    payments: {
      autoEnrollOnVerifiedPayment: { type: Boolean, default: false },
    },
    automationPolicy: {
      enabled: { type: Boolean, default: false },
      dryRun: { type: Boolean, default: true },
      backgroundSocialAiEnabled: { type: Boolean, default: false },
      qualificationAutomationAllowed: { type: Boolean, default: false },
      humanApprovalRequired: { type: Boolean, default: true },
      automaticProviderActionsAllowed: { type: Boolean, default: false },
      automaticReplyAllowed: { type: Boolean, default: false },
      publishingAllowed: { type: Boolean, default: false },
      requireProviderCapability: { type: Boolean, default: true },
      requireMessagingWindow: { type: Boolean, default: true },
      requireSelectedAsset: { type: Boolean, default: true },
      stopOnUncertainOutcome: { type: Boolean, default: true },
      maxRetries: { type: Number, default: 2, min: 0, max: 5 },
      maxActionsPerHour: { type: Number, default: 20, min: 1, max: 1000 },
      maxActionsPerDay: { type: Number, default: 100, min: 1, max: 10000 },
      conversationCooldownMinutes: {
        type: Number,
        default: 15,
        min: 0,
        max: 1440,
      },
      duplicateWindowMinutes: {
        type: Number,
        default: 1440,
        min: 1,
        max: 43200,
      },
    },
    discoveryTemplates: {
      type: [
        {
          _id: false,
          id: { type: String, required: true },
          name: { type: String, required: true, trim: true, maxlength: 120 },
          mode: {
            type: String,
            enum: ["people", "organizations"],
            default: "people",
          },
          titles: { type: String, default: "" },
          industries: { type: String, default: "" },
          keywords: { type: String, default: "" },
          locations: { type: String, default: "" },
          employeeMin: { type: String, default: "" },
          employeeMax: { type: String, default: "" },
          employeeRanges: { type: [String], default: [] },
          industryIds: { type: [String], default: [] },
          emailStatuses: { type: [String], default: [] },
          seniorities: { type: [String], default: [] },
          technologiesAny: { type: String, default: "" },
          technologiesAll: { type: String, default: "" },
          technologiesExclude: { type: String, default: "" },
          revenueMin: { type: String, default: "" },
          revenueMax: { type: String, default: "" },
          fundingMin: { type: String, default: "" },
          fundingMax: { type: String, default: "" },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

workspaceConfigSchema.plugin(workspacePlugin);
workspaceConfigSchema.index({ workspaceId: 1, key: 1 }, { unique: true });
module.exports = mongoose.model("WorkspaceConfig", workspaceConfigSchema);
