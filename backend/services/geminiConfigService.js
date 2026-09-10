/**
 * Per-workspace configuration for the optional Gemini provider. This is the
 * workspace-owner-facing switch layered ON TOP of the platform-level
 * GEMINI_ENABLED/GEMINI_API_KEY switch in services/geminiService.js — both
 * gates must pass before either Gemini capability runs. New paid features
 * default OFF; nothing here makes a real call by itself.
 */
const WorkspaceConfig = require("../models/WorkspaceConfig");
const AiUsageRecord = require("../models/AiUsageRecord");
const aiUsageService = require("./aiUsageService");

const defaults = () => ({ workspaceContextEnabled: false, groundingEnabled: false, monthlyLimitUsd: null });

async function get(workspaceId, Model = WorkspaceConfig) {
  if (!workspaceId) return defaults();
  const row = await Model.findOne({ workspaceId, key: "primary" }).select("gemini").lean();
  return { ...defaults(), ...(row?.gemini || {}) };
}

async function save(workspaceId, input = {}, Model = WorkspaceConfig) {
  const current = await get(workspaceId, Model);
  const monthlyLimitUsd = input.monthlyLimitUsd === undefined
    ? current.monthlyLimitUsd
    : input.monthlyLimitUsd === null || input.monthlyLimitUsd === ""
      ? null
      : Math.max(0, Number(input.monthlyLimitUsd));
  const value = {
    workspaceContextEnabled: input.workspaceContextEnabled === undefined ? current.workspaceContextEnabled : Boolean(input.workspaceContextEnabled),
    groundingEnabled: input.groundingEnabled === undefined ? current.groundingEnabled : Boolean(input.groundingEnabled),
    monthlyLimitUsd: Number.isFinite(monthlyLimitUsd) ? monthlyLimitUsd : null,
  };
  const row = await Model.findOneAndUpdate({ workspaceId, key: "primary" }, { $set: { gemini: value }, $setOnInsert: { key: "primary" } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return row.gemini?.toObject ? row.gemini.toObject() : row.gemini;
}

/**
 * Reuses the same AiUsageRecord ledger aiConfigService checks for the
 * overall OpenAI monthly limit, scoped to provider: "gemini" only — Gemini
 * spend has its own, separate budget rather than sharing OpenAI's cap.
 */
async function assertCapabilityEnabled({ workspaceId, capability }, dependencies = {}) {
  const config = await get(workspaceId, dependencies.WorkspaceConfig || WorkspaceConfig);
  if (!config[capability]) throw Object.assign(new Error(`Gemini ${capability === "workspaceContextEnabled" ? "Workspace Context" : "Grounding"} is not enabled for this workspace`), { code: "GEMINI_CAPABILITY_DISABLED" });
  if (config.monthlyLimitUsd != null) {
    const geminiCostUsd = await (dependencies.geminiMonthCost || geminiMonthCost)(workspaceId, dependencies.AiUsageRecord || AiUsageRecord);
    if (geminiCostUsd >= config.monthlyLimitUsd) throw Object.assign(new Error("The configured workspace Gemini monthly limit has been reached"), { code: "GEMINI_MONTHLY_LIMIT_REACHED" });
  }
  return config;
}

async function geminiMonthCost(workspaceId, Model) {
  const { start, end } = aiUsageService.monthRange();
  const rows = await Model.find({ workspaceId, provider: "gemini", createdAt: { $gte: start, $lt: end } }).select("estimatedTotalCostUsd").lean();
  return rows.reduce((sum, row) => sum + (row.estimatedTotalCostUsd == null ? 0 : Number(row.estimatedTotalCostUsd)), 0);
}

module.exports = { assertCapabilityEnabled, defaults, get, save };
