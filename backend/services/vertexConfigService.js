/**
 * Per-workspace configuration for the optional Vertex AI provider (Vertex
 * Gemini grounding + Discovery Engine Agent Search). This is the
 * workspace-owner-facing switch layered ON TOP of the platform-level
 * VERTEX_ENABLED + Google Cloud project/credential env vars — both gates
 * must pass before either Vertex capability runs. New paid features default
 * OFF; nothing here makes a real call by itself. Mirrors
 * services/geminiConfigService.js's exact shape, scoped to its own
 * `vertex` config block and its own `provider: "vertex"` usage ledger —
 * Vertex spend never shares Gemini's or OpenAI's budget.
 */
const WorkspaceConfig = require("../models/WorkspaceConfig");
const AiUsageRecord = require("../models/AiUsageRecord");
const aiUsageService = require("./aiUsageService");

const defaults = () => ({ groundingEnabled: false, agentSearchEnabled: false, monthlyLimitUsd: null });

async function get(workspaceId, Model = WorkspaceConfig) {
  if (!workspaceId) return defaults();
  const row = await Model.findOne({ workspaceId, key: "primary" }).select("vertex").lean();
  return { ...defaults(), ...(row?.vertex || {}) };
}

async function save(workspaceId, input = {}, Model = WorkspaceConfig) {
  const current = await get(workspaceId, Model);
  const monthlyLimitUsd = input.monthlyLimitUsd === undefined
    ? current.monthlyLimitUsd
    : input.monthlyLimitUsd === null || input.monthlyLimitUsd === ""
      ? null
      : Math.max(0, Number(input.monthlyLimitUsd));
  const value = {
    groundingEnabled: input.groundingEnabled === undefined ? current.groundingEnabled : Boolean(input.groundingEnabled),
    agentSearchEnabled: input.agentSearchEnabled === undefined ? current.agentSearchEnabled : Boolean(input.agentSearchEnabled),
    monthlyLimitUsd: Number.isFinite(monthlyLimitUsd) ? monthlyLimitUsd : null,
  };
  const row = await Model.findOneAndUpdate({ workspaceId, key: "primary" }, { $set: { vertex: value }, $setOnInsert: { key: "primary" } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return row.vertex?.toObject ? row.vertex.toObject() : row.vertex;
}

async function assertCapabilityEnabled({ workspaceId, capability }, dependencies = {}) {
  const config = await get(workspaceId, dependencies.WorkspaceConfig || WorkspaceConfig);
  if (!config[capability]) throw Object.assign(new Error(`Vertex ${capability === "agentSearchEnabled" ? "Agent Search" : "Grounding"} is not enabled for this workspace`), { code: "VERTEX_CAPABILITY_DISABLED" });
  if (config.monthlyLimitUsd != null) {
    const vertexCostUsd = await (dependencies.vertexMonthCost || vertexMonthCost)(workspaceId, dependencies.AiUsageRecord || AiUsageRecord);
    if (vertexCostUsd >= config.monthlyLimitUsd) throw Object.assign(new Error("The configured workspace Vertex AI monthly limit has been reached"), { code: "VERTEX_MONTHLY_LIMIT_REACHED" });
  }
  return config;
}

async function vertexMonthCost(workspaceId, Model) {
  const { start, end } = aiUsageService.monthRange();
  const rows = await Model.find({ workspaceId, provider: "vertex", createdAt: { $gte: start, $lt: end } }).select("estimatedTotalCostUsd").lean();
  return rows.reduce((sum, row) => sum + (row.estimatedTotalCostUsd == null ? 0 : Number(row.estimatedTotalCostUsd)), 0);
}

module.exports = { assertCapabilityEnabled, defaults, get, save };
