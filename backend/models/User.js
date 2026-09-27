const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    firstName: { type: String, trim: true, maxlength: 80, default: "" },
    lastName: { type: String, trim: true, maxlength: 80, default: "" },
    phone: { type: String, trim: true, maxlength: 50, default: "" },
    jobTitle: { type: String, trim: true, maxlength: 120, default: "" },
    company: { type: String, trim: true, maxlength: 160, default: "" },
    bio: { type: String, trim: true, maxlength: 3000, default: "" },
    location: { type: String, trim: true, maxlength: 160, default: "" },
    timezone: { type: String, trim: true, maxlength: 100, default: "" },
    website: { type: String, trim: true, maxlength: 2000, default: "" },
    socialProfiles: { instagram: String, facebook: String, linkedin: String, x: String },
    profileUpdatedAt: { type: Date, default: null },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    lastLoginAt: { type: Date, default: null },
    avatarUrl: { type: String, default: "", maxlength: 2000 },
    avatarPublicId: { type: String, default: "", maxlength: 500, select: false },
    // Opt-in per account, off by default. Enabling it requires proving
    // ownership of `phone` via a text code first (see /auth/account/2fa/*),
    // so this can never flip on without a verified number behind it.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      phoneVerifiedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
