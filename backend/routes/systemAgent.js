const express = require("express");
const { requireCapability } = require("../middleware/auth");
const systemAgentHealthService = require("../services/systemAgentHealthService");
const agentExecutionService = require("../services/agentExecutionService");

const router = express.Router();
router.use(requireCapability("system.monitor"));

/**
 * GET /api/system-agent/pipeline-health
 * Deterministic-only Lead Pipeline Health report. Never calls OpenAI, never
 * changes data. Every finding is read directly from the database.
 */
router.get("/pipeline-health", async (req, res) => {
  try {
    const report = await systemAgentHealthService.getLeadPipelineHealth(req.auth.workspaceId);
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/system-agent/pipeline-health/synthesize
 * Optional OpenAI-assisted layer on top of the same deterministic report:
 * root-cause explanations and prioritization narrative only. The System
 * Agent has no tools that write, contact anyone, publish, or delete — this
 * call can only read and explain what the deterministic checks already found.
 */
router.post("/pipeline-health/synthesize", async (req, res) => {
  try {
    const result = await agentExecutionService.runAgent({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      auth: req.auth,
      agent: "system",
      task: "explain_pipeline_health",
      input: {},
      operationalContext:
        "Base every claim strictly on the supplied tool results (the Lead Pipeline Health findings). Do not invent issues, records, or root causes absent from the data. Explain WHY the top issues matter and what the likely root cause is, then confirm the existing recommended action or sharpen it. Never propose contacting anyone, publishing, deleting, or changing data directly — only describe what a human should review or do next.",
      correlationId: `pipeline-health:${req.auth.workspaceId}`,
      options: {
        tools: [{ toolId: "system.get_pipeline_health", input: {} }],
        responseSchema: {
          type: "object",
          properties: {
            overallAssessment: { type: "string" },
            topPriorities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  findingId: { type: "string" },
                  rootCause: { type: "string" },
                  whyItMatters: { type: "string" },
                  sharpenedRecommendation: { type: "string" },
                },
                required: ["findingId", "rootCause", "whyItMatters", "sharpenedRecommendation"],
                additionalProperties: false,
              },
            },
          },
          required: ["overallAssessment", "topPriorities"],
          additionalProperties: false,
        },
        schemaName: "pipeline_health_synthesis",
      },
    });
    res.json({ success: true, data: result.output, metadata: result.metadata });
  } catch (err) {
    const isBillingLimit = err.status === 429 || err.statusCode === 429;
    const status = isBillingLimit
      ? 429
      : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code)
        ? 403
        : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code)
          ? 400
          : 500;
    res.status(status).json({
      success: false,
      message: isBillingLimit ? "OpenAI credits are empty. The deterministic report above is still fully accurate without it." : err.message,
    });
  }
});

module.exports = router;
