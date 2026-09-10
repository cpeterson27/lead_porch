const express = require("express");
const { requireCapability } = require("../middleware/auth");
const apolloService = require("../services/apolloService");
const peopleDataLabsService = require("../services/peopleDataLabsService");
const emailVerificationService = require("../services/emailVerificationService");

const router = express.Router();
router.use(requireCapability("discovery.manage"));

function mapProviderError(err) {
  const isDisabled = ["APOLLO_DISABLED", "PDL_DISABLED"].includes(err.code);
  const status = isDisabled ? 503 : err.code === "APOLLO_DOMAIN_REQUIRED" || err.code === "PDL_INSUFFICIENT_INPUTS" || err.code === "PDL_COMPANY_INPUT_REQUIRED" || err.code === "PDL_QUERY_REQUIRED" ? 400 : err.category === "authentication" ? 502 : err.category === "rate_limit" ? 429 : err.category === "circuit_open" ? 503 : 502;
  return { status, body: { success: false, error: err.message, code: err.code || err.category || "PROVIDER_REQUEST_FAILED" } };
}

/**
 * GET /providers/status
 * Never returns credential values — enabled/configured booleans only.
 */
router.get("/status", (req, res) => {
  res.json({
    success: true,
    data: {
      apollo: { enabled: apolloService.isEnabled(), configured: Boolean(process.env.APOLLO_API_KEY?.trim()) },
      peopleDataLabs: { enabled: peopleDataLabsService.isEnabled(), configured: Boolean(process.env.PDL_API_KEY?.trim()) },
      emailVerification: { enabled: emailVerificationService.isEnabled(), configured: Boolean(process.env.EMAILABLE_API_KEY?.trim()) },
    },
  });
});

router.get("/apollo/health", async (req, res) => {
  const health = await apolloService.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, correlationId: req.get("x-request-id") || "" });
  res.json({ success: true, data: health });
});

router.post("/apollo/people/search", async (req, res) => {
  try {
    const data = await apolloService.searchPeople({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, filters: req.body?.filters || {}, page: req.body?.page, perPage: req.body?.perPage, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/apollo/people/enrich", async (req, res) => {
  try {
    const data = await apolloService.enrichPerson({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, matchInput: req.body?.matchInput || {}, revealEmail: req.body?.revealEmail !== false, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/apollo/companies/search", async (req, res) => {
  try {
    const data = await apolloService.searchCompanies({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, filters: req.body?.filters || {}, page: req.body?.page, perPage: req.body?.perPage, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/apollo/companies/enrich", async (req, res) => {
  try {
    const data = await apolloService.enrichCompany({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, domain: req.query.domain, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/pdl/health", async (req, res) => {
  const health = await peopleDataLabsService.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, correlationId: req.get("x-request-id") || "" });
  res.json({ success: true, data: health });
});

router.post("/pdl/people/search", async (req, res) => {
  try {
    const data = await peopleDataLabsService.searchPeople({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, sql: req.body?.sql, size: req.body?.size, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/pdl/people/enrich", async (req, res) => {
  try {
    const data = await peopleDataLabsService.enrichPerson({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, inputs: req.body?.inputs || {}, minLikelihood: req.body?.minLikelihood, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/pdl/companies/enrich", async (req, res) => {
  try {
    const data = await peopleDataLabsService.enrichCompany({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, website: req.query.website, name: req.query.name, correlationId: req.get("x-request-id") || "" });
    res.json({ success: true, data });
  } catch (err) {
    const mapped = mapProviderError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

module.exports = router;
