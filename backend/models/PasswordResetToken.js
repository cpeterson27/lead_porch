const mongoose = require("mongoose");

// Short-lived by design — a TTL index removes these automatically once
// expiresAt passes, so nothing needs to sweep this collection manually.
// Only the SHA-256 hash of the token is ever stored (same approach as
// AuthSession's tokenHash), so a database read alone can never produce a
// usable reset link.
const passwordResetTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PasswordResetToken", passwordResetTokenSchema);
