const AiUsageRecord = require("../models/AiUsageRecord");

function monthRange(now = new Date()) {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

async function summary(workspaceId, { now = new Date(), Model = AiUsageRecord } = {}) {
  const { start, end } = monthRange(now);
  const rows = await Model.find({ workspaceId, createdAt: { $gte: start, $lt: end } }).select("agent feature model provider endpoint inputTokens outputTokens cachedTokens reasoningTokens totalTokens estimatedTotalCostUsd success errorCategory").lean();
  // failureCount surfaces alongside requestCount on every grouped row below
  // specifically so a row reading "$0.00, 0 tokens" is never mistaken for a
  // tracking bug: a failed call (e.g. the account was out of OpenAI credit)
  // genuinely has nothing to bill, and without a visible failure count that
  // looks identical, at a glance, to usage simply not being recorded.
  const groupedBy = (keyOf) => Object.values(rows.reduce((result, row) => {
    const key = keyOf(row) || "unknown"; const target = result[key] ||= { key, requestCount: 0, failureCount: 0, totalTokens: 0, estimatedTotalCostUsd: 0, pricedRequestCount: 0 };
    target.requestCount += 1; target.totalTokens += Number(row.totalTokens) || 0;
    if (!row.success) target.failureCount += 1;
    if (row.estimatedTotalCostUsd != null) { target.estimatedTotalCostUsd += Number(row.estimatedTotalCostUsd); target.pricedRequestCount += 1; }
    return result;
  }, {}));
  const grouped = (field) => groupedBy((row) => row[field]);
  const estimatedTotalCostUsd = rows.reduce((n, row) => n + (row.estimatedTotalCostUsd == null ? 0 : Number(row.estimatedTotalCostUsd)), 0);
  // A simple same-pace projection, not a forecast model: if this much was
  // spent across the days elapsed so far this month, the rest of the month
  // continuing at that same daily rate lands at this total. Exists to
  // directly answer "how much should I be adding each month" — the owner's
  // own question — with a real number grounded in her actual recent usage,
  // not a guess. A 20% buffer on top is the suggested top-up so a normal
  // day-to-day swing in volume doesn't run the account to zero again.
  const daysInMonth = Math.round((end - start) / 86400000);
  const daysElapsed = Math.max(1, Math.min(daysInMonth, Math.ceil((Math.min(now, end) - start) / 86400000)));
  const projectedMonthEndCostUsd = (estimatedTotalCostUsd / daysElapsed) * daysInMonth;
  const suggestedMonthlyTopUpUsd = Math.ceil(projectedMonthEndCostUsd * 1.2);
  return {
    period: { start, end }, requestCount: rows.length,
    tokens: { input: rows.reduce((n, row) => n + (Number(row.inputTokens) || 0), 0), output: rows.reduce((n, row) => n + (Number(row.outputTokens) || 0), 0), cached: rows.reduce((n, row) => n + (Number(row.cachedTokens) || 0), 0), reasoning: rows.reduce((n, row) => n + (Number(row.reasoningTokens) || 0), 0), total: rows.reduce((n, row) => n + (Number(row.totalTokens) || 0), 0) },
    estimatedTotalCostUsd,
    pricedRequestCount: rows.filter((row) => row.estimatedTotalCostUsd != null).length,
    unpricedRequestCount: rows.filter((row) => row.estimatedTotalCostUsd == null).length,
    successCount: rows.filter((row) => row.success).length, failureCount: rows.filter((row) => !row.success).length,
    // "Why did 15 requests cost $0?" — because they failed, and this says
    // why: "request" here almost always means the provider rejected the
    // call for being out of credit/over its spend limit, not a bug in Lead
    // Porch. Real, reported confusion: a wall of $0.00/0-token rows looked
    // exactly like broken tracking until this was visible.
    byErrorCategory: Object.values(rows.filter((row) => !row.success).reduce((result, row) => {
      const key = row.errorCategory || "unknown"; const target = result[key] ||= { key, count: 0 };
      target.count += 1; return result;
    }, {})),
    projection: { daysElapsed, daysInMonth, projectedMonthEndCostUsd, suggestedMonthlyTopUpUsd },
    byAgent: grouped("agent"), byModel: grouped("model"), byProvider: grouped("provider"), byEndpoint: grouped("endpoint"),
    // "Which button" — the exact feature string passed to runAgent() at each
    // call site (e.g. "qualify_and_recommend_leads", "jarvis_chat") — real,
    // reported request: the owner has no idea which specific action in the
    // product is driving her OpenAI spend, only which agent it's loosely
    // grouped under.
    byFeature: grouped("feature"),
    // One card per real (provider, endpoint) combination actually recorded —
    // e.g. "openai / chat.completions", "vertex / generateContent" — the
    // same granularity OpenAI's own usage dashboard groups by (Responses and
    // Chat Completions, Images, ...), but reflecting every provider this
    // workspace actually uses, not just OpenAI.
    byProviderEndpoint: Object.values(rows.reduce((result, row) => {
      const provider = row.provider || "unknown", endpoint = row.endpoint || "unknown", key = `${provider}:${endpoint}`;
      const target = result[key] ||= { key, provider, endpoint, requestCount: 0, failureCount: 0, totalTokens: 0, estimatedTotalCostUsd: 0, pricedRequestCount: 0 };
      target.requestCount += 1; target.totalTokens += Number(row.totalTokens) || 0;
      if (!row.success) target.failureCount += 1;
      if (row.estimatedTotalCostUsd != null) { target.estimatedTotalCostUsd += Number(row.estimatedTotalCostUsd); target.pricedRequestCount += 1; }
      return result;
    }, {})),
    costIsEstimate: true,
  };
}

module.exports = { monthRange, summary };
