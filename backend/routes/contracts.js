const express = require("express");
const { requireCapability } = require("../middleware/auth");
const { authenticatedUserId } = require("../authorization/accessPolicy");
const contractService = require("../services/contractService");

const router = express.Router();
router.use(requireCapability("coaching.view"));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorResponse(error, res) {
  const status = error?.code === "DOCUSIGN_NOT_CONNECTED" || error?.code === "DOCUSIGN_SEND_NOT_IMPLEMENTED" || error?.code === "CONTRACT_ALREADY_SENT" ? 409
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

router.get("/", asyncRoute(async (req, res) => {
  res.json({ success: true, data: await contractService.listContracts({ workspaceId: req.auth.workspaceId, contactId: req.query.contactId || null }) });
}));

router.post("/", asyncRoute(async (req, res) => {
  const { contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail } = req.body || {};
  const contract = await contractService.createDraftContract({ workspaceId: req.auth.workspaceId, contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail, createdBy: authenticatedUserId(req) });
  res.status(201).json({ success: true, data: contract });
}));

router.post("/:id/send", asyncRoute(async (req, res) => {
  await contractService.sendForSignature({ workspaceId: req.auth.workspaceId, contractId: req.params.id });
  res.json({ success: true });
}));

router.use((error, req, res, _next) => errorResponse(error, res));

module.exports = router;
