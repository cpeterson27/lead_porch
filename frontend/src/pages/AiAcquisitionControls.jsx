import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import StatCard from "../components/StatCard.jsx";
import useAuth from "../context/useAuth.js";
import { hasRole } from "../utils/roleAccess.js";
import {
  fetchAiConfig,
  updateAiConfig,
  fetchAiUsageSummary,
  fetchGeminiConfig,
  updateGeminiConfig,
  fetchVertexConfig,
  updateVertexConfig,
  runVertexGrounding,
  runVertexAgentSearch,
  purgeVertexAgentSearchIndex,
  fetchProvidersHealth,
  pauseAllAiAndAcquisition,
  fetchPlatformProviderAvailability,
  updatePlatformProviderAvailability,
  fetchResearchMonitors,
  updateResearchMonitor,
  runResearchMonitor,
} from "../services/api.js";
import "./AiAcquisitionControls.css";

const AGENT_LABELS = {
  jarvis: "Jarvis",
  lead: "Lead",
  social: "Social",
  sales: "Sales",
  content: "Content",
  coaching: "Coaching",
  research: "Research",
  system: "System",
};

const PROVIDER_LABELS = { openai: "OpenAI", gemini: "Gemini", vertex: "Vertex AI" };
const ENDPOINT_LABELS = {
  "chat.completions": "Chat Completions",
  responses: "Responses (incl. web search)",
  "images.generate": "Images",
  generateContent: "Generate Content",
  search: "Search",
};
function endpointLabel(endpoint) { return ENDPOINT_LABELS[endpoint] || endpoint; }

function money(value) {
  if (value == null) return "—";
  return `$${Number(value).toFixed(2)}`;
}

function ProviderStatus({ label, status }) {
  if (!status) return null;
  const configured = status.configured ?? status.enabled;
  const state = !configured
    ? { text: "Not connected", tone: "off" }
    : !status.enabled
      ? { text: "Connected setup · inactive", tone: "off" }
    : status.healthy
      ? { text: "Connected", tone: "on" }
      : { text: "Needs attention", tone: "warn" };
  return (
    <div className="provider-status-row">
      <span><strong>{label}</strong><small>{status.reason === "disabled" ? "Connection details are saved, but this provider is not currently available to agents." : status.reason || (state.tone === "on" ? "Configuration found and health check passed." : configured ? "Connection details exist, but this provider is inactive." : "No usable configuration was detected for this provider.")}</small></span>
      <span className={`provider-status-pill provider-status-pill--${state.tone}`}>{state.text}</span>
    </div>
  );
}

export default function AiAcquisitionControls() {
  const { session } = useAuth();
  const [aiConfig, setAiConfig] = useState(null);
  const [usage, setUsage] = useState(null);
  const [geminiConfig, setGeminiConfig] = useState(null);
  const [vertexConfig, setVertexConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [platformAvailability, setPlatformAvailability] = useState(null);
  const [monitors, setMonitors] = useState([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [checkingConnections, setCheckingConnections] = useState(false);
  const [groundingQuery, setGroundingQuery] = useState("");
  const [groundingResult, setGroundingResult] = useState(null);
  const [groundingBusy, setGroundingBusy] = useState(false);
  const [groundingError, setGroundingError] = useState("");
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [agentSearchResult, setAgentSearchResult] = useState(null);
  const [agentSearchBusy, setAgentSearchBusy] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeConfirmText, setPurgeConfirmText] = useState("");

  const load = useCallback(() => {
    const requests = [
      fetchAiConfig().then((res) => setAiConfig(res.data)),
      fetchAiUsageSummary().then((res) => setUsage(res.data)),
      fetchGeminiConfig().then((res) => setGeminiConfig(res.data)),
      fetchVertexConfig().then((res) => setVertexConfig(res.data)),
      fetchProvidersHealth().then((res) => setHealth(res.data)),
      fetchResearchMonitors().then((res) => setMonitors(res.monitors || res.data || [])),
    ];
    if (session?.isPlatformOwner) {
      requests.push(
        fetchPlatformProviderAvailability().then((res) => setPlatformAvailability(res.data)),
      );
    }
    Promise.all(requests).catch((err) =>
      setError(err.response?.data?.error || "Unable to load AI & Acquisition Controls."),
    );
  }, [session?.isPlatformOwner]);

  useEffect(() => { load(); }, [load]);

  const checkConnections = async () => {
    setCheckingConnections(true);
    setError("");
    setNotice("");
    try {
      const res = await fetchProvidersHealth();
      setHealth(res.data);
      setNotice("Provider connections checked just now.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to check provider connections.");
    } finally {
      setCheckingConnections(false);
    }
  };

  const saveAiConfig = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const res = await updateAiConfig(patch);
      setAiConfig(res.data);
      setNotice("AI settings saved.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save AI settings.");
    } finally {
      setSaving(false);
    }
  };

  const saveGeminiConfig = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const res = await updateGeminiConfig(patch);
      setGeminiConfig(res.data);
      setNotice("Gemini settings saved.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save Gemini settings.");
    } finally {
      setSaving(false);
    }
  };

  const saveVertexConfig = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const res = await updateVertexConfig(patch);
      setVertexConfig(res.data);
      setNotice("Vertex AI settings saved.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save Vertex AI settings.");
    } finally {
      setSaving(false);
    }
  };

  const tryGrounding = async () => {
    if (!groundingQuery.trim() || groundingBusy) return;
    setGroundingBusy(true);
    setGroundingError("");
    setGroundingResult(null);
    try {
      const res = await runVertexGrounding({ query: groundingQuery });
      setGroundingResult(res.data);
    } catch (err) {
      // The backend already sanitizes real provider/timeout failures before
      // they reach here (services/vertexGroundingService.js) — a message on
      // the response body is safe to show as-is. A response-less error means
      // even OUR OWN 90s client-side timeout gave up without the backend
      // replying at all (e.g. a hung connection), which needs its own
      // friendly text since there is no server message to show.
      const message = err.response?.data?.error
        || (err.code === "ECONNABORTED"
          ? "This is taking longer than expected. Vertex grounding can take up to a minute or so for complex queries — please try again."
          : "Vertex grounding request failed. Please try again.");
      setGroundingError(message);
    } finally {
      setGroundingBusy(false);
    }
  };

  const tryAgentSearch = async () => {
    if (!agentSearchQuery.trim()) return;
    setAgentSearchBusy(true);
    setError("");
    setAgentSearchResult(null);
    try {
      const res = await runVertexAgentSearch({ query: agentSearchQuery });
      setAgentSearchResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || "Vertex Agent Search request failed.");
    } finally {
      setAgentSearchBusy(false);
    }
  };

  const openPurgeConfirm = () => {
    setPurgeConfirmOpen(true);
    setPurgeConfirmText("");
    setError("");
  };

  const cancelPurgeConfirm = () => {
    setPurgeConfirmOpen(false);
    setPurgeConfirmText("");
  };

  const confirmPurgeAgentSearchIndex = async () => {
    if (purgeConfirmText !== "PURGE") return;
    setSaving(true);
    setError("");
    try {
      await purgeVertexAgentSearchIndex();
      setNotice("Purge request sent to Google. It may take a few minutes to complete.");
      setPurgeConfirmOpen(false);
      setPurgeConfirmText("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to purge the Vertex AI Search index.");
    } finally {
      setSaving(false);
    }
  };

  const savePlatformAvailability = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const res = await updatePlatformProviderAvailability(patch);
      setPlatformAvailability(res.data);
      setNotice("Platform provider availability saved.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save platform provider availability.");
    } finally {
      setSaving(false);
    }
  };

  const toggleMonitor = async (monitor) => {
    setError("");
    try {
      await updateResearchMonitor(monitor._id, { enabled: !monitor.enabled });
      setMonitors((rows) => rows.map((row) => (row._id === monitor._id ? { ...row, enabled: !row.enabled } : row)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update that monitor.");
    }
  };

  const runNow = async (monitor) => {
    setError("");
    try {
      await runResearchMonitor(monitor._id);
      setNotice(`${monitor.name} was queued to run now.`);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to queue that monitor.");
    }
  };

  const pauseAll = async () => {
    if (!window.confirm("Pause all AI generation and discovery monitors for this workspace? This can be turned back on at any time.")) return;
    setSaving(true);
    setError("");
    try {
      const res = await pauseAllAiAndAcquisition();
      setNotice(`Paused. ${res.data.monitorsDisabled} monitor(s) disabled.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to pause AI and acquisition.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-controls-page">
      <header className="ai-controls-header">
        <p className="page-eyebrow">Workspace operations</p>
        <h1>Usage & Agents</h1>
        <p>
          See what your AI agents are using, where the usage came from, and what it is estimated
          to cost. Provider controls and safety limits are kept together below.
        </p>
        <Link to="/settings/workspace">Back to Settings</Link>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      {usage ? <section className="ai-usage-command" aria-label="Monthly AI usage overview">
        <div className="ai-usage-command__summary">
          <span>This month</span>
          <strong>{money(usage.estimatedTotalCostUsd)}</strong>
          <p>Tracked in Lead Porch this month across {usage.requestCount} request{usage.requestCount === 1 ? "" : "s"}.</p>
        </div>
        <div className="ai-usage-command__metrics">
          <article><span>Total tokens</span><strong>{usage.tokens?.total?.toLocaleString?.() || 0}</strong><small>{usage.tokens?.input?.toLocaleString?.() || 0} input · {usage.tokens?.output?.toLocaleString?.() || 0} output{usage.tokens?.reasoning ? ` · ${usage.tokens.reasoning.toLocaleString()} reasoning` : ""}</small></article>
          <article><span>Successful requests</span><strong>{usage.successCount || 0}</strong><small>{usage.failureCount || 0} failed</small></article>
          <article><span>Tracked agents</span><strong>{usage.byAgent?.length || 0}</strong><small>Usage is attributed below</small></article>
        </div>
        <div className="ai-usage-provider-grid" aria-label="Usage by provider and capability, grouped like OpenAI's own usage dashboard">
          {usage.byProviderEndpoint?.length ? [...usage.byProviderEndpoint].sort((a, b) => b.estimatedTotalCostUsd - a.estimatedTotalCostUsd).map((row) => <article key={row.key}>
            <span className="ai-usage-provider-grid__provider">{PROVIDER_LABELS[row.provider] || row.provider}</span>
            <strong>{endpointLabel(row.endpoint)}</strong>
            <span>{row.requestCount} request{row.requestCount === 1 ? "" : "s"}</span>
            <span>{row.totalTokens.toLocaleString()} tokens</span>
            <b>{money(row.estimatedTotalCostUsd)}</b>
          </article>) : <p>No AI usage has been recorded this month.</p>}
        </div>
        <div className="ai-agent-ledger">
          <header><strong>Usage by agent</strong><span>Requests · tokens · estimated cost</span></header>
          {usage.byAgent?.length ? [...usage.byAgent].sort((a, b) => b.estimatedTotalCostUsd - a.estimatedTotalCostUsd).map((agent) => <div key={agent.key}>
            <strong>{AGENT_LABELS[agent.key] || agent.key}</strong>
            <span>{agent.requestCount} request{agent.requestCount === 1 ? "" : "s"}</span>
            <span>{agent.totalTokens.toLocaleString()} tokens</span>
            <b>{money(agent.estimatedTotalCostUsd)}</b>
          </div>) : <p>No AI usage has been recorded this month.</p>}
        </div>
        <p className="ai-usage-command__note"><strong>This is not your provider billing total.</strong> It includes only AI requests recorded by Lead Porch during the current month. Requests made before usage tracking existed, direct provider-dashboard usage, image charges without returned pricing, and Apollo, PDL, Gemini, Vertex, or other external credit balances may be absent. {usage.unpricedRequestCount || 0} tracked request{usage.unpricedRequestCount === 1 ? " has" : "s have"} no price available.</p>
      </section> : null}

      <DashboardCard
        title="Emergency stop"
        action={<Button variant="danger" loading={saving} onClick={pauseAll}>Pause All</Button>}
      >
        <p>
          Immediately disables OpenAI, both Gemini capabilities, both Vertex AI capabilities, and
          every enabled discovery monitor for this workspace. Nothing is deleted — turn any of
          them back on individually below, at any time.
        </p>
      </DashboardCard>

      <DashboardCard title="Provider connections" action={<Button variant="outline" size="sm" loading={checkingConnections} onClick={checkConnections}>{checkingConnections ? "Checking…" : "Check again"}</Button>}>
        <p className="provider-health-explainer">These are provider connections, not the on/off state of Jarvis or your other agents. “Connected setup · inactive” means credentials were found, but the server-side provider switch is currently off.</p>
        {health ? (
          <div className="provider-status-grid">
            <ProviderStatus label="OpenAI" status={{ enabled: health.openai?.enabled, healthy: health.openai?.enabled, reason: health.openai?.configured ? "" : "not configured" }} />
            <ProviderStatus label="Gemini" status={health.gemini} />
            <ProviderStatus label="Vertex AI Grounding" status={health.vertexGrounding} />
            <ProviderStatus label="Vertex AI Search (Agent Search)" status={health.discoveryEngineAgentSearch} />
            <ProviderStatus label="Apollo" status={health.apollo} />
            <ProviderStatus label="People Data Labs" status={health.peopleDataLabs} />
            <ProviderStatus label="Emailable" status={{ enabled: health.emailable?.enabled, healthy: health.emailable?.enabled, reason: health.emailable?.configured ? "" : "not configured" }} />
          </div>
        ) : (
          <p>Loading…</p>
        )}
      </DashboardCard>

      {aiConfig ? (
        <DashboardCard title="OpenAI (Jarvis and all agents)">
          <label className="ai-controls-toggle">
            <input
              type="checkbox"
              checked={aiConfig.enabled}
              onChange={(e) => saveAiConfig({ enabled: e.target.checked })}
            />
            Enabled for this workspace
          </label>
          <label>
            Monthly spending limit (USD, blank = no limit)
            <input
              type="number"
              min="0"
              step="0.01"
              value={aiConfig.monthlyLimitUsd ?? ""}
              onChange={(e) => saveAiConfig({ monthlyLimitUsd: e.target.value === "" ? null : e.target.value })}
            />
          </label>
          <fieldset className="ai-controls-agents">
            <legend>Per-agent enable</legend>
            {Object.keys(aiConfig.agentEnabled || {}).map((agent) => (
              <label key={agent}>
                <input
                  type="checkbox"
                  checked={aiConfig.agentEnabled[agent]}
                  onChange={(e) =>
                    saveAiConfig({ agentEnabled: { ...aiConfig.agentEnabled, [agent]: e.target.checked } })
                  }
                />
                {AGENT_LABELS[agent] || agent}
              </label>
            ))}
          </fieldset>
          {usage ? (
            <div className="ai-controls-usage">
              <StatCard title="This month's tracked AI spend" value={money(usage.estimatedTotalCostUsd)} subtitle={`${usage.requestCount} request(s) across OpenAI, Gemini, and Vertex`} />
              <StatCard title="Tokens used" value={usage.tokens?.total?.toLocaleString?.() || 0} subtitle={`${usage.tokens?.input || 0} in / ${usage.tokens?.output || 0} out${usage.tokens?.reasoning ? ` / ${usage.tokens.reasoning} reasoning` : ""}`} />
              <StatCard title="Success rate" value={usage.requestCount ? `${Math.round((usage.successCount / usage.requestCount) * 100)}%` : "—"} subtitle={`${usage.failureCount} failed`} />
            </div>
          ) : null}
        </DashboardCard>
      ) : null}

      {geminiConfig ? (
        <DashboardCard title="Google Gemini — Developer API (optional)">
          <p>
            Two independent capabilities. Workspace Context answers questions from this
            workspace's own approved content only (never the open web, and not a search index —
            for a real indexed search over your documents, see Vertex AI Search below); Grounding
            does controlled public-web discovery via Google Search, always with citations. Both
            require a platform administrator to have configured real credentials — this
            workspace's toggles below only control whether YOUR workspace uses them.
          </p>
          <label className="ai-controls-toggle">
            <input
              type="checkbox"
              checked={geminiConfig.workspaceContextEnabled}
              onChange={(e) => saveGeminiConfig({ workspaceContextEnabled: e.target.checked })}
            />
            Workspace Context enabled (answers only from this workspace's approved knowledge)
          </label>
          <label className="ai-controls-toggle">
            <input
              type="checkbox"
              checked={geminiConfig.groundingEnabled}
              onChange={(e) => saveGeminiConfig({ groundingEnabled: e.target.checked })}
            />
            Grounding enabled (public-web discovery with citations)
          </label>
          <label>
            Monthly spending limit (USD, blank = no limit)
            <input
              type="number"
              min="0"
              step="0.01"
              value={geminiConfig.monthlyLimitUsd ?? ""}
              onChange={(e) => saveGeminiConfig({ monthlyLimitUsd: e.target.value === "" ? null : e.target.value })}
            />
          </label>
        </DashboardCard>
      ) : null}

      {vertexConfig ? (
        <DashboardCard title="Google Vertex AI (optional)">
          <p>
            A separate Google product from the Gemini Developer API above, authenticated with a
            server-side Google Cloud service account (never a frontend credential). Grounding uses
            Vertex Gemini + real Google Search grounding. Agent Search is a real indexed search
            over this workspace's own approved Knowledge Center documents via Vertex AI Search
            (Discovery Engine) — every document is tagged with this workspace's ID and every
            search is filtered to it server-side, so no other workspace's documents are ever
            returned. Both require a platform administrator to have configured a real Google Cloud
            project — these toggles only control whether YOUR workspace uses them.
          </p>
          <label className="ai-controls-toggle">
            <input
              type="checkbox"
              checked={vertexConfig.groundingEnabled}
              onChange={(e) => saveVertexConfig({ groundingEnabled: e.target.checked })}
            />
            Grounding enabled (Vertex AI Gemini + Google Search, with citations)
          </label>
          <label className="ai-controls-toggle">
            <input
              type="checkbox"
              checked={vertexConfig.agentSearchEnabled}
              onChange={(e) => saveVertexConfig({ agentSearchEnabled: e.target.checked })}
            />
            Agent Search enabled (real indexed search over this workspace's approved documents)
          </label>
          <label>
            Monthly spending limit (USD, blank = no limit)
            <input
              type="number"
              min="0"
              step="0.01"
              value={vertexConfig.monthlyLimitUsd ?? ""}
              onChange={(e) => saveVertexConfig({ monthlyLimitUsd: e.target.value === "" ? null : e.target.value })}
            />
          </label>

          {vertexConfig.groundingEnabled ? (
            <div className="ai-controls-try-it">
              <label>
                Try Vertex Grounding
                <input type="text" value={groundingQuery} onChange={(e) => setGroundingQuery(e.target.value)} placeholder="e.g. real estate investor meetups near Denver" disabled={groundingBusy} />
              </label>
              <Button size="sm" variant="outline" loading={groundingBusy} disabled={groundingBusy} onClick={tryGrounding}>
                {groundingBusy ? "Searching (can take up to a minute)…" : "Search"}
              </Button>
              {groundingError ? <p className="form-error ai-controls-try-it-error">{groundingError}</p> : null}
              {groundingResult ? (
                <>
                  <ul className="ai-controls-try-it-results">
                    {groundingResult.results?.length ? groundingResult.results.map((row, index) => (
                      <li key={index}>
                        <strong>{row.name}</strong> ({row.type}, {row.confidence}) — {row.summary}
                        <div className="ai-controls-citations">{row.evidenceUrls?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</div>
                      </li>
                    )) : <li>No confident, citable results.</li>}
                  </ul>
                  {groundingResult.groundingCitations?.length ? (
                    <div className="ai-controls-grounding-citations">
                      <strong>Grounded on:</strong>
                      <div className="ai-controls-citations">
                        {groundingResult.groundingCitations.map((citation, index) => (
                          <a key={`${citation.url}-${index}`} href={citation.url} target="_blank" rel="noreferrer">{citation.title || citation.url}</a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {vertexConfig.agentSearchEnabled ? (
            <div className="ai-controls-try-it">
              <label>
                Try Agent Search
                <input type="text" value={agentSearchQuery} onChange={(e) => setAgentSearchQuery(e.target.value)} placeholder="e.g. onboarding SOP" />
              </label>
              <Button size="sm" variant="outline" loading={agentSearchBusy} onClick={tryAgentSearch}>Search</Button>
              {agentSearchResult ? (
                <ul className="ai-controls-try-it-results">
                  {agentSearchResult.citations?.length ? agentSearchResult.citations.map((row, index) => (
                    <li key={index}>
                      <strong>{row.title}</strong>
                      <p>{row.snippet}</p>
                    </li>
                  )) : <li>No approved documents matched.</li>}
                </ul>
              ) : null}
            </div>
          ) : null}

          {hasRole(session, "owner") ? (
            <details className="ai-controls-danger-zone">
              <summary>Danger zone</summary>
              <div className="ai-controls-danger-zone-body">
                <p>
                  Permanently deletes every Knowledge Center document this workspace has indexed
                  in Vertex AI Search. This sends a real deletion request to Google and cannot be
                  undone. It does not change any toggle above or disable Agent Search — it only
                  removes already-indexed data, which will need to be re-indexed (or backfilled)
                  before search results return anything again.
                </p>
                {!purgeConfirmOpen ? (
                  <Button size="sm" variant="danger" onClick={openPurgeConfirm}>Purge indexed data</Button>
                ) : (
                  <div className="ai-controls-danger-confirm">
                    <label>
                      Type PURGE to confirm
                      <input
                        type="text"
                        value={purgeConfirmText}
                        onChange={(e) => setPurgeConfirmText(e.target.value)}
                        placeholder="PURGE"
                        autoComplete="off"
                      />
                    </label>
                    <div className="ai-controls-danger-confirm-actions">
                      <Button size="sm" variant="outline" onClick={cancelPurgeConfirm}>Cancel</Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={saving}
                        disabled={purgeConfirmText !== "PURGE"}
                        onClick={confirmPurgeAgentSearchIndex}
                      >
                        Confirm purge
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </details>
          ) : null}
        </DashboardCard>
      ) : null}

      <DashboardCard title="Discovery monitors" action={<Link to="/discovery">Manage sources & create monitors</Link>}>
        {monitors.length ? (
          <table className="ai-controls-monitor-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <tr key={monitor._id}>
                  <td>{monitor.name}</td>
                  <td>{monitor.monitorType?.replaceAll("_", " ")}</td>
                  <td>
                    <label className="ai-controls-toggle ai-controls-toggle--inline">
                      <input type="checkbox" checked={monitor.enabled} onChange={() => toggleMonitor(monitor)} />
                      {monitor.enabled ? "Enabled" : "Disabled"}
                    </label>
                  </td>
                  <td>{monitor.lastRunStatus || "never run"}</td>
                  <td>
                    <Button size="sm" variant="outline" onClick={() => runNow(monitor)}>Run now</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No discovery monitors yet.</p>
        )}
      </DashboardCard>

      {session?.isPlatformOwner ? (
        <DashboardCard title="Platform administration" className="ai-controls-platform-card">
          <p>Controls global provider availability across every workspace on this server.</p>
          {platformAvailability ? (
            <label className="ai-controls-toggle">
              <input
                type="checkbox"
                checked={platformAvailability.providerAvailability?.gemini}
                onChange={(e) =>
                  savePlatformAvailability({ providerAvailability: { gemini: e.target.checked } })
                }
              />
              Gemini available platform-wide
            </label>
          ) : (
            <p>Loading…</p>
          )}
          {platformAvailability ? (
            <label className="ai-controls-toggle">
              <input
                type="checkbox"
                checked={platformAvailability.providerAvailability?.vertex}
                onChange={(e) =>
                  savePlatformAvailability({ providerAvailability: { vertex: e.target.checked } })
                }
              />
              Vertex AI available platform-wide
            </label>
          ) : (
            <p>Loading…</p>
          )}
        </DashboardCard>
      ) : null}
    </div>
  );
}
