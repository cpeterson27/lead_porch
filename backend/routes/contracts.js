const express = require("express");
const multer = require("multer");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const { requireCapability, requireRole } = require("../middleware/auth");
const { authenticatedUserId } = require("../authorization/accessPolicy");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const { primaryFrontendUrl } = require("../utils/frontendUrl");
const contractService = require("../services/contractService");

const router = express.Router();
const admin = requireRole("owner", "admin");
const requestOrigin = (req) => {
  const origin = String(req.get("origin") || "").trim();
  return /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, "") : "";
};

// DocuSign redirects the browser here after the business owner logs into
// their own DocuSign and approves access — public, since no session
// cookie survives that round trip out to account-d.docusign.com and back.
// state carries the workspace/user this began from (see
// contractService.createState), the same way every other OAuth callback
// in this app already works.
router.get("/oauth/callback", async (req, res) => {
  let frontend = primaryFrontendUrl();
  try {
    const state = contractService.verifyState(req.query.state);
    if (!state) throw new Error("DocuSign connection request expired or is invalid");
    if (state.returnOrigin) frontend = state.returnOrigin;
    const membership = await WorkspaceMembership.findOne({ workspaceId: state.workspaceId, userId: state.userId, status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { roles: { $in: ["owner", "admin"] } }] });
    if (!membership) throw new Error("Workspace permission is no longer available");
    if (!req.query.code) throw new Error(req.query.error_description || req.query.error || "DocuSign did not return an authorization code");
    const tokens = await contractService.docusignAdapter.exchangeCode(String(req.query.code));
    const userInfo = await contractService.docusignAdapter.userInfo(tokens.access_token);
    await runWithWorkspace(state.workspaceId, () => contractService.saveConnection({ workspaceId: state.workspaceId }, tokens, userInfo));
    return res.redirect(`${frontend}/coaching/contracts?docusign=connected`);
  } catch (error) {
    return res.redirect(`${frontend}/coaching/contracts?docusign=error&message=${encodeURIComponent(error.message)}`);
  }
});

router.use(requireCapability("coaching.view"));
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorResponse(error, res) {
  const status = ["DOCUSIGN_NOT_CONNECTED", "DOCUSIGN_RECONNECT_REQUIRED", "CONTRACT_ALREADY_SENT", "CONTRACT_NOT_DRAFT", "CONTRACT_DUPLICATE", "CONTRACT_NOT_SENT", "CONTRACT_NOT_PENDING"].includes(error?.code) ? 409
    : error?.code === "CONTRACT_NOT_FOUND" ? 404
    : error?.code?.includes("INVALID") ? 400
    : 400;
  return res.status(status).json({ success: false, error: error.message || "Unable to complete contract operation", code: error.code || "CONTRACT_OPERATION_FAILED" });
}

router.get("/connection-status", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.connectionStatus(req.auth.workspaceId) });
}));

router.get("/oauth/start", admin, (req, res) => {
  try { return res.json({ success: true, authorizationUrl: contractService.authorizationUrl(req.auth.workspaceId, req.auth.user._id, requestOrigin(req)) }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

router.delete("/connection", admin, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.disconnect(req.auth.workspaceId) });
}));

router.get("/", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.listContracts({ workspaceId: req.auth.workspaceId, contactId: req.query.contactId || null }) });
}));

router.post("/", asyncRoute(async (req, res) => {
  const { contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail } = req.body || {};
  const contract = await contractService.createDraftContract({ workspaceId: req.auth.workspaceId, contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail, createdBy: authenticatedUserId(req) });
  res.status(201).json({ success: true, data: contract });
}));

router.post("/:id/send", documentUpload.single("document"), asyncRoute(async (req, res) => {
  const contract = await contractService.sendForSignature({ workspaceId: req.auth.workspaceId, contractId: req.params.id, fileBuffer: req.file?.buffer, fileName: req.file?.originalname });
  res.json({ success: true, data: contract });
}));

router.post("/:id/resend", asyncRoute(async (req, res) => {
  const contract = await contractService.resendEnvelope({ workspaceId: req.auth.workspaceId, contractId: req.params.id });
  res.json({ success: true, data: contract });
}));

router.delete("/:id", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.deleteDraftContract({ workspaceId: req.auth.workspaceId, contractId: req.params.id }) });
}));

router.use((error, req, res, _next) => errorResponse(error, res));

module.exports = router;
