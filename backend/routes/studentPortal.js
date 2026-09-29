const express = require("express");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const studentPortalService = require("../services/studentPortalService");
const PortalAccessToken = require("../models/PortalAccessToken");

const router = express.Router();

// Public — a student has no Lead Porch login of their own, just this
// token-based link (see studentPortalService.issuePortalLink). Reads the
// token's own workspaceId first (mirrors publicSiteService's EditToken
// lookup pattern), then runs the rest of the request inside that
// workspace's context.
async function withPortalWorkspace(req, res, handler) {
  try {
    const tokenHash = require("crypto").createHash("sha256").update(String(req.params.token || "")).digest("hex");
    const record = await PortalAccessToken.findOne({ tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } }).select("workspaceId");
    if (!record) return res.status(404).json({ success: false, error: "This portal link is invalid or has expired. Ask your coach for a new one.", code: "PORTAL_TOKEN_INVALID" });
    await runWithWorkspace(record.workspaceId, () => handler());
  } catch (error) {
    res.status(error.code ? 400 : 500).json({ success: false, error: error.message || "Unable to load your portal", code: error.code || "PORTAL_ERROR" });
  }
}

router.get("/:token", (req, res) => withPortalWorkspace(req, res, async () => {
  res.json({ success: true, data: await studentPortalService.getPortalData(req.params.token) });
}));

router.post("/:token/modules/:moduleId/complete", (req, res) => withPortalWorkspace(req, res, async () => {
  res.json({ success: true, data: await studentPortalService.markModuleComplete({ raw: req.params.token, courseModuleId: req.params.moduleId }) });
}));

module.exports = router;
