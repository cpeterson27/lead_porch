const express = require("express");
const multer = require("multer");
const { requireCapability } = require("../middleware/auth");
const { authenticatedUserId } = require("../authorization/accessPolicy");
const contractService = require("../services/contractService");

const router = express.Router();

// DocuSign redirects the browser here after the human approves the
// one-time JWT consent screen — public, since no session cookie survives
// a redirect out to account-d.docusign.com and back. It doesn't need to
// read anything from the redirect; the consent itself is what DocuSign
// records, this just gives the person a page to land on.
router.get("/docusign-consent-complete", (req, res) => {
  res.type("html").send("<p>DocuSign access granted. You can close this tab and go back to Lead Porch.</p>");
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
  const status = ["DOCUSIGN_NOT_CONNECTED", "DOCUSIGN_JWT_NOT_CONFIGURED", "DOCUSIGN_CONSENT_REQUIRED", "DOCUSIGN_SEND_NOT_IMPLEMENTED", "CONTRACT_ALREADY_SENT", "CONTRACT_NOT_DRAFT"].includes(error?.code) ? 409
    : error?.code === "CONTRACT_NOT_FOUND" ? 404
    : error?.code?.includes("INVALID") ? 400
    : 400;
  return res.status(status).json({ success: false, error: error.message || "Unable to complete contract operation", code: error.code || "CONTRACT_OPERATION_FAILED" });
}

router.get("/connection-status", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.connectionStatus(req.auth.workspaceId) });
}));

router.post("/connect", asyncRoute(async (req, res) => {
  const { integrationKey, clientSecret, accountId } = req.body || {};
  res.status(201).json({ success: true, data: await contractService.connect({ workspaceId: req.auth.workspaceId, integrationKey, clientSecret, accountId, actorUserId: authenticatedUserId(req) }) });
}));

router.post("/setup-jwt", asyncRoute(async (req, res) => {
  res.status(201).json({ success: true, data: await contractService.setupJwt({ workspaceId: req.auth.workspaceId, docusignUserId: req.body?.docusignUserId }) });
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

router.delete("/:id", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.deleteDraftContract({ workspaceId: req.auth.workspaceId, contractId: req.params.id }) });
}));

router.use((error, req, res, _next) => errorResponse(error, res));

module.exports = router;
