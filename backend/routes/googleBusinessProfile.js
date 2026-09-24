const express = require("express");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const service = require("../services/googleBusinessProfileService");
const { requireRole } = require("../middleware/auth");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const { primaryFrontendUrl } = require("../utils/frontendUrl");

const router = express.Router();
const admin = requireRole("owner", "admin");
const requestOrigin = (req) => {
  const origin = String(req.get("origin") || "").trim();
  return /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, "") : "";
};

router.get("/oauth/callback", async (req, res) => {
  let frontend = primaryFrontendUrl();
  try {
    const state = service.verifyState(req.query.state);
    if (!state) throw new Error("Google Business Profile connection request expired or is invalid");
    if (state.returnOrigin) frontend = state.returnOrigin;
    const membership = await WorkspaceMembership.findOne({ workspaceId: state.workspaceId, userId: state.userId, status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { roles: { $in: ["owner", "admin"] } }] });
    if (!membership) throw new Error("Workspace permission is no longer available");
    if (!req.query.code) throw new Error(req.query.error || "Google did not return an authorization code");
    const tokens = await service.googleAdapter.exchangeCode(String(req.query.code));
    const profile = await service.googleAdapter.profile(tokens.access_token);
    await runWithWorkspace(state.workspaceId, () => service.saveConnection({ workspaceId: state.workspaceId }, tokens, profile));
    return res.redirect(`${frontend}/integrations?googleBusinessProfile=connected`);
  } catch (error) {
    return res.redirect(`${frontend}/integrations?googleBusinessProfile=error&message=${encodeURIComponent(error.message)}`);
  }
});

router.get("/status", admin, async (req, res) => res.json({ success: true, data: await service.status(req.auth.workspaceId) }));
router.get("/oauth/start", admin, (req, res) => {
  try { return res.json({ success: true, authorizationUrl: service.authorizationUrl(req.auth.workspaceId, req.auth.user._id, requestOrigin(req)) }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
router.get("/locations", admin, async (req, res, next) => {
  try { return res.json({ success: true, data: await service.listLocations(req.auth.workspaceId) }); }
  catch (error) { return next(error); }
});
router.patch("/location", admin, async (req, res, next) => {
  try { return res.json({ success: true, data: await service.selectLocation(req.auth.workspaceId, req.body || {}) }); }
  catch (error) { return next(error); }
});
router.post("/sync", admin, async (req, res, next) => {
  try { return res.json({ success: true, data: await service.syncReviews(req.auth.workspaceId) }); }
  catch (error) { return next(error); }
});
router.delete("/connection", admin, async (req, res, next) => {
  try { return res.json({ success: true, data: await service.disconnect(req.auth.workspaceId) }); }
  catch (error) { return next(error); }
});

module.exports = router;
