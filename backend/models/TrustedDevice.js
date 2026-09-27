const mongoose = require("mongoose");

// A browser that completed a 2FA code once and checked "remember this
// device" gets one of these instead of being texted a fresh code every
// login for TRUSTED_DEVICE_DAYS (see routes/auth.js). Only the SHA-256 hash
// of the cookie token is ever stored, same approach as AuthSession — a
// database read alone can never produce a usable trusted-device cookie.
const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("TrustedDevice", trustedDeviceSchema);
