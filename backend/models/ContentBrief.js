const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const contentBriefSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: ["email", "email_template", "social", "landing_page", "ad", "brief"], default: "brief" },
  body: { type: String, required: true },
  subject: { type: String, default: "" },
  callToAction: { type: String, default: "" },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
  coachingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null },
  ambassadorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "AmbassadorProfile", default: null, index: true },
  origin: { type: String, enum: ["manual", "ai", "ambassador_welcome", "communication", "campaign"], default: "manual" },
  source: { type: String, enum: ["manual", "human", "jarvis", "campaign"], default: "human" },
  status: { type: String, enum: ["draft", "pending_approval", "approved", "scheduled", "publishing", "published", "partially_published", "rejected", "failed", "archived"], default: "draft", index: true },
  social: {
    destinations: { type: [{ _id: false, provider: { type: String, enum: ["facebook", "instagram", "linkedin", "x", "tiktok"], required: true }, assetId: { type: String, default: "", maxlength: 255 }, mode: { type: String, enum: ["api", "human_assisted", "unavailable"], default: "unavailable" } }], default: [] },
    media: { type: [{ _id: false, type: { type: String, enum: ["image", "video"], default: "image" }, url: { type: String, required: true, maxlength: 2000 }, publicId: { type: String, default: "", maxlength: 500 }, alt: { type: String, default: "", maxlength: 500 },
      // Detected once at upload time from the real Cloudinary response — never guessed.
      width: { type: Number, default: null }, height: { type: Number, default: null }, format: { type: String, default: "" }, sizeBytes: { type: Number, default: null }, durationSeconds: { type: Number, default: null }, orientation: { type: String, enum: ["", "landscape", "portrait", "square"], default: "" },
      // Non-destructive: each entry is a derived Cloudinary transformation URL, never a second
      // upload or a modification of the original file above.
      platformVariants: { type: [{ _id: false, provider: { type: String, enum: ["facebook", "instagram", "linkedin", "x"], required: true }, placement: { type: String, default: "feed", maxlength: 40 }, mode: { type: String, enum: ["crop", "contain"], default: "crop" }, url: { type: String, required: true, maxlength: 2000 }, width: { type: Number, required: true }, height: { type: Number, required: true }, generatedAt: { type: Date, default: Date.now } }], default: [] },
    }], default: [] },
    variants: { type: [{ _id: false, provider: { type: String, enum: ["facebook", "instagram", "linkedin", "x"], required: true }, body: { type: String, required: true, maxlength: 10000 }, hashtags: { type: [String], default: [] }, cta: { type: String, default: "", maxlength: 1000 } }], default: [] },
    generationHistory: { type: [{ _id: false, generatedAt: { type: Date, default: Date.now }, generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, kind: { type: String, enum: ["visual", "caption", "full"], default: "full" }, templateVersion: Number, previousMediaUrl: String, previousBody: String }], default: [] },
    cta: { label: { type: String, default: "", maxlength: 120 }, url: { type: String, default: "", maxlength: 2000 } },
    requestedPublishAt: { type: Date, default: null, index: true },
    approval: { requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, requestedAt: { type: Date, default: null }, approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, approvedAt: { type: Date, default: null }, rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, rejectedAt: { type: Date, default: null }, rejectionReason: { type: String, default: "", maxlength: 1000 } },
    editHistory: { type: [{ _id: false, editedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, editedAt: { type: Date, default: Date.now }, before: { type: mongoose.Schema.Types.Mixed, default: {} } }], default: [] },
    publications: { type: [{ _id: false, provider: String, assetId: String, status: { type: String, enum: ["pending", "publishing", "published", "failed", "unknown", "cancelled", "deleted"], default: "pending" }, idempotencyKey: String, providerPostId: String, publicUrl: String, publishedAt: Date, deletedAt: Date, lastAttemptAt: Date, attempts: { type: [{ _id: false, attemptedAt: { type: Date, default: Date.now }, status: String, error: String, providerPostId: String }], default: [] } }], default: [] },
    lastError: { type: String, default: "", maxlength: 2000 },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "content_briefs" });

contentBriefSchema.plugin(workspacePlugin);
contentBriefSchema.index({ workspaceId: 1, type: 1, status: 1, "social.requestedPublishAt": 1 });
module.exports = mongoose.model("ContentBrief", contentBriefSchema);
