/**
 * Orchestrates the real Vertex AI Search (Discovery Engine) "Agent Search"
 * capability: keeping the shared data store's index in sync with each
 * workspace's own APPROVED Knowledge Center documents (never a draft,
 * rejected, or archived one), serving tenant-isolated search over it, and
 * handling explicit per-workspace revocation. All indexing/removal calls
 * are best-effort and NEVER throw — a Discovery Engine hiccup must never
 * block the actual Knowledge Center approve/reject/archive action it is
 * mirroring, matching this app's existing auditService.record() convention.
 *
 * Called from services/jarvisMemoryService.js's approve/reject/archive/
 * restoreVersion — see the inline requires there.
 */
const discoveryEngineService = require("./discoveryEngineService");
const vertexConfigService = require("./vertexConfigService");
const AiUsageRecord = require("../models/AiUsageRecord");
const auditService = require("./auditService");

function docId(workspaceId, noteId) {
  return `kc-${String(workspaceId)}-${String(noteId)}`;
}

async function capabilityReady(workspaceId, dependencies = {}) {
  if (!discoveryEngineService.masterEnabled() || !discoveryEngineService.agentSearchPlatformEnabled()) return false;
  const platformOk = await (dependencies.vertexPlatformAvailable || require("./platformConfigService").vertexPlatformAvailable)();
  if (!platformOk) return false;
  try {
    const config = await vertexConfigService.get(workspaceId, dependencies.WorkspaceConfig);
    return Boolean(config.agentSearchEnabled);
  } catch {
    return false;
  }
}

async function logIndexUsage(workspaceId, feature, success, models = { AiUsageRecord }) {
  if (!workspaceId) return;
  try {
    await models.AiUsageRecord.create({ workspaceId, agent: "system", feature, provider: "vertex", model: "discovery-engine", endpoint: feature, latencyMs: 0, success, pricingAvailable: false });
  } catch { /* usage ledger is best-effort, never blocks the real sync */ }
}

/** Called when a Knowledge Center note becomes (or stays) status: "approved". No-op, zero cost, if this workspace hasn't opted into Agent Search. */
async function indexApprovedNote(note, dependencies = {}) {
  if (!note?._id || !note?.workspaceId) return { synced: false, reason: "invalid_note" };
  if (!(await capabilityReady(note.workspaceId, dependencies))) return { synced: false, reason: "disabled" };
  try {
    await discoveryEngineService.upsertDocument({ docId: docId(note.workspaceId, note._id), workspaceId: note.workspaceId, title: note.title, content: note.content, structData: { category: note.category || "", path: note.path || "", approvedAt: note.approvedAt ? new Date(note.approvedAt).toISOString() : "" } }, dependencies);
    await logIndexUsage(note.workspaceId, "agent_search_index", true, dependencies.models);
    await auditService.record({ workspaceId: note.workspaceId, action: "vertex.agent_search.indexed", targetType: "JarvisMemoryNote", targetId: note._id, success: true });
    return { synced: true };
  } catch (error) {
    await logIndexUsage(note.workspaceId, "agent_search_index", false, dependencies.models);
    await auditService.record({ workspaceId: note.workspaceId, action: "vertex.agent_search.indexed", targetType: "JarvisMemoryNote", targetId: note._id, success: false, metadata: { errorMessage: error.message } });
    console.warn("[Discovery Engine sync] indexing failed — Knowledge Center action itself was NOT blocked", { code: error.code || "DISCOVERY_ENGINE_INDEX_FAILED" });
    return { synced: false, reason: error.code || "index_failed" };
  }
}

/** Called when a note is rejected, archived, restored-to-draft, or a change flips it out of "approved". No-op if never indexed / not opted in. */
async function removeNote(note, dependencies = {}) {
  if (!note?._id || !note?.workspaceId) return { synced: false, reason: "invalid_note" };
  if (!(await capabilityReady(note.workspaceId, dependencies))) return { synced: false, reason: "disabled" };
  try {
    await discoveryEngineService.deleteDocument({ docId: docId(note.workspaceId, note._id) }, dependencies);
    await logIndexUsage(note.workspaceId, "agent_search_remove", true, dependencies.models);
    await auditService.record({ workspaceId: note.workspaceId, action: "vertex.agent_search.removed", targetType: "JarvisMemoryNote", targetId: note._id, success: true });
    return { synced: true };
  } catch (error) {
    await logIndexUsage(note.workspaceId, "agent_search_remove", false, dependencies.models);
    await auditService.record({ workspaceId: note.workspaceId, action: "vertex.agent_search.removed", targetType: "JarvisMemoryNote", targetId: note._id, success: false, metadata: { errorMessage: error.message } });
    console.warn("[Discovery Engine sync] removal failed — Knowledge Center action itself was NOT blocked", { code: error.code || "DISCOVERY_ENGINE_REMOVE_FAILED" });
    return { synced: false, reason: error.code || "remove_failed" };
  }
}

/**
 * Explicit full revocation: purges every document this workspace has ever
 * had indexed, regardless of current opt-in state (a workspace turning
 * Agent Search off should be able to have its data actually removed from
 * Google's infrastructure, not just stop being queried). Requires the
 * platform/master switches to still be on (the purge call itself needs a
 * configured Discovery Engine data store to reach) but NOT the per-workspace
 * opt-in — a workspace revoking access must still be able to purge.
 */
async function purgeWorkspace(workspaceId, actorUserId = null, dependencies = {}) {
  if (!discoveryEngineService.masterEnabled()) throw Object.assign(new Error("Vertex AI is not enabled"), { code: "VERTEX_DISABLED" });
  const operation = await discoveryEngineService.purgeWorkspaceDocuments(workspaceId, dependencies);
  await auditService.record({ workspaceId, actorUserId, action: "vertex.agent_search.workspace_purged", targetType: "Workspace", targetId: workspaceId, after: { operationName: operation.operationName }, success: true });
  return operation;
}

/** Real, indexed Agent Search over this workspace's own approved documents — gated by the full platform+workspace+budget chain. */
async function search({ workspaceId, userId = null, query, correlationId = "" } = {}, dependencies = {}) {
  if (!discoveryEngineService.masterEnabled()) throw Object.assign(new Error("Vertex AI is not enabled. Set VERTEX_ENABLED=true and configure Google Cloud credentials to use any Vertex capability."), { code: "VERTEX_DISABLED" });
  if (!discoveryEngineService.agentSearchPlatformEnabled()) throw Object.assign(new Error("Vertex Agent Search is not enabled at the platform level. Set VERTEX_AGENT_SEARCH_ENABLED=true."), { code: "VERTEX_AGENT_SEARCH_DISABLED" });
  const platformOk = await (dependencies.vertexPlatformAvailable || require("./platformConfigService").vertexPlatformAvailable)();
  if (!platformOk) throw Object.assign(new Error("A platform administrator has turned off Vertex AI availability."), { code: "VERTEX_PLATFORM_UNAVAILABLE" });
  await vertexConfigService.assertCapabilityEnabled({ workspaceId, capability: "agentSearchEnabled" }, dependencies);
  if (!String(query || "").trim()) throw Object.assign(new Error("A query is required"), { code: "VERTEX_QUERY_REQUIRED" });
  const started = Date.now();
  try {
    const { results } = await (dependencies.discoveryEngineSearch || discoveryEngineService.search)({ workspaceId, query }, dependencies);
    const seen = new Set();
    const deduped = results.filter((row) => (seen.has(row.documentId) ? false : (seen.add(row.documentId), true)));
    await (dependencies.models?.AiUsageRecord || AiUsageRecord).create({ workspaceId, userId, agent: "research", feature: "agent_search_query", provider: "vertex", model: "discovery-engine", endpoint: "search", latencyMs: Date.now() - started, success: true, pricingAvailable: false, correlationId: String(correlationId || "").slice(0, 255) }).catch(() => {});
    return {
      matched: deduped.length > 0,
      citations: deduped.map((row) => ({ title: row.title, link: row.link, snippet: row.snippet })),
      results: deduped,
    };
  } catch (error) {
    await (dependencies.models?.AiUsageRecord || AiUsageRecord).create({ workspaceId, userId, agent: "research", feature: "agent_search_query", provider: "vertex", model: "discovery-engine", endpoint: "search", latencyMs: Date.now() - started, success: false, pricingAvailable: false, errorCode: String(error.code || "DISCOVERY_ENGINE_SEARCH_FAILED").slice(0, 120), correlationId: String(correlationId || "").slice(0, 255) }).catch(() => {});
    throw error;
  }
}

module.exports = { docId, indexApprovedNote, removeNote, purgeWorkspace, search };
