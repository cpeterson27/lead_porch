const mongoose = require("mongoose");

// Short-lived by design — a TTL index removes these automatically once
// expiresAt passes, so nothing needs to sweep this collection manually.
// Two purposes share this one model instead of two nearly-identical ones:
// "login" (issued mid-login, before a session exists) and "setup" (issued
// when a user is proving ownership of a new phone number to turn 2FA on).
const twoFactorChallengeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    purpose: { type: String, enum: ["login", "setup"], required: true },
    codeHash: { type: String, required: true },
    // "login": which workspace was requested at the login form, if any —
    // carried through so verify-2fa can finish the exact same workspace
    // selection /login would have done. "setup": the phone number being
    // verified, not committed to the User until the code checks out.
    requestedWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null },
    phone: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

twoFactorChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("TwoFactorChallenge", twoFactorChallengeSchema);
