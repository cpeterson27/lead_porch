/**
 * Low-level Discovery Engine (Vertex AI Search) REST client: search, and
 * document create/update/delete/purge against ONE shared data store +
 * engine for the whole app. Tenant isolation is enforced here, not by
 * separate Google Cloud infrastructure per workspace (that would mean
 * dynamically provisioning a data store per tenant, which Discovery Engine
 * does not cheaply support at scale) — every document this app writes
 * carries a `workspace_id` string in its structData, and every search call
 * below unconditionally appends a server-built `workspace_id: ANY("...")`
 * filter that the CALLER'S workspaceId controls, never user input. This is
 * Google's own documented pattern for multi-tenant Vertex AI Search
 * (https://cloud.google.com/generative-ai-app-builder/docs/filter-search-metadata)
 * and is the same logical-isolation model this app already uses for MongoDB
 * via tenancy/workspacePlugin.js — not physical per-tenant infrastructure.
 *
 * IMPORTANT: this has NOT been exercised against a live Discovery Engine
 * data store (no Google Cloud project is configured in this environment).
 * The exact request/response shapes below follow Google's publicly
 * documented Discovery Engine v1 REST API as of this writing, but must be
 * verified against a real data store before being trusted — see
 * scripts/discovery-engine-smoke-test.js. Do not describe this as
 * "live-tested" until that has actually been run.
 */
const axios = require("axios");
const { withResilience } = require("./providerResilience");
const googleAuthService = require("./googleAuthService");

const CIRCUIT_SEARCH = "discovery_engine_search";
const CIRCUIT_WRITE = "discovery_engine_write";
const clean = (value, length) => String(value || "").trim().slice(0, length);

function masterEnabled() {
  return process.env.VERTEX_ENABLED === "true" && googleAuthService.configured();
}
function agentSearchPlatformEnabled() {
  return masterEnabled() && process.env.VERTEX_AGENT_SEARCH_ENABLED === "true";
}

function config() {
  const project = clean(process.env.VERTEX_PROJECT_ID, 160);
  const location = clean(process.env.DISCOVERY_ENGINE_LOCATION, 60) || "global";
  const collection = clean(process.env.DISCOVERY_ENGINE_COLLECTION_ID, 160) || "default_collection";
  const dataStoreId = clean(process.env.DISCOVERY_ENGINE_DATA_STORE_ID, 160);
  const engineId = clean(process.env.DISCOVERY_ENGINE_ENGINE_ID, 160);
  if (!project || !dataStoreId || !engineId) throw Object.assign(new Error("Discovery Engine project/data store/engine is not fully configured"), { code: "DISCOVERY_ENGINE_CONFIG_MISSING" });
  return { project, location, collection, dataStoreId, engineId };
}

function apiBase(loc) {
  // Discovery Engine requires a location-specific host for any non-"global" location.
  return loc === "global" ? "https://discoveryengine.googleapis.com/v1" : `https://${loc}-discoveryengine.googleapis.com/v1`;
}

async function authHeader(dependencies = {}) {
  const token = await (dependencies.getAccessToken || googleAuthService.getAccessToken)();
  return { Authorization: `Bearer ${token}` };
}

/** Escapes a value for Discovery Engine's filter mini-language string literal. */
function filterLiteral(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function workspaceFilter(workspaceId) {
  return `workspace_id: ANY("${filterLiteral(String(workspaceId))}")`;
}

function documentName(cfg, docId) {
  return `projects/${cfg.project}/locations/${cfg.location}/collections/${cfg.collection}/dataStores/${cfg.dataStoreId}/branches/0/documents/${docId}`;
}

/**
 * Upserts one document. `docId` MUST be globally unique across all
 * workspaces sharing this data store — callers prefix it with the
 * workspaceId (see discoveryEngineSyncService.js) so no two workspaces can
 * ever collide on or overwrite each other's document.
 */
async function upsertDocument({ docId, workspaceId, title, content, structData = {} }, dependencies = {}) {
  const cfg = config();
  const headers = await authHeader(dependencies);
  const http = dependencies.http || axios;
  const body = {
    id: docId,
    structData: { workspace_id: String(workspaceId), title: clean(title, 300), ...structData },
    content: { mimeType: "text/plain", rawBytes: Buffer.from(String(content || ""), "utf8").toString("base64") },
  };
  const url = `${apiBase(cfg.location)}/${documentName(cfg, docId)}?allowMissing=true`;
  return withResilience(CIRCUIT_WRITE, () => http.patch(url, body, { headers, timeout: 20000 }));
}

async function deleteDocument({ docId }, dependencies = {}) {
  const cfg = config();
  const headers = await authHeader(dependencies);
  const http = dependencies.http || axios;
  const url = `${apiBase(cfg.location)}/${documentName(cfg, docId)}`;
  try {
    return await withResilience(CIRCUIT_WRITE, () => http.delete(url, { headers, timeout: 20000 }));
  } catch (error) {
    if (Number(error?.response?.status) === 404) return { data: { alreadyAbsent: true } };
    throw error;
  }
}

/**
 * Kicks off an async purge of every document belonging to one workspace.
 * Discovery Engine's purge endpoint is a long-running operation — this
 * returns the operation name for later polling rather than blocking on
 * completion, since a full-workspace purge can take a while.
 */
async function purgeWorkspaceDocuments(workspaceId, dependencies = {}) {
  const cfg = config();
  const headers = await authHeader(dependencies);
  const http = dependencies.http || axios;
  const parent = `projects/${cfg.project}/locations/${cfg.location}/collections/${cfg.collection}/dataStores/${cfg.dataStoreId}/branches/0`;
  const url = `${apiBase(cfg.location)}/${parent}/documents:purge`;
  const response = await withResilience(CIRCUIT_WRITE, () => http.post(url, { filter: workspaceFilter(workspaceId), force: true }, { headers, timeout: 20000 }));
  return { operationName: response.data?.name || "" };
}

/**
 * Real, indexed search over this workspace's own approved Knowledge Center
 * documents — never another workspace's, enforced by the server-built
 * filter above (never derived from request input).
 */
async function search({ workspaceId, query, pageSize = 10 }, dependencies = {}) {
  const cfg = config();
  const headers = await authHeader(dependencies);
  const http = dependencies.http || axios;
  const url = `${apiBase(cfg.location)}/projects/${cfg.project}/locations/${cfg.location}/collections/${cfg.collection}/engines/${cfg.engineId}/servingConfigs/default_search:search`;
  const body = {
    query: clean(query, 2000),
    pageSize: Math.max(1, Math.min(20, Number(pageSize) || 10)),
    filter: workspaceFilter(workspaceId),
    queryExpansionSpec: { condition: "AUTO" },
    spellCorrectionSpec: { mode: "AUTO" },
  };
  const response = await withResilience(CIRCUIT_SEARCH, () => http.post(url, body, { headers, timeout: 20000 }));
  const results = (response.data?.results || []).map((row) => {
    const derived = row.document?.derivedStructData || {};
    const struct = row.document?.structData || {};
    return {
      documentId: row.document?.id || row.id || "",
      title: derived.title || struct.title || "",
      link: derived.link || "",
      snippet: (derived.snippets || []).map((entry) => entry.snippet).filter(Boolean).join(" … ").slice(0, 1200),
      structData: struct,
    };
  });
  return { results, raw: response.data };
}

/** Read-only, cheap metadata call — confirms auth + resource existence without spending search/query quota. */
async function healthCheck(dependencies = {}) {
  if (!masterEnabled()) return { enabled: false, configured: googleAuthService.configured(), healthy: false, reason: "disabled" };
  try {
    const cfg = config();
    const headers = await authHeader(dependencies);
    const http = dependencies.http || axios;
    const url = `${apiBase(cfg.location)}/projects/${cfg.project}/locations/${cfg.location}/collections/${cfg.collection}/dataStores/${cfg.dataStoreId}`;
    await http.get(url, { headers, timeout: 15000 });
    return { enabled: true, configured: true, healthy: true };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    return { enabled: true, configured: true, healthy: false, reason: status === 401 || status === 403 ? "authentication" : status === 404 ? "not_found" : "unavailable" };
  }
}

module.exports = { masterEnabled, agentSearchPlatformEnabled, config, workspaceFilter, upsertDocument, deleteDocument, purgeWorkspaceDocuments, search, healthCheck };
