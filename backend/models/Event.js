const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const eventSchema = new mongoose.Schema(
  {
    // Basic event information
    name: {
      type: String,
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    summary: {
      type: String,
      default: "",
    },

    category: {
      type: String,
      default: "",
    },

    tags: [
      {
        type: String,
      },
    ],

    // Date and time
    startDate: {
      type: Date,
      default: null,
    },

    endDate: {
      type: Date,
    },

    timeZone: {
      type: String,
      default: "America/Los_Angeles",
    },

    // Location
    locationType: {
      type: String,
      enum: ["online", "venue"],
      default: "online",
    },

    location: {
      type: String,
      default: "",
    },

    onlineUrl: {
      type: String,
      default: "",
    },

    // Ticketing
    ticketPrice: {
      type: Number,
      default: 0,
    },

    ticketGoal: {
      type: Number,
      default: 0,
    },

    ticketsSold: {
      type: Number,
      default: 0,
    },

    capacity: {
      type: Number,
      default: 0,
    },

    eventbriteLogistics: {
      status: { type: String, default: "" },
      organizerName: { type: String, default: "" },
      organizerId: { type: String, default: "" },
      currency: { type: String, default: "USD" },
      minimumCheckoutPrice: { type: Number, default: null },
      maximumCheckoutPrice: { type: Number, default: null },
      ticketClassCount: { type: Number, default: 0 },
      ticketsSold: { type: Number, default: 0 },
      ticketsRemaining: { type: Number, default: 0 },
      orderCount: { type: Number, default: 0 },
      attendeeCount: { type: Number, default: 0 },
      checkedInCount: { type: Number, default: 0 },
      grossRevenue: { type: Number, default: 0 },
      isSoldOut: { type: Boolean, default: false },
      hasAvailableTickets: { type: Boolean, default: false },
      ticketClasses: { type: [mongoose.Schema.Types.Mixed], default: [] },
      lastSyncedAt: { type: Date, default: null },
      lastSyncStatus: { type: String, default: "" },
      lastSyncError: { type: String, default: "" },
    },

    // Read-only mirror of the Eventbrite listing. Marketing strategy lives
    // separately below and is never inferred as authoritative Eventbrite data.
    eventbriteListing: {
      summary: { type: String, default: "" },
      descriptionHtml: { type: String, default: "" },
      descriptionText: { type: String, default: "" },
      structuredContent: { type: mongoose.Schema.Types.Mixed, default: {} },
      agenda: { type: [mongoose.Schema.Types.Mixed], default: [] },
      presenters: { type: [mongoose.Schema.Types.Mixed], default: [] },
      faqs: { type: [mongoose.Schema.Types.Mixed], default: [] },
      organizer: { type: mongoose.Schema.Types.Mixed, default: {} },
      refundPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
      highlights: { type: [String], default: [] },
      durationMinutes: { type: Number, default: 0 },
      image: { type: mongoose.Schema.Types.Mixed, default: {} },
      category: { type: mongoose.Schema.Types.Mixed, default: {} },
      subcategory: { type: mongoose.Schema.Types.Mixed, default: {} },
      format: { type: mongoose.Schema.Types.Mixed, default: {} },
      venue: { type: mongoose.Schema.Types.Mixed, default: {} },
      onlineAccess: { type: mongoose.Schema.Types.Mixed, default: {} },
      publishSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
      sourceUpdatedAt: { type: Date, default: null },
      lastRetrievedAt: { type: Date, default: null },
    },

    // Audience + marketing
    audience: [
      {
        type: String,
      },
    ],

    audienceSuggestions: [{ type: String }],
    audienceRecommendationDetails: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    audienceRecommendationSource: {
      type: String,
      enum: ["", "rules", "openai", "eventbrite_description"],
      default: "",
    },
    audienceConfirmedAt: { type: Date, default: null },

    // Draft-first planning information. These fields are owned by Growth Operator
    // until the user explicitly creates an Eventbrite draft.
    planning: {
      attendeeOutcomes: { type: String, default: "" },
      idealAttendee: { type: String, default: "" },
      businessGoal: { type: String, default: "" },
      organizerName: { type: String, default: "" },
      organizerDescription: { type: String, default: "" },
      presenters: { type: [mongoose.Schema.Types.Mixed], default: [] },
      agenda: { type: [mongoose.Schema.Types.Mixed], default: [] },
      faqs: { type: [mongoose.Schema.Types.Mixed], default: [] },
      refundPolicy: { type: String, default: "" },
      highlights: { type: [String], default: [] },
      imageUrl: { type: String, default: "" },
      ticketClasses: { type: [mongoose.Schema.Types.Mixed], default: [] },
      draftStep: { type: Number, default: 1 },
    },

    channels: [
      {
        type: String,
      },
    ],

    // Integrations
    integrations: {
      eventbrite: {
        enabled: {
          type: Boolean,
          default: false,
        },
        eventId: {
          type: String,
          default: "",
        },
        url: {
          type: String,
          default: "",
        },
      },

      meetup: {
        enabled: {
          type: Boolean,
          default: false,
        },
        eventId: {
          type: String,
          default: "",
        },
        url: {
          type: String,
          default: "",
        },
      },

      monday: {
        enabled: {
          type: Boolean,
          default: false,
        },
        boardId: {
          type: String,
          default: "",
        },
      },

      research: {
        enabled: {
          type: Boolean,
          default: false,
        },
      },

      resend: {
        enabled: {
          type: Boolean,
          default: false,
        },
      },
    },

    status: {
      type: String,
      enum: ["draft", "active", "completed"],
      default: "draft",
    },

    // Recurring internal events (e.g. a biweekly group coaching class). Set
    // only on the first occurrence — eventRecurrenceService reads this to
    // generate each future occurrence as its own plain Event, so nothing
    // downstream (reminders, the events list, registration) needs to know
    // recurrence exists at all.
    recurrence: {
      frequency: {
        type: String,
        enum: ["", "weekly", "biweekly", "monthly"],
        default: "",
      },
      until: { type: Date, default: null },
    },

    // Set on every event eventRecurrenceService generates, pointing back at
    // the first occurrence (the one holding the `recurrence` rule above).
    // Null on a one-off event and on the first occurrence of a series.
    seriesId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

eventSchema.plugin(workspacePlugin);
module.exports = mongoose.model("Event", eventSchema);
