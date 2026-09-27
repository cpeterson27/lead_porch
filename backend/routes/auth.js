const crypto = require("crypto");
const mongoose = require("mongoose");
const express = require("express");
const AuthSession = require("../models/AuthSession");
const User = require("../models/User");
require("../models/Workspace");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const TwoFactorChallenge = require("../models/TwoFactorChallenge");
const TrustedDevice = require("../models/TrustedDevice");
const PasswordResetToken = require("../models/PasswordResetToken");
const { ACTIVE_ROLES } = require("../authorization/accessPolicy");
const { normalizeRoles } = require("../authorization/capabilities");
const { hashPassword, verifyPassword } = require("../utils/passwords");
const workspaceMemberService = require("../services/workspaceMemberService");
const imageAssetService = require("../services/imageAssetService");
const publicSiteService = require("../services/publicSiteService");
const twoFactorSmsService = require("../services/twoFactorSmsService");
const integrationHub = require("../services/integrationHub");
const { primaryFrontendUrl } = require("../utils/frontendUrl");
const {
  clearSessionCookie,
  createAuthContext,
  parseCookies,
  requireAuth,
  sessionCookie,
  sessionToken,
  tokenHash,
} = require("../middleware/auth");

const router = express.Router();
const SESSION_DAYS = 14;

function membershipSummary(membership) {
  const workspace = membership.workspaceId;
  return { id: workspace._id, name: workspace.name, slug: workspace.slug, roles: normalizeRoles(membership) };
}

async function activeMemberships(userId) {
  const memberships = await WorkspaceMembership.find({ userId, status: "active" })
    .populate("workspaceId", "name slug status billingStatus rolePermissionTemplates")
    .sort({ createdAt: 1, _id: 1 });
  return memberships.filter((membership) => membership.workspaceId?.status === "active" && normalizeRoles(membership).some((role) => ACTIVE_ROLES.includes(role)));
}

function selectLoginMembership(memberships, requestedWorkspaceId = "") {
  if (!memberships.length) throw Object.assign(new Error("No active workspace is available for this account"), { code: "NO_ACTIVE_WORKSPACE" });
  if (!requestedWorkspaceId && memberships.length > 1) throw Object.assign(new Error("Choose a workspace to continue"), { code: "WORKSPACE_SELECTION_REQUIRED", workspaces: memberships.map(membershipSummary) });
  const membership = requestedWorkspaceId ? memberships.find((item) => String(item.workspaceId._id) === String(requestedWorkspaceId)) : memberships[0];
  if (!membership) throw Object.assign(new Error("You do not have active access to that workspace"), { code: "WORKSPACE_FORBIDDEN" });
  return membership;
}

function freshSessionValues(req, userId, workspaceId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return { token, csrfToken, expiresAt, record: { tokenHash: tokenHash(token), csrfToken, userId, workspaceId, expiresAt, userAgent: String(req.headers["user-agent"] || "").slice(0, 500), lastSeenAt: new Date() } };
}

// Finishes a login exactly the same way whether the password alone was
// enough or a 2FA code was also required — one place issues the session so
// the two paths can never quietly drift apart. extraCookies lets the 2FA
// verify step also set the "remember this device" cookie in the same
// response, alongside (never instead of) the session cookie.
async function completeLogin(req, res, user, membership, extraCookies = []) {
  const values = freshSessionValues(req, user._id, membership.workspaceId._id);
  const session = await AuthSession.create(values.record);
  user.lastLoginAt = new Date();
  await user.save();
  res.setHeader("Set-Cookie", [sessionCookie(values.token, values.expiresAt), ...extraCookies]);
  req.auth = createAuthContext({ user, workspace: membership.workspaceId, membership, session });
  res.json({ ...publicSession(req), sessionToken: values.token });
}

const TWO_FACTOR_CODE_TTL_MINUTES = 10;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_MAX_RESENDS = 3;
function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function hashSixDigitCode(code) {
  return crypto.createHash("sha256").update(String(code || "")).digest("hex");
}

// A browser that already proved it controls the phone once doesn't need to
// prove it again on every login for a month — mirrors the "remember this
// browser for 30 days" checkbox on Twilio's own hosted Verify page. Kept
// entirely separate from the session cookie: this one only ever skips
// asking for a NEW 2FA code, it can never itself sign anyone in.
const TRUSTED_DEVICE_COOKIE = "ellie_2fa_trust";
const TRUSTED_DEVICE_DAYS = 30;
function trustedDeviceCookie(token, expiresAt) {
  const secure = process.env.NODE_ENV === "production";
  return [
    `${TRUSTED_DEVICE_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ].filter(Boolean).join("; ");
}
async function findTrustedDevice(req, userId) {
  const token = parseCookies(req.headers.cookie || "")[TRUSTED_DEVICE_COOKIE];
  if (!token) return null;
  return TrustedDevice.findOne({ userId, tokenHash: tokenHash(token), expiresAt: { $gt: new Date() } }).select("_id");
}

async function rotateSession({ req, sessionId, userId, workspaceId }, SessionModel = AuthSession) {
  const values = freshSessionValues(req, userId, workspaceId);
  const session = await SessionModel.findOneAndUpdate({ _id: sessionId, userId }, { $set: values.record }, { new: true }).select("+csrfToken");
  return session ? { ...values, session } : null;
}

router.get("/invitations/:token", async (req, res) => {
  try {
    const WorkspaceInvitation = require("../models/WorkspaceInvitation");
    const invitation = await WorkspaceInvitation.findOne({ tokenHash: workspaceMemberService.invitationHash(req.params.token), status: "pending", expiresAt: { $gt: new Date() } }).select("name email userId workspaceId expiresAt requiresAccountActivation").lean();
    if (!invitation) return res.status(404).json({ valid: false, error: "This invitation is invalid or has expired" });
    const hasActiveMembership = await WorkspaceMembership.exists({ userId: invitation.userId, workspaceId: { $ne: invitation.workspaceId }, status: "active" });
    return res.json({ valid: true, name: invitation.name, email: invitation.email, expiresAt: invitation.expiresAt, requiresAccountActivation: invitation.requiresAccountActivation !== false && !hasActiveMembership });
  } catch (_error) { return res.status(400).json({ valid: false, error: "Unable to verify invitation" }); }
});

router.post("/invitations/:token/accept", async (req, res) => {
  try {
    await workspaceMemberService.acceptInvitation({ token: req.params.token, password: req.body?.password, name: req.body?.name, firstName: req.body?.firstName, lastName: req.body?.lastName, phone: req.body?.phone });
    return res.json({ success: true });
  } catch (error) { return res.status(400).json({ error: error.message || "Unable to accept invitation", code: error.code }); }
});

function publicSession(req) {
  return {
    user: { id: req.auth.user._id, name: req.auth.user.name, email: req.auth.user.email, avatarUrl: req.auth.user.avatarUrl || "" },
    workspace: {
      id: req.auth.workspace._id,
      name: req.auth.workspace.name,
      slug: req.auth.workspace.slug,
      billingStatus: req.auth.workspace.billingStatus,
    },
    role: req.auth.role,
    roles: req.auth.roles,
    effectivePermissions: req.auth.effectivePermissions,
    membershipStatus: "active",
    isPlatformOwner: Boolean(req.auth.isPlatformOwner),
    csrfToken: req.auth.session.csrfToken,
  };
}

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const user = await User.findOne({ email, status: "active" }).select("+passwordHash");
    const passwordValid = user && await verifyPassword(req.body?.password, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Email or password is incorrect" });
    }

    const memberships = await activeMemberships(user._id);
    const requestedWorkspaceId = String(req.body?.workspaceId || "");

    if (user.twoFactor?.enabled && !await findTrustedDevice(req, user._id)) {
      // Password is correct, but don't resolve the workspace or issue a
      // session yet — that happens in /login/verify-2fa once the code
      // checks out, using this exact same requestedWorkspaceId.
      const code = generateSixDigitCode();
      const challenge = await TwoFactorChallenge.create({
        userId: user._id,
        purpose: "login",
        codeHash: hashSixDigitCode(code),
        requestedWorkspaceId: requestedWorkspaceId || null,
        expiresAt: new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60000),
      });
      try {
        await twoFactorSmsService.sendVerificationCode({ workspaceId: memberships[0]?.workspaceId?._id, phone: user.phone, code });
      } catch (sendError) {
        await TwoFactorChallenge.deleteOne({ _id: challenge._id });
        console.error("2FA SEND ERROR:", sendError);
        return res.status(500).json({ error: sendError.message || "Unable to send your verification code" });
      }
      return res.json({ requiresTwoFactor: true, challengeId: challenge._id, phoneLastFour: String(user.phone || "").slice(-4) });
    }

    let membership;
    try { membership = selectLoginMembership(memberships, requestedWorkspaceId); }
    catch (selectionError) {
      const status = selectionError.code === "WORKSPACE_SELECTION_REQUIRED" ? 409 : 403;
      return res.status(status).json({ error: selectionError.message, code: selectionError.code, ...(selectionError.workspaces ? { workspaces: selectionError.workspaces } : {}) });
    }

    await completeLogin(req, res, user, membership);
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ error: "Unable to sign in" });
  }
});

router.post("/login/verify-2fa", async (req, res) => {
  try {
    const challengeId = req.body?.challengeId;
    // A missing/malformed id must never fall through to an unfiltered
    // lookup — Mongoose drops an undefined _id from the query entirely,
    // which would match *some* other user's pending login challenge
    // instead of failing closed.
    if (!challengeId || !mongoose.isValidObjectId(challengeId)) {
      return res.status(400).json({ error: "That code has expired. Please sign in again." });
    }
    const challenge = await TwoFactorChallenge.findOne({ _id: challengeId, purpose: "login" });
    if (!challenge || challenge.expiresAt < new Date()) {
      return res.status(400).json({ error: "That code has expired. Please sign in again." });
    }
    if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      await TwoFactorChallenge.deleteOne({ _id: challenge._id });
      return res.status(429).json({ error: "Too many incorrect attempts. Please sign in again." });
    }
    if (hashSixDigitCode(req.body?.code) !== challenge.codeHash) {
      challenge.attempts += 1;
      await challenge.save();
      return res.status(401).json({ error: "That code is incorrect." });
    }

    const user = await User.findOne({ _id: challenge.userId, status: "active" });
    if (!user) return res.status(401).json({ error: "Unable to sign in" });
    const memberships = await activeMemberships(user._id);
    let membership;
    try { membership = selectLoginMembership(memberships, String(challenge.requestedWorkspaceId || "")); }
    catch (selectionError) {
      const status = selectionError.code === "WORKSPACE_SELECTION_REQUIRED" ? 409 : 403;
      return res.status(status).json({ error: selectionError.message, code: selectionError.code, ...(selectionError.workspaces ? { workspaces: selectionError.workspaces } : {}) });
    }

    await TwoFactorChallenge.deleteOne({ _id: challenge._id });

    const extraCookies = [];
    if (req.body?.rememberDevice) {
      const deviceToken = crypto.randomBytes(32).toString("base64url");
      const deviceExpiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
      await TrustedDevice.create({ userId: user._id, tokenHash: tokenHash(deviceToken), userAgent: String(req.headers["user-agent"] || "").slice(0, 500), expiresAt: deviceExpiresAt });
      extraCookies.push(trustedDeviceCookie(deviceToken, deviceExpiresAt));
    }
    await completeLogin(req, res, user, membership, extraCookies);
  } catch (error) {
    console.error("2FA VERIFY ERROR:", error);
    res.status(500).json({ error: "Unable to verify your code" });
  }
});

// A wrong-number typo or a code that expired mid-entry shouldn't force
// restarting the whole password step — this reuses the same challenge row
// (so it still can't outlive TWO_FACTOR_CODE_TTL_MINUTES from a fresh
// send) but caps how many times it can fire, since each one is a real SMS
// with a real cost.
router.post("/login/2fa/resend", async (req, res) => {
  try {
    const challengeId = req.body?.challengeId;
    if (!challengeId || !mongoose.isValidObjectId(challengeId)) {
      return res.status(400).json({ error: "That code has expired. Please sign in again." });
    }
    const challenge = await TwoFactorChallenge.findOne({ _id: challengeId, purpose: "login" });
    if (!challenge || challenge.expiresAt < new Date()) {
      return res.status(400).json({ error: "That code has expired. Please sign in again." });
    }
    if ((challenge.resends || 0) >= TWO_FACTOR_MAX_RESENDS) {
      return res.status(429).json({ error: "Too many resend attempts. Please sign in again." });
    }
    const user = await User.findOne({ _id: challenge.userId, status: "active" });
    if (!user) return res.status(400).json({ error: "That code has expired. Please sign in again." });
    const memberships = await activeMemberships(user._id);
    const code = generateSixDigitCode();
    try {
      await twoFactorSmsService.sendVerificationCode({ workspaceId: memberships[0]?.workspaceId?._id, phone: user.phone, code });
    } catch (sendError) {
      console.error("2FA RESEND ERROR:", sendError);
      return res.status(500).json({ error: sendError.message || "Unable to resend your verification code" });
    }
    challenge.codeHash = hashSixDigitCode(code);
    challenge.attempts = 0;
    challenge.resends = (challenge.resends || 0) + 1;
    challenge.expiresAt = new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60000);
    await challenge.save();
    res.json({ success: true, phoneLastFour: String(user.phone || "").slice(-4) });
  } catch (error) {
    console.error("2FA RESEND ERROR:", error);
    res.status(500).json({ error: "Unable to resend your verification code" });
  }
});

// Public, read-only — same information publicHtmlShell already exposes in
// page meta tags for this workspace's own domain, just shaped for the
// login page to skin itself with instead of always showing generic Lead
// Porch branding. Falls back to { branded: false } for leadporch.co itself
// or any host with no matching workspace, rather than erroring.
router.get("/login-branding", async (req, res) => {
  try {
    const workspace = await publicSiteService.workspace(req);
    const config = await WorkspaceConfig.findOne({ workspaceId: workspace._id, key: "primary" }).select("branding").lean();
    const branding = config?.branding || {};
    res.json({
      branded: true,
      workspaceName: branding.publicSiteName || workspace.name,
      logoUrl: branding.publicSiteLogoUrl || branding.logoUrl || "",
      primaryColor: branding.primaryColor || "",
      accentColor: branding.accentColor || "",
      surfaceMode: branding.surfaceMode || "light",
    });
  } catch (_error) {
    res.json({ branded: false });
  }
});

const PASSWORD_RESET_TTL_MINUTES = 60;

// Always answers the same way whether or not the email matches an account —
// a different response here would let anyone probe which emails have Lead
// Porch accounts. The actual reset link only ever goes out over email, and
// only when a match exists.
router.post("/forgot-password", async (req, res) => {
  const confirmation = { message: "If an account exists for that email, we've sent a link to reset the password." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.json(confirmation);
    const user = await User.findOne({ email, status: "active" }).select("_id name");
    if (!user) return res.json(confirmation);

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60000);
    await PasswordResetToken.create({ userId: user._id, tokenHash: tokenHash(token), expiresAt });

    const origin = String(req.get("origin") || "").trim().replace(/\/+$/, "") || primaryFrontendUrl();
    const resetUrl = `${origin}/reset-password?token=${token}`;
    let senderName = "Lead Porch";
    try {
      const workspace = await publicSiteService.workspace(req);
      const config = await WorkspaceConfig.findOne({ workspaceId: workspace._id, key: "primary" }).select("branding").lean();
      senderName = config?.branding?.publicSiteName || workspace.name || senderName;
    } catch { /* leadporch.co itself, or an unmatched host — generic sender name is fine */ }

    try {
      await integrationHub.execute("resend", "sendEmail", {
        from: process.env.EMAIL_FROM || `${senderName} <onboarding@resend.dev>`,
        to: email,
        subject: "Reset your password",
        text: `Hi ${user.name || ""},\n\nUse this link to reset your ${senderName} password. It expires in ${PASSWORD_RESET_TTL_MINUTES} minutes and only works once:\n\n${resetUrl}\n\nIf you didn't ask for this, you can ignore this email — your password hasn't changed.`,
        html: `<p>Hi ${user.name || ""},</p><p>Use the link below to reset your ${senderName} password. It expires in ${PASSWORD_RESET_TTL_MINUTES} minutes and only works once.</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>`,
      });
    } catch (sendError) {
      console.error("PASSWORD RESET EMAIL ERROR:", sendError.message);
    }
    res.json(confirmation);
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);
    res.json(confirmation);
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    const record = await PasswordResetToken.findOne({ tokenHash: tokenHash(token), usedAt: null, expiresAt: { $gt: new Date() } });
    if (!record) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    const user = await User.findOne({ _id: record.userId, status: "active" }).select("+passwordHash");
    if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired." });

    user.passwordHash = await hashPassword(req.body?.password);
    await user.save();
    record.usedAt = new Date();
    await record.save();
    // A password reset is exactly the moment to sign every device out —
    // including whoever might have been in the account without permission.
    await AuthSession.deleteMany({ userId: user._id });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Unable to reset your password" });
  }
});

// Turning 2FA ON: prove ownership of the phone first (a code sent, then
// confirmed) — it can never be enabled against an unverified number.
router.post("/account/2fa/start", requireAuth, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "Enter a phone number first" });
    await TwoFactorChallenge.deleteMany({ userId: req.auth.userId, purpose: "setup" });
    const code = generateSixDigitCode();
    const challenge = await TwoFactorChallenge.create({
      userId: req.auth.userId,
      purpose: "setup",
      phone,
      codeHash: hashSixDigitCode(code),
      expiresAt: new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60000),
    });
    try {
      await twoFactorSmsService.sendVerificationCode({ workspaceId: req.auth.workspaceId, phone, code });
    } catch (sendError) {
      await TwoFactorChallenge.deleteOne({ _id: challenge._id });
      return res.status(500).json({ error: sendError.message || "Unable to send a verification code" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("2FA SETUP START ERROR:", error);
    res.status(500).json({ error: "Unable to start verification" });
  }
});

router.post("/account/2fa/confirm", requireAuth, async (req, res) => {
  try {
    const challenge = await TwoFactorChallenge.findOne({ userId: req.auth.userId, purpose: "setup" }).sort({ createdAt: -1 });
    if (!challenge || challenge.expiresAt < new Date()) return res.status(400).json({ error: "That code has expired — request a new one." });
    if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      await TwoFactorChallenge.deleteOne({ _id: challenge._id });
      return res.status(429).json({ error: "Too many incorrect attempts — request a new code." });
    }
    if (hashSixDigitCode(req.body?.code) !== challenge.codeHash) {
      challenge.attempts += 1;
      await challenge.save();
      return res.status(401).json({ error: "That code is incorrect." });
    }
    await User.updateOne(
      { _id: req.auth.userId },
      { $set: { phone: challenge.phone, "twoFactor.enabled": true, "twoFactor.phoneVerifiedAt": new Date() } },
    );
    await TwoFactorChallenge.deleteOne({ _id: challenge._id });
    res.json({ success: true });
  } catch (error) {
    console.error("2FA SETUP CONFIRM ERROR:", error);
    res.status(500).json({ error: "Unable to confirm verification" });
  }
});

router.post("/account/2fa/disable", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId).select("+passwordHash");
    const passwordValid = user && await verifyPassword(req.body?.password, user.passwordHash);
    if (!passwordValid) return res.status(401).json({ error: "Your password is incorrect" });
    await User.updateOne({ _id: req.auth.userId }, { $set: { "twoFactor.enabled": false } });
    await TrustedDevice.deleteMany({ userId: req.auth.userId });
    res.json({ success: true });
  } catch (error) {
    console.error("2FA DISABLE ERROR:", error);
    res.status(500).json({ error: "Unable to turn off two-factor authentication" });
  }
});

router.get("/session", requireAuth, (req, res) => res.json(publicSession(req)));

router.get("/workspaces", requireAuth, async (req, res) => {
  const memberships = await activeMemberships(req.auth.userId);
  res.json({ currentWorkspaceId: req.auth.workspaceId, workspaces: memberships.map(membershipSummary) });
});

router.post("/switch-workspace", requireAuth, async (req, res) => {
  try {
    const workspaceId = String(req.body?.workspaceId || "");
    const membership = await WorkspaceMembership.findOne({ userId: req.auth.userId, workspaceId, status: "active" }).populate("workspaceId", "name slug status billingStatus rolePermissionTemplates");
    if (!membership?.workspaceId || membership.workspaceId.status !== "active" || !normalizeRoles(membership).some((role) => ACTIVE_ROLES.includes(role))) return res.status(403).json({ error: "You do not have active access to that workspace", code: "WORKSPACE_FORBIDDEN" });
    const rotated = await rotateSession({ req, sessionId: req.auth.session._id, userId: req.auth.userId, workspaceId: membership.workspaceId._id });
    if (!rotated) return res.status(401).json({ error: "Session expired", code: "SESSION_EXPIRED" });
    res.setHeader("Set-Cookie", sessionCookie(rotated.token, rotated.expiresAt));
    req.auth = createAuthContext({ user: req.auth.user, workspace: membership.workspaceId, membership, session: rotated.session });
    return res.json({ ...publicSession(req), sessionToken: rotated.token });
  } catch (error) { return res.status(400).json({ error: error.message || "Unable to switch workspace" }); }
});

router.get("/profile", requireAuth, async (req, res) => {
  try { return res.json({ user: await require("../services/userProfileService").load(req.auth) }); }
  catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load profile" }); }
});
router.patch("/profile", requireAuth, async (req, res) => {
  try {
    const previous = await require("../services/userProfileService").load(req.auth);
    const user = await require("../services/userProfileService").save(req.auth, req.body);
    await require("../services/ambassadorProfileActivity").recordProfileUpdate({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, previous, user });
    return res.json({ user });
  } catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to save profile" }); }
});

router.post("/profile/avatar", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.auth.user._id).select("+avatarPublicId");
    if (!user) return res.status(404).json({ error: "User profile not found" });
    const previousPublicId = user.avatarPublicId;
    const uploaded = await imageAssetService.uploadImage({ file: req.body?.file, folder: "growth-operator/profile-avatars", transformation: "c_fill,g_face,h_512,w_512,q_auto,f_auto" });
    user.avatarUrl = uploaded.url; user.avatarPublicId = uploaded.publicId; await user.save();
    await require("../services/ambassadorProfileActivity").recordHeadshot({ workspaceId: req.auth.workspaceId, user });
    if (previousPublicId && previousPublicId !== uploaded.publicId) imageAssetService.removeImage(previousPublicId).catch(() => {});
    return res.status(201).json({ user: { id: user._id, name: user.name, email: user.email, avatarUrl: user.avatarUrl } });
  } catch (error) { return res.status(error.status || 502).json({ error: error.message || "Profile photo upload failed", code: error.code }); }
});

router.delete("/profile/avatar", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.auth.user._id).select("+avatarPublicId");
    if (!user) return res.status(404).json({ error: "User profile not found" });
    const previousPublicId = user.avatarPublicId; user.avatarUrl = ""; user.avatarPublicId = ""; await user.save();
    if (previousPublicId) imageAssetService.removeImage(previousPublicId).catch(() => {});
    return res.json({ user: { id: user._id, name: user.name, email: user.email, avatarUrl: "" } });
  } catch (error) { return res.status(error.status || 502).json({ error: error.message || "Unable to remove profile photo", code: error.code }); }
});

router.patch("/password", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.auth.user._id).select("+passwordHash");
    if (!user || !await verifyPassword(req.body?.currentPassword, user.passwordHash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    if (req.body?.newPassword !== req.body?.confirmPassword) {
      return res.status(400).json({ error: "New passwords do not match" });
    }
    user.passwordHash = await hashPassword(req.body?.newPassword);
    await user.save();
    await AuthSession.deleteMany({ userId: user._id, _id: { $ne: req.auth.session._id } });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Unable to change password" });
  }
});

router.post("/logout", async (req, res) => {
  const token = sessionToken(req);
  if (token) await AuthSession.deleteOne({ tokenHash: tokenHash(token) });
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.status(204).end();
});

module.exports = router;
module.exports.activeMemberships = activeMemberships;
module.exports.freshSessionValues = freshSessionValues;
module.exports.membershipSummary = membershipSummary;
module.exports.rotateSession = rotateSession;
module.exports.selectLoginMembership = selectLoginMembership;
