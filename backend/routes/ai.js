const express = require("express");
const aiConfigService = require("../services/aiConfigService");
const aiUsageService = require("../services/aiUsageService");
const geminiConfigService = require("../services/geminiConfigService");
const geminiService = require("../services/geminiService");
const vertexConfigService = require("../services/vertexConfigService");
const vertexGroundingService = require("../services/vertexGroundingService");
const discoveryEngineService = require("../services/discoveryEngineService");
const discoveryEngineSyncService = require("../services/discoveryEngineSyncService");
const apolloService = require("../services/apolloService");
const peopleDataLabsService = require("../services/peopleDataLabsService");
const emailVerificationService = require("../services/emailVerificationService");
const llmService = require("../services/llmService");
const ResearchMonitor = require("../models/ResearchMonitor");

function requireAiAdministrator(req, res, next) {
  const roles = new Set([...(req.auth?.roles || []), req.auth?.role].filter(Boolean));
  if (req.auth?.isPlatformOwner || roles.has("owner") || roles.has("admin")) return next();
  return res.status(403).json({ error: "Owner or Admin access is required", code: "AI_ADMIN_REQUIRED" });
}

function createAiRouter(dependencies = {}) {
  const router = express.Router();
  const configService = dependencies.aiConfigService || aiConfigService;
  const usageService = dependencies.aiUsageService || aiUsageService;

  router.use(requireAiAdministrator);
  router.get("/usage/summary", async (req, res) => {
    try {
      return res.json({ success: true, data: await usageService.summary(req.auth.workspaceId) });
    } catch (error) {
      return res.status(500).json({ error: "AI usage could not be loaded", code: "AI_USAGE_SUMMARY_FAILED" });
    }
  });
  router.get("/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await configService.get(req.auth.workspaceId) });
    } catch (error) {
      return res.status(500).json({ error: "AI configuration could not be loaded", code: "AI_CONFIG_READ_FAILED" });
    }
  });
  router.patch("/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await configService.save(req.auth.workspaceId, req.body || {}) });
    } catch (error) {
      return res.status(400).json({ error: error.message || "AI configuration could not be saved", code: error.code || "AI_CONFIG_SAVE_FAILED" });
    }
  });

  const geminiConfig = dependencies.geminiConfigService || geminiConfigService;
  router.get("/gemini/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await geminiConfig.get(req.auth.workspaceId) });
    } catch (error) {
      return res.status(500).json({ error: "Gemini configuration could not be loaded", code: "GEMINI_CONFIG_READ_FAILED" });
    }
  });
  router.patch("/gemini/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await geminiConfig.save(req.auth.workspaceId, req.body || {}) });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Gemini configuration could not be saved", code: error.code || "GEMINI_CONFIG_SAVE_FAILED" });
    }
  });

  const vertexConfig = dependencies.vertexConfigService || vertexConfigService;
  router.get("/vertex/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await vertexConfig.get(req.auth.workspaceId) });
    } catch (error) {
      return res.status(500).json({ error: "Vertex configuration could not be loaded", code: "VERTEX_CONFIG_READ_FAILED" });
    }
  });
  router.patch("/vertex/config", async (req, res) => {
    try {
      return res.json({ success: true, data: await vertexConfig.save(req.auth.workspaceId, req.body || {}) });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Vertex configuration could not be saved", code: error.code || "VERTEX_CONFIG_SAVE_FAILED" });
    }
  });

  /** Vertex AI Gemini + Google Search grounding — a real, billed call. Requires the full platform+workspace+budget gate to pass. */
  router.post("/vertex/grounding", async (req, res) => {
    try {
      const vertex = dependencies.vertexGroundingService || vertexGroundingService;
      const data = await vertex.groundedSearch({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, query: req.body?.query, resultTypes: req.body?.resultTypes, correlationId: req.headers["x-request-id"] || "" });
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(error.code ? 400 : 502).json({ error: error.message || "Vertex grounding failed", code: error.code || "VERTEX_GROUNDING_FAILED" });
    }
  });

  /** Real, indexed search over this workspace's own approved Knowledge Center documents via Vertex AI Search (Discovery Engine). */
  router.post("/vertex/agent-search", async (req, res) => {
    try {
      const sync = dependencies.discoveryEngineSyncService || discoveryEngineSyncService;
      const data = await sync.search({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, query: req.body?.query, correlationId: req.headers["x-request-id"] || "" });
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(error.code ? 400 : 502).json({ error: error.message || "Vertex Agent Search failed", code: error.code || "VERTEX_AGENT_SEARCH_FAILED" });
    }
  });

  /**
   * Explicit data-deletion request: purges every Knowledge Center document
   * this workspace has ever had indexed in Discovery Engine, regardless of
   * current opt-in state. Owner/admin only (already enforced by
   * requireAiAdministrator above) — this is a real, irreversible deletion
   * request sent to Google, not a local toggle.
   */
  router.post("/vertex/agent-search/purge", async (req, res) => {
    try {
      const sync = dependencies.discoveryEngineSyncService || discoveryEngineSyncService;
      const data = await sync.purgeWorkspace(req.auth.workspaceId, req.auth.user?._id);
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(error.code ? 400 : 502).json({ error: error.message || "Vertex Agent Search purge failed", code: error.code || "VERTEX_AGENT_SEARCH_PURGE_FAILED" });
    }
  });

  /**
   * Read-only provider status for the AI & Acquisition Controls page.
   * Never returns credential values — enabled/configured/healthy only.
   */
  router.get("/providers/health", async (req, res) => {
    const gemini = dependencies.geminiService || geminiService;
    const vertexGrounding = dependencies.vertexGroundingService || vertexGroundingService;
    const discoveryEngine = dependencies.discoveryEngineService || discoveryEngineService;
    const [apollo, pdl, geminiHealth, vertexHealth, discoveryEngineHealth] = await Promise.all([
      apolloService.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id }).catch((error) => ({ enabled: apolloService.isEnabled(), healthy: false, reason: error.message })),
      peopleDataLabsService.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id }).catch((error) => ({ enabled: peopleDataLabsService.isEnabled(), healthy: false, reason: error.message })),
      gemini.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id }).catch((error) => ({ enabled: gemini.masterEnabled(), healthy: false, reason: error.message })),
      vertexGrounding.healthCheck({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id }).catch((error) => ({ enabled: vertexGrounding.masterEnabled(), healthy: false, reason: error.message })),
      discoveryEngine.healthCheck().catch((error) => ({ enabled: discoveryEngine.masterEnabled(), healthy: false, reason: error.message })),
    ]);
    return res.json({
      success: true,
      data: {
        openai: llmService.getStatus(),
        gemini: geminiHealth,
        vertexGrounding: vertexHealth,
        discoveryEngineAgentSearch: discoveryEngineHealth,
        apollo,
        peopleDataLabs: pdl,
        emailable: { enabled: emailVerificationService.isEnabled(), configured: Boolean(process.env.EMAILABLE_API_KEY?.trim()) },
      },
    });
  });

  /**
   * Emergency stop: disables OpenAI, both Gemini capabilities, both Vertex
   * capabilities, and every research monitor for this workspace in one
   * action. Reversible — nothing is deleted, only turned off (use
   * POST /vertex/agent-search/purge separately for an actual data-deletion
   * request).
   */
  router.post("/pause-all", async (req, res) => {
    try {
      const workspaceId = req.auth.workspaceId;
      const [ai, gemini, vertex] = await Promise.all([
        configService.save(workspaceId, { enabled: false }),
        geminiConfig.save(workspaceId, { workspaceContextEnabled: false, groundingEnabled: false }),
        vertexConfig.save(workspaceId, { groundingEnabled: false, agentSearchEnabled: false }),
      ]);
      const monitors = await ResearchMonitor.updateMany({ workspaceId, enabled: true }, { $set: { enabled: false } });
      return res.json({ success: true, data: { ai, gemini, vertex, monitorsDisabled: monitors.modifiedCount || 0 } });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Pause All could not be completed", code: "AI_PAUSE_ALL_FAILED" });
    }
  });

  return router;
}

const router = createAiRouter();
module.exports = router;
module.exports.createAiRouter = createAiRouter;
module.exports.requireAiAdministrator = requireAiAdministrator;
