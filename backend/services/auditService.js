/**
 * Single entry point for writing to the app-wide audit log (models/AuditLog.js).
 * Every write goes through record() so redaction is applied consistently —
 * individual call sites should never write to AuditLog directly.
 */
const AuditLog = require("../models/AuditLog");
require("../models/User"); // ensures populate("actorUserId") always resolves regardless of require order

const SECRET_KEY_PATTERN = /(secret|token|password|apikey|api_key|credential|authorization|privatekey|private_key)/i;

/** Deep-redacts anything that looks like a credential, recursively, and drops functions/undefined. Caps depth to avoid pathological input. */
function sanitize(value, depth = 0) {
  if (depth > 4 || value == null) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) { clean[key] = "[redacted]"; continue; }
      if (typeof val === "function") continue;
      clean[key] = sanitize(val, depth + 1);
    }
    return clean;
  }
  if (typeof value === "string") return value.slice(0, 2000);
  return value;
}

async function record({
  workspaceId, actorUserId = null, actorRole = "", origin = "human", action, targetType, targetId = null,
  before = null, after = null, approvalId = null, provider = "", externalId = "", costCredits = null,
  success = true, requestId = "", metadata = {},
} = {}, Model = AuditLog) {
  if (!workspaceId) return null;
  if (!action || !targetType) { console.warn("[Audit] record() called without action/targetType — skipped"); return null; }
  try {
    return await Model.create({
      workspaceId, actorUserId, actorRole, origin, action, targetType, targetId,
      before: sanitize(before), after: sanitize(after), approvalId, provider, externalId, costCredits,
      success, requestId, metadata: sanitize(metadata),
    });
  } catch (error) {
    // An audit-write failure must never break the real action it's
    // describing — log and continue, matching the established
    // usage-ledger-write-skipped convention elsewhere in this codebase.
    console.warn("[Audit] write skipped", { code: error.code || "AUDIT_WRITE_FAILED", action, targetType });
    return null;
  }
}

async function query({ workspaceId, action, targetType, targetId, actorUserId, origin, success, from, to, limit = 100, cursor }, Model = AuditLog) {
  const filter = { workspaceId };
  if (action) filter.action = action;
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  if (actorUserId) filter.actorUserId = actorUserId;
  if (origin) filter.origin = origin;
  if (success !== undefined) filter.success = success;
  if (from || to) filter.occurredAt = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  if (cursor) filter._id = { $lt: cursor };
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = await Model.find(filter).populate("actorUserId", "name email").sort({ _id: -1 }).limit(safeLimit + 1).lean();
  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  return { rows: page, nextCursor: hasMore ? String(page.at(-1)._id) : null };
}

/** CSV export for owner/admin download — same field set as the model, safe by construction since it reads back already-sanitized rows. */
async function exportCsv({ workspaceId, action, targetType, from, to }, Model = AuditLog) {
  const filter = { workspaceId };
  if (action) filter.action = action;
  if (targetType) filter.targetType = targetType;
  if (from || to) filter.occurredAt = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  const rows = await Model.find(filter).populate("actorUserId", "name email").sort({ occurredAt: -1 }).limit(10000).lean();
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["occurredAt", "actor", "actorRole", "origin", "action", "targetType", "targetId", "success", "provider", "externalId", "costCredits", "requestId"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.occurredAt?.toISOString?.() || "", row.actorUserId?.email || row.actorUserId?.name || "system", row.actorRole, row.origin, row.action,
      row.targetType, row.targetId || "", row.success, row.provider, row.externalId, row.costCredits ?? "", row.requestId,
    ].map(escape).join(","));
  }
  return lines.join("\n");
}

/** Retention: permanently deletes audit rows older than the given age. Owner/admin triggered only — never automatic without an explicit policy. */
async function purgeOlderThan({ workspaceId, olderThanDays }, Model = AuditLog) {
  if (!olderThanDays || olderThanDays < 90) throw Object.assign(new Error("Retention must keep at least 90 days of audit history"), { code: "AUDIT_RETENTION_TOO_SHORT" });
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const result = await Model.deleteMany({ workspaceId, occurredAt: { $lt: cutoff } });
  return { deletedCount: result.deletedCount || 0, cutoff };
}

module.exports = { record, query, exportCsv, purgeOlderThan, sanitize };
