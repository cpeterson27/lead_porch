import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import {
  createAudienceDefinition,
  createResearchMonitor,
  deleteResearchMonitor,
  createMarketResearchPlan,
  deleteContact,
  discoverAudienceOrganizations,
  fetchCampaigns,
  fetchContacts,
  fetchDiscoveryTemplates,
  fetchMarketResearchResults,
  fetchMarketResearchHistory,
  fetchPeopleResearchPreviews,
  fetchMarketResearchSources,
  fetchResearchMonitors,
  fetchResearchMonitorPresets,
  fetchResearchActivity,
  fetchResearchNotifications,
  clearResearchNotifications,
  updateResearchNotification,
  fetchIntentSignals,
  fetchMarketResearchJob,
  saveDiscoveryTemplates,
  startExternalMarketResearch,
  runResearchMonitor,
  updateResearchMonitor,
  updateIntentSignal,
  researchIntentSignalIdentity,
  convertIntentSignal,
  generateBiggerPocketsPublicResponse,
  generateIntentEmailDraft,
  updateIntentEmailDraft,
  transferIntentEmailDraft,
  updateContact,
  summarizeWeeklyDiscoveryFindings,
  fetchMonitorPerformance,
  fetchDiscoveryStrategyRecommendations,
  runVertexGroundingDiscoverySearch,
  fetchVertexGroundingResults,
  fetchSuggestedGroundingSearches,
  saveVertexGroundingResult,
  dismissVertexGroundingResult,
  enrichVertexGroundingResultWithPdl,
  rankVertexGroundingResultsForProgramFit,
} from "../services/api.js";
import "./Discovery.css";
import { draftFromMonitorPreset, sourcesFromMonitorPreset } from "../utils/researchMonitorPreset.js";
import "./DiscoveryTargeting.css";
import "./DiscoveryReview.css";
import "./DiscoveryExperience.css";
import "./DiscoveryReliability.css";

const EMPTY_TARGET = {
  name: "",
  industries: "",
  keywords: "",
  locations: "",
  employeeMin: "",
  employeeMax: "",
  revenueMin: "",
  revenueMax: "",
};

const splitValues = (value) => String(value || "")
  .split(/[,;\n]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const MONITOR_SOURCE_DEFAULTS = { buyer_intent: ["bing_web", "reddit_rss"], investor_profile: ["bing_web", "reddit_rss"], community_partner: ["linkedin_public", "facebook_public", "meetup_public", "community_directories", "bing_web"] };
const monitorSources = (type) => [...(MONITOR_SOURCE_DEFAULTS[type] || MONITOR_SOURCE_DEFAULTS.buyer_intent)];
const SOURCE_OPTIONS = [["linkedin_public", "LinkedIn public group/page metadata", "community"], ["facebook_public", "Facebook public group/page metadata", "community"], ["meetup_public", "Meetup public group metadata", "community"], ["community_directories", "REIA and club directories", "community"], ["bing_web", "Bing public web discussions", "all"], ["bing_news", "Bing News · organization context", "nonstudent"], ["sec_form_d", "SEC Form D · experimental, never student intent", "disabled"], ["hacker_news", "Hacker News public discussions", "all"], ["stack_exchange", "Stack Exchange public questions", "all"], ["reddit_rss", "Reddit public discussions · best effort", "all"], ["google_web", "Google · unavailable for new projects", "all"], ["gdelt", "GDELT news · unreliable", "nonstudent"], ["bluesky", "Bluesky public posts · unreliable", "all"], ["duckduckgo", "DuckDuckGo web · unreliable", "all"]];
const UNSTABLE_MONITOR_SOURCES = new Set(["google_web", "gdelt", "bluesky", "duckduckgo"]);

const displayText = (value) => String(value || "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:#32|nbsp);/gi, " ")
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

const publicAccount = (signal) => {
  const raw = `${signal?.authorName || ""} ${signal?.authorUrl || ""}`;
  const reddit = raw.match(/(?:reddit\.com\/user\/|\/?u\/)([A-Za-z0-9_-]+)/i)?.[1];
  if (reddit) return { label: `u/${reddit}`, url: `https://www.reddit.com/user/${reddit}` };
  const label = displayText(signal?.authorName).replace(/https?:\/\/\S+/g, "").trim();
  return { label: label || "No person identified yet", url: /^https:\/\//i.test(signal?.authorUrl || "") ? signal.authorUrl : "" };
};

const identifiedPersonName = (signal) => {
  const name = displayText(signal?.authorName);
  if (!name || /^(?:account not available|no person identified|unknown|anonymous|\/?u\/|@|https?:\/\/)/i.test(name)) return "";
  if (!/^[\p{L}.'’ -]+$/u.test(name) || name.split(/\s+/).length < 2) return "";
  if (/\b(?:llc|l\.l\.c\.|inc\.?|corp\.?|company|fund|partners?|association|community|group|network|club|team|staff|editorial|support|customer service|meetup|linkedin|facebook)\b/i.test(name)) return "";
  return name;
};

const friendlySourceState = (state) => ({ healthy: "Returned results", empty: "Returned no relevant discussions", rate_limited: "Temporarily rate limited", blocked: "Temporarily unavailable", failed: "Waiting for retry", never: "Waiting for first check" }[state] || "Checking");
const sourceAction = (health) => {
  const error = String(health?.lastError || "");
  if (health?.source === "google_web") {
    if (/^(?:401|403)$/.test(error.trim())) return "Google denied API access. Confirm the Custom Search JSON API is enabled and the Render API key restrictions allow this API.";
    if (/api key|key not valid|credential/i.test(error)) return "Google rejected the API key. Check GOOGLE_SEARCH_API_KEY on the Render backend service.";
    if (/custom search|cx|search engine|invalid value/i.test(error)) return "Google rejected the Search Engine ID or its selected-site configuration. Check GOOGLE_SEARCH_ENGINE_ID and Sites to search.";
    if (/quota|daily limit|rate limit|429/i.test(error)) return "Google’s search quota is temporarily exhausted. Other web sources are still running.";
    if (/access not configured|has not been used|disabled/i.test(error)) return "Enable the Custom Search JSON API in the same Google Cloud project as this API key.";
  }
  if (health?.state === "empty") return "The source completed, but the public search index returned no matching pages. Add known public group URLs for direct checking.";
  if (health?.source === "reddit_rss" && health?.state === "rate_limited") return `Reddit asked Lead Porch to slow down. Cached results remain usable and a responsible retry will occur${health.nextScheduledAttempt ? ` after ${new Date(health.nextScheduledAttempt).toLocaleString()}` : " on the next scheduled run"}.`;
  return error || (health?.state === "never" ? "This source has not finished its first check yet." : "This source will be retried on the next scheduled run.");
};
const monitorSourceEnabled = (monitor, source) => source === "feeds" ? Boolean((monitor.feedUrls || []).length) : (monitor.sources || []).includes(source);
const friendlyMonitorMessage = (message) => String(message || "").replace(/;?\s*\d+ source failure\(s\)\.?/i, ". Some optional sources will retry automatically.").replace(/;?\s*\d+ optional source retry\(s\)\.?/i, ". Some optional sources will retry automatically.");
const friendlyActivityMessage = (item) => item.type === "source_failure" ? "An optional source was unavailable and will retry automatically." : friendlyMonitorMessage(item.message);
const monitorGoal = (type) => type === "investor_profile" ? "multifamily-relevant investor prospects" : type === "community_partner" ? "public community-partner candidates" : "individual multifamily student intent";
const monitorAudienceLabel = (type) => type === "investor_profile" ? "Describe the multifamily-relevant investor you want" : type === "community_partner" ? "Describe the community partner you want" : "Describe the multifamily problem or learning signal you want";
const monitorKeywordLabel = (type) => type === "investor_profile" ? "Professional titles and investor phrases" : type === "community_partner" ? "Community and leadership phrases" : "Buying-intent phrases";
const isBiggerPocketsUrl = (value) => { try { return /(^|\.)biggerpockets\.com$/i.test(new URL(value).hostname); } catch { return false; } };
const intentSourceLabel = (signal) => signal.raw?.indexedSourceLabel || String(signal.source || "public web").replaceAll("_", " ");

function IdentityResearchResult({ result, busy, onSelect }) {
  if (!result) return null;
  return <div className={`identity-research-result is-${result.status || "complete"}`} role="status">
    <strong>{result.status === "person_found" ? "Public contact found" : result.status === "choose_person" ? "Choose the correct public contact" : ["error", "source_unavailable"].includes(result.status) ? "Public page could not be checked" : "No public contact listed"}</strong>
    <span>{result.message}</span>
    {result.status === "choose_person" ? <div>{(result.people || []).map((person) => <button type="button" key={`${person.name}-${person.evidenceUrl}`} disabled={busy} onClick={() => onSelect(person)}><b>{person.name}</b>{person.title ? ` · ${person.title}` : ""}<small>Use this evidence-backed person</small></button>)}</div> : null}
  </div>;
}

const examples = [
  "Find multifamily property managers in Florida and Texas with 10–100 employees",
  "Find independent event venues in Sacramento that serve business groups",
  "Find real estate investment firms in the United States focused on acquisitions",
];

function buildAudiencePayload(target) {
  return {
    name: target.name || `Market research · ${new Date().toLocaleDateString()}`,
    description: "Organization research created inside Lead Porch.",
    source: "manual",
    criteria: {
      keywords: splitValues(target.keywords),
      industries: splitValues(target.industries),
      locations: splitValues(target.locations),
      employeeRange: {
        min: target.employeeMin === "" ? null : Number(target.employeeMin),
        max: target.employeeMax === "" ? null : Number(target.employeeMax),
      },
      revenueRange: {
        min: target.revenueMin || null,
        max: target.revenueMax || null,
      },
      minimumScore: 0,
      targetTier: null,
    },
  };
}

export default function Discovery() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [prospects, setProspects] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [target, setTarget] = useState(EMPTY_TARGET);
  const [targetPreset, setTargetPreset] = useState("custom");
  const [marketQuestion, setMarketQuestion] = useState("");
  const [marketPlan, setMarketPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [query, setQuery] = useState("");
  const [emailFilter, setEmailFilter] = useState("verified");
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [researchResult, setResearchResult] = useState(null);
  const [researchOrganizations, setResearchOrganizations] = useState([]);
  const [researchSource, setResearchSource] = useState(null);
  const [externalJob, setExternalJob] = useState(null);
  const [externalRunning, setExternalRunning] = useState(false);
  const [researchHistory, setResearchHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openingHistoryId, setOpeningHistoryId] = useState("");
  const [peoplePreviews, setPeoplePreviews] = useState([]);
  const [peoplePreviewsLoading, setPeoplePreviewsLoading] = useState(false);
  const [openPeoplePreviewId, setOpenPeoplePreviewId] = useState("");
  const [monitors, setMonitors] = useState([]);
  const [intentSignals, setIntentSignals] = useState([]);
  const [discoveryTrack, setDiscoveryTrack] = useState("live_lead");
  const [bucketSummary, setBucketSummary] = useState({ live_lead: 0, watchlist: 0, community_opportunity: 0, rejected: 0 });
  const [trackSignals, setTrackSignals] = useState([]);
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState("");
  const [signalSummary, setSignalSummary] = useState({ total: 0, person: 0, community_partner: 0, organization: 0, intent_signal: 0, public_engagement: 0, needsIdentity: 0, contactReady: 0 });
  const [monitorSaving, setMonitorSaving] = useState(false);
  const [monitorRunningId, setMonitorRunningId] = useState("");
  const [signalBusyId, setSignalBusyId] = useState("");
  const [identityResults, setIdentityResults] = useState({});
  const [activeTab, setActiveTab] = useState(() => searchParams.get("tab") || "company");
  const [monitorPresets, setMonitorPresets] = useState([]);
  const [monitorActivity, setMonitorActivity] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showMonitorSetup, setShowMonitorSetup] = useState(false);
  const [leadView, setLeadView] = useState("new");
  const [opportunityView, setOpportunityView] = useState("all");
  const [monitorPerformance, setMonitorPerformance] = useState(null);
  const [monitorPerformanceLoading, setMonitorPerformanceLoading] = useState(false);
  useEffect(() => {
    if (activeTab !== "monitoring") return;
    let active = true;
    fetchMonitorPerformance()
      .then((data) => { if (active) { setMonitorPerformance(data); setMonitorPerformanceLoading(false); } })
      .catch(() => { if (active) { setMonitorPerformance(null); setMonitorPerformanceLoading(false); } });
    return () => { active = false; };
  }, [activeTab]);
  const [strategy, setStrategy] = useState(null);
  const [strategyBusy, setStrategyBusy] = useState(false);
  const [strategyError, setStrategyError] = useState("");
  const [weeklyBrief, setWeeklyBrief] = useState(null);
  const [weeklyBriefBusy, setWeeklyBriefBusy] = useState(false);
  const [weeklyBriefError, setWeeklyBriefError] = useState("");
  const runWeeklyBrief = async () => {
    setWeeklyBriefBusy(true);
    setWeeklyBriefError("");
    try {
      setWeeklyBrief(await summarizeWeeklyDiscoveryFindings());
    } catch (error) {
      setWeeklyBriefError(error?.response?.data?.error || "Could not generate the weekly Discovery brief.");
    } finally {
      setWeeklyBriefBusy(false);
    }
  };
  const loadMonitorPerformance = async () => {
    setMonitorPerformanceLoading(true);
    try {
      setMonitorPerformance(await fetchMonitorPerformance());
    } catch {
      setMonitorPerformance(null);
    } finally {
      setMonitorPerformanceLoading(false);
    }
  };
  const runStrategyRecommendations = async () => {
    setStrategyBusy(true);
    setStrategyError("");
    try {
      setStrategy(await fetchDiscoveryStrategyRecommendations());
    } catch (error) {
      setStrategyError(error?.response?.data?.error || "Could not generate strategy recommendations.");
    } finally {
      setStrategyBusy(false);
    }
  };
  const [qualityEditingId, setQualityEditingId] = useState("");
  const [qualitySaving, setQualitySaving] = useState(false);
  const [qualityDraft, setQualityDraft] = useState({ query: "", keywords: "", negativeKeywords: "", feedUrls: "" });
  const [peopleSearchPrompt, setPeopleSearchPrompt] = useState("Find 20 named owners, founders, executives, or multifamily principals at real U.S. organizations using public leadership evidence. Treat professional role as identity evidence only, not buyer intent. Keep every result staged for review.");
  const [groundingQuery, setGroundingQuery] = useState("");
  const [groundingTypes, setGroundingTypes] = useState(["person", "organization"]);
  const [groundingSource, setGroundingSource] = useState("both");
  const [groundingBusy, setGroundingBusy] = useState(false);
  const [groundingError, setGroundingError] = useState("");
  const [groundingSourceErrors, setGroundingSourceErrors] = useState([]);
  const [suggestedSearches, setSuggestedSearches] = useState([]);
  const [groundingResults, setGroundingResults] = useState([]);
  const [groundingResultsLoading, setGroundingResultsLoading] = useState(false);
  const [groundingResultsStatus, setGroundingResultsStatus] = useState("pending_review");
  const [pdlEnrichBusyId, setPdlEnrichBusyId] = useState("");
  const [rankBusy, setRankBusy] = useState(false);
  const [selectedGroundingIds, setSelectedGroundingIds] = useState([]);
  const [draftSignal, setDraftSignal] = useState(null);
  const [draftCampaignId, setDraftCampaignId] = useState("");
  const [draftEditor, setDraftEditor] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [socialSignal, setSocialSignal] = useState(null);
  const [socialCampaignId, setSocialCampaignId] = useState("");
  const [socialDraft, setSocialDraft] = useState(null);
  const [biggerPocketsSignal, setBiggerPocketsSignal] = useState(null);
  const [biggerPocketsDraft, setBiggerPocketsDraft] = useState("");
  const [selectedSources, setSelectedSources] = useState(monitorSources("buyer_intent"));
  const [monitorDraft, setMonitorDraft] = useState({
    monitorType: "buyer_intent",
    name: "Ellie multifamily student intent",
    query: "Specific recent public discussions from adults learning multifamily investing, analyzing an early apartment deal, asking for underwriting help, or seeking multifamily mentorship or training",
    keywords: "my first multifamily deal, underwriting help, analyzing my first apartment, calculate NOI, cap rate question, debt service, multifamily mentor, multifamily course, syndication question, raising capital for my deal",
    negativeKeywords: "minor, high school, student assignment, homework, hypothetical, no money, can't afford, job seeker, hiring, promotion, fictional, video game",
    feedUrls: "https://www.biggerpockets.com/forums",
    intervalMinutes: 60,
    intentCategories: [],
  });
  const initialLoadRef = useRef(null);
  const refreshResearchRef = useRef(null);

  useEffect(() => {
    const question = String(searchParams.get("question") || "").trim();
    const tab = String(searchParams.get("tab") || "").trim();
    if (!question && !["company", "monitoring", "leads", "people", "saved"].includes(tab)) return;
    const applyUrlState = window.setTimeout(() => {
      if (question) setMarketQuestion(question);
      if (["company", "monitoring", "leads", "people", "saved"].includes(tab)) setActiveTab(tab);
    }, 0);
    return () => window.clearTimeout(applyUrlState);
  }, [searchParams]);

  useEffect(() => {
    if (!showNotifications) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setShowNotifications(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showNotifications]);

  const loadProspects = async () => {
    const response = await fetchContacts({ status: "prospect", limit: 500 });
    setProspects(Array.isArray(response?.data) ? response.data.filter(Boolean) : []);
  };

  const loadResearchHistory = async () => {
    try {
      setHistoryLoading(true);
      const response = await fetchMarketResearchHistory(50);
      setResearchHistory(response.history || []);
    } catch {
      setNotice("Unable to load saved research history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadGroundingResults = async (status = groundingResultsStatus) => {
    setGroundingResultsLoading(true);
    try {
      const response = await fetchVertexGroundingResults({ status });
      setGroundingResults(response.data || []);
    } catch {
      setNotice("Unable to load Vertex Grounding results.");
    } finally {
      setGroundingResultsLoading(false);
    }
  };

  const loadSuggestedSearches = async () => {
    try {
      const response = await fetchSuggestedGroundingSearches();
      setSuggestedSearches(response.data || []);
    } catch {
      setSuggestedSearches([]);
    }
  };

  const applySuggestedSearch = (suggestion) => {
    setGroundingQuery(suggestion.query);
    setGroundingTypes((current) => current.includes("person") ? current : [...current, "person"]);
  };

  const runGroundingSearch = async () => {
    if (!groundingQuery.trim() || groundingBusy || !groundingTypes.length) return;
    setGroundingBusy(true);
    setGroundingError("");
    setGroundingSourceErrors([]);
    try {
      const response = await runVertexGroundingDiscoverySearch({ query: groundingQuery, resultTypes: groundingTypes, source: groundingSource });
      const staleNote = response.data.excludedForFreshness ? ` ${response.data.excludedForFreshness} person result(s) were excluded for missing or stale (older than ${response.data.personFreshnessDays} days) evidence.` : "";
      setNotice(`Public-web search (${response.data.source}) found ${response.data.total} result(s): ${response.data.created} new, ${response.data.merged} merged into existing pending results.${staleNote}`);
      setGroundingSourceErrors(response.data.sourceErrors || []);
      await loadGroundingResults("pending_review");
      setGroundingResultsStatus("pending_review");
    } catch (err) {
      const message = err.response?.data?.error
        || (err.code === "ECONNABORTED" ? "This is taking longer than expected. Public-web search can take up to a minute — please try again." : "Public-web search failed.");
      setGroundingError(message);
      setGroundingSourceErrors(err.response?.data?.sourceErrors || []);
    } finally {
      setGroundingBusy(false);
    }
  };

  const saveGroundingResult = async (id) => {
    try {
      await saveVertexGroundingResult(id);
      setNotice("Saved with source attribution.");
      loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "Unable to save that result.");
    }
  };

  const dismissGroundingResult = async (id) => {
    try {
      await dismissVertexGroundingResult(id);
      loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "Unable to dismiss that result.");
    }
  };

  const enrichGroundingResultWithPdl = async (id) => {
    if (pdlEnrichBusyId) return;
    setPdlEnrichBusyId(id);
    try {
      const res = await enrichVertexGroundingResultWithPdl(id);
      const outcome = res.data.pdlEnrichment;
      setNotice(
        outcome?.error ? `PDL enrichment error: ${outcome.errorMessage || "unknown error"}`
          : outcome?.matched ? "PDL found a verified match."
            : "PDL did not find a confident match — no email added.",
      );
      await loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "PDL enrichment failed.");
    } finally {
      setPdlEnrichBusyId("");
    }
  };

  const toggleGroundingSelection = (id) => {
    setSelectedGroundingIds((current) => current.includes(id) ? current.filter((row) => row !== id) : [...current, id]);
  };

  const rankSelectedGroundingResults = async () => {
    if (!selectedGroundingIds.length || rankBusy) return;
    setRankBusy(true);
    try {
      const res = await rankVertexGroundingResultsForProgramFit(selectedGroundingIds);
      setNotice(`Ranked ${res.data.ranked} of ${res.data.requested} selected result(s) for program fit.`);
      setSelectedGroundingIds([]);
      loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "Ranking failed.");
    } finally {
      setRankBusy(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "people") return undefined;
    const timer = window.setTimeout(() => { loadGroundingResults(); loadSuggestedSearches(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const loadPeoplePreviews = async () => {
    try {
      setPeoplePreviewsLoading(true);
      const response = await fetchPeopleResearchPreviews(20);
      setPeoplePreviews(response.previews || []);
    } catch {
      setNotice("Unable to load staged people research.");
    } finally {
      setPeoplePreviewsLoading(false);
    }
  };

  const loadAutomaticResearch = async () => {
    try {
      const [monitorResponse, signalResponse, activityResponse, notificationResponse] = await Promise.all([fetchResearchMonitors(), fetchIntentSignals({ limit: 150 }), fetchResearchActivity({ limit: 100 }), fetchResearchNotifications()]);
      setMonitors(monitorResponse.monitors || []);
      setIntentSignals(signalResponse.signals || []);
      setSignalSummary(signalResponse.summary || { total: 0, person: 0, community_partner: 0, organization: 0, intent_signal: 0, needsIdentity: 0, contactReady: 0 });
      setBucketSummary(signalResponse.bucketSummary || { live_lead: 0, watchlist: 0, community_opportunity: 0, rejected: 0 });
      const focusedSignalId = String(searchParams.get("signalId") || "");
      if (focusedSignalId) {
        const focusedSignal = (signalResponse.signals || []).find((item) => String(item._id) === focusedSignalId);
        setActiveTab("leads");
        setLeadView(focusedSignal?.status === "qualified" ? "qualified" : "all");
      }
      setMonitorActivity(activityResponse.activity || []);
      setNotifications(notificationResponse.notifications || []);
    } catch {
      setNotice("Unable to load automatic intent monitoring.");
    }
  };

  const loadDiscoveryTrack = async (track) => {
    setDiscoveryTrack(track);
    if (track === "live_lead") return;
    setTrackLoading(true);
    setTrackError("");
    try {
      const response = await fetchIntentSignals({ bucket: track, limit: 150 });
      setTrackSignals(response.signals || []);
      if (response.bucketSummary) setBucketSummary(response.bucketSummary);
    } catch {
      setTrackError("Unable to load this discovery track.");
    } finally {
      setTrackLoading(false);
    }
  };

  useEffect(() => {
    refreshResearchRef.current = () => {
      loadResearchHistory();
      loadPeoplePreviews();
      loadAutomaticResearch();
    };
    initialLoadRef.current = () => {
      loadProspects().catch(() => setNotice("Unable to load prospects."));
      fetchCampaigns().then((items) => setCampaigns(Array.isArray(items) ? items : [])).catch(() => {});
      fetchDiscoveryTemplates().then((data) => setTemplates(data.templates || [])).catch(() => {});
      fetchMarketResearchSources().then((data) => setResearchSource(data.sources?.[0] || null)).catch(() => {});
      fetchResearchMonitorPresets().then((data) => setMonitorPresets(data.presets || [])).catch(() => {});
      refreshResearchRef.current?.();
    };
  });

  useEffect(() => {
    const initialLoad = window.setTimeout(() => initialLoadRef.current?.(), 0);
    const refreshHistory = window.setInterval(() => {
      refreshResearchRef.current?.();
    }, 15000);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(refreshHistory); };
  }, []);

  const createMonitor = async () => {
    try {
      setMonitorSaving(true);
      await createResearchMonitor({
        ...monitorDraft,
        keywords: splitValues(monitorDraft.keywords),
        negativeKeywords: splitValues(monitorDraft.negativeKeywords),
        locations: ["United States"],
        feedUrls: splitValues(monitorDraft.feedUrls),
        sources: selectedSources,
        maxResultsPerSource: 35,
      });
      setShowMonitorSetup(false);
      setNotice(`First check started now. After it finishes, Lead Porch will check again every ${monitorDraft.intervalMinutes === 60 ? "hour" : `${monitorDraft.intervalMinutes} minutes`}. You do not need to click Run again now.`);
      await loadAutomaticResearch();
    } catch (error) {
      setNotice(error.response?.data?.error || "Unable to start automatic monitoring.");
    } finally { setMonitorSaving(false); }
  };

  const applyMonitorPreset = (preset) => {
    setMonitorDraft(draftFromMonitorPreset(preset));
    setSelectedSources(sourcesFromMonitorPreset(preset, monitorSources(preset.monitorType)));
    setActiveTab("monitoring");
    setNotice(`${preset.name} preset loaded. Every phrase remains editable before you start it.`);
  };

  const toggleDraftSource = (source) => setSelectedSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);

  const toggleExistingSource = async (monitor, source) => {
    const sources = (monitor.sources || []).includes(source) ? monitor.sources.filter((item) => item !== source) : [...(monitor.sources || []), source];
    await updateResearchMonitor(monitor._id, { sources });
    await loadAutomaticResearch();
  };

  const openQualityEditor = (monitor) => {
    setQualityEditingId(String(monitor._id));
    setQualityDraft({ query: monitor.query || "", keywords: (monitor.keywords || []).join("\n"), negativeKeywords: (monitor.negativeKeywords || []).join("\n"), feedUrls: (monitor.feedUrls || []).join("\n") });
  };

  const saveLeadQuality = async (monitor) => {
    try {
      setQualitySaving(true);
      await updateResearchMonitor(monitor._id, { query: qualityDraft.query, keywords: splitValues(qualityDraft.keywords), negativeKeywords: splitValues(qualityDraft.negativeKeywords), feedUrls: splitValues(qualityDraft.feedUrls) });
      await runResearchMonitor(monitor._id);
      setQualityEditingId("");
      setNotice("Lead-quality rules saved. A fresh check is queued with your improved audience definition.");
      await loadAutomaticResearch();
    } catch (error) { setNotice(error.response?.data?.error || "Unable to save the lead-quality rules."); }
    finally { setQualitySaving(false); }
  };

  const markNotificationRead = async (notification) => {
    await updateResearchNotification(notification._id, true);
    setNotifications((items) => items.map((item) => item._id === notification._id ? { ...item, readAt: new Date().toISOString() } : item));
  };

  const openNotification = async (notification) => {
    await markNotificationRead(notification);
    setShowNotifications(false);
    if (notification.actionUrl) {
      navigate(notification.actionUrl);
      return;
    }
    if (["high_score", "published_email", "qualified_lead"].includes(notification.type)) {
      setActiveTab("leads");
      setLeadView(notification.type === "qualified_lead" ? "qualified" : "all");
    } else {
      setActiveTab("monitoring");
    }
  };

  const clearNotifications = async () => {
    await clearResearchNotifications();
    setNotifications([]);
    setShowNotifications(false);
    setNotice("Notifications cleared. Monitoring and leads were not changed.");
  };

  const visibleSignals = intentSignals.filter((signal) => {
    const statusMatches = leadView === "all" ? signal.status !== "dismissed" : signal.status === leadView;
    return statusMatches && (opportunityView === "all" || signal.opportunityType === opportunityView);
  });

  const runMonitorNow = async (monitorId) => {
    try {
      setMonitorRunningId(monitorId);
      await runResearchMonitor(monitorId);
      setNotice("Monitoring run started. Results will appear here automatically.");
      window.setTimeout(loadAutomaticResearch, 5000);
    } catch (error) { setNotice(error.response?.data?.error || "Unable to run this monitor."); }
    finally { setMonitorRunningId(""); }
  };

  const toggleMonitor = async (monitor) => {
    await updateResearchMonitor(monitor._id, { enabled: !monitor.enabled });
    await loadAutomaticResearch();
  };

  const removeMonitor = async (monitor) => {
    if (!window.confirm(`Delete “${monitor.name}”? Saved leads will remain, but this monitor and its activity log will be removed.`)) return;
    try {
      setMonitorRunningId(monitor._id);
      await deleteResearchMonitor(monitor._id);
      setNotice(`Deleted monitor “${monitor.name}”. Saved CRM contacts and leads were not deleted.`);
      await loadAutomaticResearch();
    } catch (error) {
      setNotice(error.response?.data?.error || "Unable to delete this monitor.");
    } finally { setMonitorRunningId(""); }
  };

  const repairMonitorSources = async (monitor) => {
    try {
      setMonitorRunningId(monitor._id);
      await updateResearchMonitor(monitor._id, { sources: monitorSources(monitor.monitorType) });
      await runResearchMonitor(monitor._id);
      setNotice("Source list repaired. A fresh Bing community search is running now. Google was removed because it closed the JSON API to new projects; GDELT, Bluesky, and DuckDuckGo were removed because their public endpoints block or rate-limit automated research.");
      window.setTimeout(loadAutomaticResearch, 3000);
    } catch (error) {
      setNotice(error.response?.data?.error || "Unable to repair this monitor’s sources.");
    } finally { setMonitorRunningId(""); }
  };

  const reviewSignal = async (signal, status) => {
    try {
      setSignalBusyId(signal._id);
      await updateIntentSignal(signal._id, status);
      setNotice(status === "qualified" ? "Saved as a possible lead. Next, review the personalized Deal to Close email draft. Nothing was sent or added to the CRM." : "Removed from your active review queue as not a fit.");
      await loadAutomaticResearch();
      if (status === "qualified") {
        setLeadView("qualified");
        if (identifiedPersonName(signal)) openEmailDraft({ ...signal, status: "qualified" });
        else await researchSignalIdentity({ ...signal, status: "qualified" });
      }
    } finally { setSignalBusyId(""); }
  };

  const addSignalToCrm = async (signal) => {
    const name = identifiedPersonName(signal);
    if (!name) return researchSignalIdentity(signal);
    try {
      setSignalBusyId(signal._id);
      await convertIntentSignal(signal._id, { name, company: signal.identityResolution?.status === "supported" ? (signal.organizationName || signal.organizationDomain || "") : "" });
      setNotice(`${name} was added to the CRM as a needs-research lead. No outreach was sent.`);
      await loadAutomaticResearch();
      await loadProspects();
    } catch (error) { setNotice(error.response?.data?.error || "Unable to add this signal to the CRM."); }
    finally { setSignalBusyId(""); }
  };

  const openEmailDraft = (signal) => {
    const existing = signal.emailDrafts?.[0] || null;
    const eligibleCampaigns = campaigns.filter((campaign) => campaign.campaignKind !== "program");
    setDraftSignal(signal);
    setDraftError("");
    setDraftEditor(existing ? { ...existing } : null);
    setDraftCampaignId(String(existing?.campaignId || eligibleCampaigns[0]?._id || ""));
  };

  const researchSignalIdentity = async (signal, selectedPerson = null) => {
    try {
      setSignalBusyId(signal._id);
      const result = await researchIntentSignalIdentity(signal._id, selectedPerson ? { selectedPerson } : {});
      setIdentityResults((current) => ({ ...current, [signal._id]: result }));
      setNotice(result.message || "Public identity research finished.");
      await loadAutomaticResearch();
    } catch (error) {
      const message = error.response?.data?.error || "Unable to research this public source.";
      setIdentityResults((current) => ({ ...current, [signal._id]: { status: "error", message } }));
      setNotice(message);
    } finally { setSignalBusyId(""); }
  };

  const openRedditDrafts = (signal) => {
    const eligible = campaigns.filter((campaign) => campaign.campaignKind !== "program");
    setSocialSignal(signal);
    setSocialCampaignId(String(eligible[0]?._id || ""));
    setSocialDraft(null);
  };

  const generateRedditDrafts = () => {
    const campaign = campaigns.find((item) => String(item._id) === String(socialCampaignId));
    if (!campaign) return;
    const eventbrite = campaign.registrationLinks?.eventbrite?.url || "";
    const meetup = campaign.registrationLinks?.meetup?.url || "";
    if (!eventbrite || !meetup) return setNotice("Add both Eventbrite and Meetup links to this campaign before creating the private invitation.");
    const topic = displayText(socialSignal?.title) || "what you shared";
    setSocialDraft({ reply: `Your post about “${topic}” caught my attention. We’re hosting an online Deal to Close Bootcamp for people working through similar business and investing decisions. It may be useful for you. If you’d like, I can send the event details—no pressure.`, dm: `Hi—your post about “${topic}” stood out to me. I’m reaching out because we’re hosting an online Deal to Close Bootcamp that may be relevant to what you’re working toward.\n\nYou can review the event on either platform:\nEventbrite: ${eventbrite}\nMeetup: ${meetup}\n\nNo pressure at all—I wanted to share it in case it helps.` });
  };

  const copySocialDraft = async (value, label) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied. Lead Porch did not post or send it.`);
  };

  const openBiggerPocketsResponse = async (signal) => {
    try {
      setSignalBusyId(signal._id);
      const response = await generateBiggerPocketsPublicResponse(signal._id);
      setBiggerPocketsSignal(signal);
      setBiggerPocketsDraft(response.draft || "");
    } catch (error) { setNotice(error.response?.data?.error || "Unable to prepare the non-promotional public response."); }
    finally { setSignalBusyId(""); }
  };

  const copyBiggerPocketsResponse = async () => {
    try {
      const response = await generateBiggerPocketsPublicResponse(biggerPocketsSignal._id, biggerPocketsDraft);
      await navigator.clipboard.writeText(response.draft);
      setNotice("Public response copied for manual review. Lead Porch did not post or message it.");
    } catch (error) { setNotice(error.response?.data?.error || "This response does not meet the BiggerPockets non-promotional policy."); }
  };

  const generateEmailDraft = async () => {
    if (!draftSignal?._id || !draftCampaignId) return;
    try {
      setDraftBusy(true);
      setDraftError("");
      const response = await generateIntentEmailDraft(draftSignal._id, draftCampaignId);
      setDraftEditor(response.draft);
      setNotice("Personalized draft created with both Eventbrite and Meetup links. Nothing was sent.");
    } catch (error) { const message = error.response?.data?.error || "Unable to create the email draft."; setDraftError(message); setNotice(message); }
    finally { setDraftBusy(false); }
  };

  const saveReviewedEmailDraft = async () => {
    if (!draftSignal?._id || !draftEditor?._id) return;
    try {
      setDraftBusy(true);
      setDraftError("");
      const response = await updateIntentEmailDraft(draftSignal._id, draftEditor._id, { subject: draftEditor.subject, body: draftEditor.body, status: "reviewed" });
      setDraftEditor(response.draft);
      setNotice("Draft saved as reviewed. It is still unsent and has not entered Outreach.");
      await loadAutomaticResearch();
    } catch (error) { const message = error.response?.data?.error || "Unable to save the reviewed draft."; setDraftError(message); setNotice(message); }
    finally { setDraftBusy(false); }
  };

  const moveDraftToOutreach = async () => {
    if (!draftSignal?._id || !draftEditor?._id) return;
    try {
      setDraftBusy(true);
      setDraftError("");
      const response = await transferIntentEmailDraft(draftSignal._id, draftEditor._id);
      setNotice(response.message || "Draft moved to Outreach. Nothing was sent.");
      setDraftSignal(null);
      navigate(`/outreach?campaignId=${draftEditor.campaignId}`);
    } catch (error) { const message = error.response?.data?.error || "Unable to move this draft to Outreach."; setDraftError(message); setNotice(message); }
    finally { setDraftBusy(false); }
  };

  useEffect(() => {
    if (window.location.hash !== "#people-research-previews") return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById("people-research-previews")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => window.clearTimeout(scrollTimer);
  }, []);

  const openSavedResearch = async (entry) => {
    try {
      setOpeningHistoryId(String(entry._id));
      const resultList = await fetchMarketResearchResults(entry._id);
      setResearchOrganizations(resultList.organizations || []);
      setResearchResult({
        organizationsFound: resultList.organizations?.length || 0,
        organizationsCreated: entry.job?.statistics?.created || 0,
        organizationsUpdated: entry.job?.statistics?.updated || 0,
      });
      setTarget((current) => ({ ...current, name: entry.name || current.name }));
      setNotice(`Opened ${entry.name}. ${resultList.organizations?.length || 0} ranked organizations are available.`);
      window.setTimeout(() => document.getElementById("ranked-research-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (error) {
      setNotice(error.response?.data?.error || "Unable to open this saved research list.");
    } finally {
      setOpeningHistoryId("");
    }
  };

  const filtered = useMemo(() => prospects.filter((item) => {
    const text = [item?.name, item?.company, item?.email].filter(Boolean).join(" ").toLowerCase();
    return (!query || text.includes(query.toLowerCase()))
      && (!campaignId || item?.campaignIds?.some((id) => String(id) === campaignId))
      && (emailFilter === "all" || (emailFilter === "verified" ? item?.emailStatus === "verified" : item?.emailStatus !== "verified"));
  }), [prospects, query, campaignId, emailFilter]);

  const setField = (field, value) => setTarget((current) => ({ ...current, [field]: value }));

  const buildResearchPlan = async () => {
    if (!marketQuestion.trim()) return;
    try {
      setPlanning(true);
      setNotice("");
      const response = await createMarketResearchPlan(marketQuestion);
      const plan = response.plan;
      setMarketPlan(plan);
      setTarget((current) => ({
        ...current,
        name: plan.name || current.name,
        industries: (plan.criteria?.industries || []).join(", "),
        keywords: (plan.criteria?.keywords || []).join(", "),
        locations: (plan.criteria?.locations || []).join("; "),
        employeeMin: plan.criteria?.employeeRange?.min ?? "",
        employeeMax: plan.criteria?.employeeRange?.max ?? "",
      }));
      setTargetPreset("custom");
      setNotice(plan.compilerWarning || "Research plan created. Review the evidence requirements and criteria before running it.");
    } catch (error) {
      setNotice(error.response?.data?.error || "Lead Porch could not build this research plan.");
    } finally {
      setPlanning(false);
    }
  };

  const selectTemplate = (id) => {
    setTargetPreset(id);
    const template = templates.find((item) => item.id === id);
    setTarget(template ? { ...EMPTY_TARGET, ...template } : { ...EMPTY_TARGET });
  };

  const saveTemplate = async () => {
    const name = target.name.trim();
    if (!name) return setNotice("Name this research profile before saving it.");
    const id = targetPreset === "custom" ? (globalThis.crypto?.randomUUID?.() || `template-${Date.now()}`) : targetPreset;
    const next = targetPreset === "custom"
      ? [...templates, { ...target, id }]
      : templates.map((item) => item.id === id ? { ...target, id } : item);
    try {
      setSavingTemplate(true);
      const data = await saveDiscoveryTemplates(next);
      setTemplates(data.templates || []);
      setTargetPreset(id);
      setNotice("Research profile saved.");
    } catch (error) {
      setNotice(error.response?.data?.error || "Unable to save this research profile.");
    } finally {
      setSavingTemplate(false);
    }
  };

  const runResearch = async () => {
    if (!splitValues(target.industries).length && !splitValues(target.keywords).length) {
      return setNotice("Add at least one industry or business keyword.");
    }
    if (target.employeeMin !== "" && target.employeeMax !== "" && Number(target.employeeMin) > Number(target.employeeMax)) {
      return setNotice("Minimum employees cannot be greater than maximum employees.");
    }
    try {
      setRunning(true);
      setNotice("");
      const created = await createAudienceDefinition(buildAudiencePayload(target));
      const result = await discoverAudienceOrganizations(created.audience._id);
      setResearchResult(result);
      const resultList = await fetchMarketResearchResults(created.audience._id);
      setResearchOrganizations(resultList.organizations || []);
      setNotice(`${result.organizationsFound || 0} organizations found; ${result.organizationsCreated || 0} added and ${result.organizationsUpdated || 0} updated.`);
    } catch (error) {
      setNotice(error.response?.data?.error || "Lead Porch could not complete this research run.");
    } finally {
      setRunning(false);
    }
  };

  const runExternalResearch = async () => {
    if (!marketPlan) return setNotice("Build and review a research plan first.");
    try {
      setExternalRunning(true);
      const response = await startExternalMarketResearch({ question: marketQuestion, plan: marketPlan, maxResults: 1000 });
      setExternalJob(response.job);
      loadResearchHistory();
      if (response.job.status === "source_required") {
        setNotice(response.job.error);
        return;
      }
      setNotice("External research started. You can keep this page open while Lead Porch collects and deduplicates results.");
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const current = await fetchMarketResearchJob(response.job._id);
        setExternalJob(current.job);
        if (["completed", "failed", "source_required"].includes(current.job.status)) {
          if (current.job.status === "completed") {
            const resultList = await fetchMarketResearchResults(current.job.audienceId);
            setResearchOrganizations(resultList.organizations || []);
            setResearchResult({ organizationsFound: current.job.statistics.received, organizationsCreated: current.job.statistics.created, organizationsUpdated: current.job.statistics.updated });
            setNotice(`Research complete: ${current.job.statistics.created} new and ${current.job.statistics.updated} refreshed organizations.`);
            loadResearchHistory();
          } else setNotice(current.job.error || "External research did not complete.");
          break;
        }
      }
    } catch (error) {
      setNotice(error.response?.data?.error || "Lead Porch could not start external research.");
    } finally {
      setExternalRunning(false);
    }
  };

  const exportResearchList = () => {
    if (!researchOrganizations.length) return;
    const headers = ["Company Name", "Website", "Industry", "Location", "Employees", "Fit Score", "Fit Tier", "Evidence URLs", "Last Verified"];
    const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = researchOrganizations.map((organization) => [
      organization.name,
      organization.website || organization.domain,
      organization.industry,
      organization.location,
      organization.employeeCount,
      organization.audienceScore,
      organization.audienceTier,
      (organization.researchEvidence || []).map((evidence) => evidence.sourceUrl).filter(Boolean).join(" | "),
      organization.lastResearchVerifiedAt,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(target.name || "growth-operator-research-list").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const approve = async (prospect) => {
    await updateContact(prospect._id, { status: "active" });
    setProspects((items) => items.filter((item) => item?._id !== prospect._id));
    setNotice("Prospect approved and moved to Contacts.");
  };

  const remove = async () => {
    if (!deleteTarget?._id) return;
    await deleteContact(deleteTarget._id);
    setProspects((items) => items.filter((item) => item?._id !== deleteTarget._id));
    setDeleteTarget(null);
    setNotice("Prospect deleted permanently.");
  };

  return <div className="discovery-page">
    <header className="discovery-header">
      <div><span className="eyebrow">Lead Porch Market Intelligence</span><h1>Find the right companies and buyer intent</h1><p>Five focused workspaces keep company discovery, continuous monitoring, lead decisions, people research, and saved work clear.</p></div>
      <button className="notification-button" type="button" onClick={() => setShowNotifications((value) => !value)} aria-expanded={showNotifications}>Notifications <span>{notifications.filter((item) => !item.readAt).length}</span></button>
    </header>

    {showNotifications ? <div className="notification-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNotifications(false); }}><section className="notification-panel" role="dialog" aria-modal="true" aria-label="Monitoring notifications"><header><div><strong>Notifications</strong><span>{notifications.filter((item) => !item.readAt).length} unread · select one to open its destination</span></div><div className="notification-panel__controls">{notifications.length ? <button type="button" onClick={clearNotifications}>Clear all</button> : null}<button type="button" onClick={() => setShowNotifications(false)} aria-label="Close notifications">Close ×</button></div></header><div className="notification-list">{notifications.length ? notifications.slice(0, 20).map((item) => <button type="button" key={item._id} className={item.readAt ? "is-read" : ""} onClick={() => openNotification(item)}><strong>{item.type === "source_failure" ? "Some sources are retrying" : item.title}</strong><span>{item.type === "source_failure" ? "Other sources still completed. Select this to open monitoring details." : item.message}</span><small>{new Date(item.createdAt).toLocaleString()} · Open {item.actionUrl ? "Privacy requests" : ["high_score", "published_email", "qualified_lead"].includes(item.type) ? "Live Leads" : "Intent Monitoring"}</small></button>) : <p>No notifications yet.</p>}</div></section></div> : null}

    <nav className="discovery-tabs" aria-label="Organization discovery workspaces">{[["company", "Company Discovery"], ["monitoring", "Intent Monitoring"], ["leads", "Live Leads"], ["people", "People Research"], ["saved", "Saved Searches"]].map(([id, label]) => <button key={id} type="button" className={activeTab === id ? "is-active" : ""} onClick={() => setActiveTab(id)}>{label}{id === "leads" && intentSignals.filter((item) => item.status === "new").length ? <span>{intentSignals.filter((item) => item.status === "new").length}</span> : null}</button>)}</nav>

    {notice ? <div className="notice-banner" role="status">{notice}</div> : null}

    {activeTab === "company" ? <><DashboardCard title="Ask Lead Porch to find a market">
      <div className="discovery-agent-prompt">
        <textarea value={marketQuestion} onChange={(event) => setMarketQuestion(event.target.value)} placeholder="Example: Find hair salons in San Francisco with 2+ locations" />
        <Button loading={planning} disabled={!marketQuestion.trim()} onClick={buildResearchPlan}>Build research plan</Button>
      </div>
      <div className="discovery-query-examples">{examples.map((example) => <button key={example} type="button" onClick={() => setMarketQuestion(example)}>{example}</button>)}</div>
      <p className="discovery-safety-note"><strong>Professional standard:</strong> results must show their source and freshness. An email is never labeled verified unless a verification check supports it.</p>
      {marketPlan ? <section className="market-plan-review">
        <header><div><span>{marketPlan.compiler === "openai" ? "AI-structured plan" : "Lead Porch rules-based plan"}</span><strong>{marketPlan.name}</strong></div><small>Review before research</small></header>
        <p>{marketPlan.summary}</p>
        <div><article><strong>Ranking</strong><span>{(marketPlan.rankingDimensions || []).join(" · ")}</span></article><article><strong>Needs attention</strong><span>{[...(marketPlan.assumptions || []), ...(marketPlan.unresolved || [])].join(" ") || "No unresolved criteria."}</span></article></div>
      </section> : null}
    </DashboardCard></> : null}

    {activeTab === "monitoring" ? <><section className="monitoring-guide"><div><span>Runs automatically</span><h2>Monitor specific public signals—not social inboxes</h2><p>Lead Porch checks open-web evidence. Individual student leads require a specific multifamily discussion plus a current learning, problem, or buying signal. Public group metadata is routed to Community Partner discovery. Nothing is contacted or added to CRM automatically.</p></div><ol><li><strong>1</strong><span><b>Search</b>Checks supported public discussions or community metadata while your browser is closed.</span></li><li><strong>2</strong><span><b>Qualify</b>Separates real intent from titles, directories, filings, and promotions.</span></li><li><strong>3</strong><span><b>You decide</b>Review exact evidence and approve one candidate at a time.</span></li></ol></section>
    <DashboardCard title="Search quality — measured by enrollments and revenue, not raw volume" action={<div className="lead-view-tabs"><Button variant="outline" size="sm" loading={monitorPerformanceLoading} onClick={loadMonitorPerformance}>Refresh</Button><Button size="sm" disabled={strategyBusy} onClick={runStrategyRecommendations}>{strategyBusy ? "Analyzing…" : "Get AI strategy recommendations"}</Button></div>}>
      {!monitorPerformance ? <p>Loading monitor performance…</p> : <div className="monitor-performance-table"><table><thead><tr><th>Monitor</th><th>Candidates</th><th>Live leads</th><th>Rejected</th><th>Enrolled</th><th>Won revenue</th></tr></thead><tbody>{monitorPerformance.performance.map((row) => <tr key={row.monitorId}><td>{row.name}{!row.enabled ? <small> (disabled)</small> : null}</td><td>{row.totalCandidates}</td><td>{row.buckets.live_lead}</td><td>{row.rejectionRate}%</td><td>{row.enrolled}</td><td>${row.wonRevenue.toLocaleString()}</td></tr>)}</tbody></table></div>}
      {monitorPerformance?.recommendations?.length ? <div className="monitor-recommendations"><strong>Recommendations</strong><ul>{monitorPerformance.recommendations.map((rec, index) => <li key={index}><b>{rec.monitorName}:</b> {rec.detail}</li>)}</ul></div> : null}
      {strategyError ? <p className="form-error" role="alert">{strategyError}</p> : null}
      {strategy ? <div className="discovery-strategy-result">
        <p>{strategy.summary}</p>
        {strategy.coverageGaps?.length ? <><strong>Coverage gaps</strong><ul>{strategy.coverageGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></> : null}
        {strategy.monitorsToReview?.length ? <><strong>Monitors to review</strong><ul>{strategy.monitorsToReview.map((item, index) => <li key={index}><b>{item.monitorName}</b> — {item.issue}: {item.recommendation}</li>)}</ul></> : null}
        {strategy.suggestedSearches?.length ? <><strong>Suggested new searches</strong><ul>{strategy.suggestedSearches.map((item, index) => <li key={index}><b>{item.program}:</b> {item.query} — {item.rationale}</li>)}</ul></> : null}
      </div> : null}
    </DashboardCard>

    <DashboardCard title="Your active monitors" action={<div className="monitor-header-actions"><Button variant="outline" onClick={loadAutomaticResearch}>Refresh</Button><Button onClick={() => setShowMonitorSetup((value) => !value)}>{showMonitorSetup ? "Close setup" : "Create a monitor"}</Button></div>}>
      {showMonitorSetup ? <section className="monitor-setup-panel"><header><span>New monitor</span><h3>Choose the evidence Lead Porch should find</h3><p>Start with the Ellie student-intent, qualified-investor, or community-partner preset. Each uses a different source strategy.</p></header>{monitorPresets.map((preset) => <button className="monitor-preset" type="button" key={preset.id} onClick={() => applyMonitorPreset(preset)}><span>Purpose-built starting point</span><strong>{preset.name}</strong><small>{preset.monitorType === "investor_profile" ? "Find multifamily-relevant professionals or self-described investors; titles alone never qualify" : preset.monitorType === "community_partner" ? "Find public community organizations and organizers—not individual members" : "Find specific public multifamily questions, problems, or learning requests"}</small></button>)}<div className="intent-monitor-builder">
        <label><span>What should this monitor find?</span><select value={monitorDraft.monitorType} onChange={(event) => { const type = event.target.value; setMonitorDraft((current) => ({ ...current, monitorType: type })); setSelectedSources(monitorSources(type)); }}><option value="investor_profile">Qualified investor prospects</option><option value="buyer_intent">Individual student / buyer intent</option><option value="community_partner">Community partners</option></select><small>Student intent, investor fit, and community discovery use separate eligibility rules and source defaults.</small></label><label><span>Monitor name</span><input value={monitorDraft.name} onChange={(event) => setMonitorDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label><span>Check frequency</span><select value={monitorDraft.intervalMinutes} onChange={(event) => setMonitorDraft((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))}><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={1440}>Daily</option></select></label>
        <label className="span-2"><span>{monitorAudienceLabel(monitorDraft.monitorType)}</span><textarea value={monitorDraft.query} onChange={(event) => setMonitorDraft((current) => ({ ...current, query: event.target.value }))} /></label>
        <label className="span-2"><span>{monitorKeywordLabel(monitorDraft.monitorType)}</span><textarea value={monitorDraft.keywords} onChange={(event) => setMonitorDraft((current) => ({ ...current, keywords: event.target.value }))} /></label>
        {monitorDraft.intentCategories?.length ? <div className="intent-category-editor span-2">{monitorDraft.intentCategories.map((category, categoryIndex) => <label key={`${category.name}-${categoryIndex}`}><span>{category.name}</span><textarea value={(category.phrases || []).join("\n")} onChange={(event) => setMonitorDraft((current) => ({ ...current, intentCategories: current.intentCategories.map((item, index) => index === categoryIndex ? { ...item, phrases: splitValues(event.target.value) } : item) }))} /></label>)}</div> : null}
        <label className="span-2"><span>Always ignore</span><textarea value={monitorDraft.negativeKeywords} onChange={(event) => setMonitorDraft((current) => ({ ...current, negativeKeywords: event.target.value }))} /></label>
        <details className="advanced-monitor-options span-2"><summary>Advanced source options</summary><label><span>{monitorDraft.monitorType === "community_partner" ? "Public community or feed URLs" : "Public discussion or feed URLs"}</span><textarea value={monitorDraft.feedUrls} onChange={(event) => setMonitorDraft((current) => ({ ...current, feedUrls: event.target.value }))} placeholder={monitorDraft.monitorType === "community_partner" ? "One public community URL per line" : "One public forum, discussion, RSS, or Atom URL per line"} /><small>{monitorDraft.monitorType === "community_partner" ? "Public LinkedIn/Facebook group pages, Meetup, REIA, and other community directories provide community metadata—not member conversations." : "Use URLs that expose specific public discussions. A directory, group description, or professional title is not buyer intent."}</small></label><div className="intent-source-chips">{SOURCE_OPTIONS.filter(([, , use]) => use === "all" || (monitorDraft.monitorType === "community_partner" && use === "community") || (monitorDraft.monitorType !== "buyer_intent" && use === "nonstudent")).map(([id, label]) => <button type="button" className={`${selectedSources.includes(id) ? "is-on" : ""} ${UNSTABLE_MONITOR_SOURCES.has(id) ? "is-optional" : ""}`} key={id} onClick={() => toggleDraftSource(id)}>{selectedSources.includes(id) ? "On · " : "Off · "}{label}</button>)}</div><div className="public-community-sources"><strong>Public web / community discovery</strong><span>Indexed public pages and metadata only. These sources do not mean a customer social account is connected.</span><small>Connected social accounts are a separate OAuth capability. Without authorization, Lead Porch cannot access private groups, authenticated feeds, private posts, DMs, member lists, or private profiles.</small></div></details>
      </div>
      <div className="monitor-setup-actions"><Button loading={monitorSaving} disabled={!monitorDraft.query.trim()} onClick={createMonitor}>Start this monitor</Button><small>You can pause it at any time. No outreach is ever sent.</small></div></section> : null}
      {monitors.length ? <div className="intent-monitor-list">{monitors.map((monitor) => { const monitorSignals = intentSignals.filter((signal) => String(signal.monitorId) === String(monitor._id) && signal.status !== "dismissed"); const currentLeadCount = monitorSignals.length; const failures = (monitor.sourceHealth || []).filter((health) => (monitor.sources || []).includes(health.source) && ["failed", "blocked", "rate_limited"].includes(health.state)); return <article key={monitor._id}>
        <header className="monitor-card-header"><div><span className={`intent-monitor-state is-${monitor.lastRunStatus}`}>{monitor.lastRunStatus === "never" && monitor.enabled ? "Starting first check now" : monitor.lastRunStatus === "running" ? "Checking public sources now" : monitor.enabled ? "Monitoring is on" : "Monitoring paused"}</span><strong>{monitor.name}</strong><small>Goal: find {monitorGoal(monitor.monitorType)}</small></div><div className="intent-monitor-actions">{(monitor.sources || []).some((source) => UNSTABLE_MONITOR_SOURCES.has(source)) ? <Button size="sm" onClick={() => repairMonitorSources(monitor)}>Fix source list</Button> : <Button size="sm" onClick={() => openQualityEditor(monitor)}>Improve lead quality</Button>}<Button size="sm" variant="outline" loading={monitorRunningId === monitor._id} disabled={!monitor.enabled || monitor.lastRunStatus === "running"} onClick={() => runMonitorNow(monitor._id)}>Run again now</Button><Button size="sm" variant="outline" onClick={() => toggleMonitor(monitor)}>{monitor.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" disabled={monitorRunningId === monitor._id} onClick={() => removeMonitor(monitor)}>Delete</Button></div></header>
        {monitor.lastRunStatus !== "running" ? monitor.lastRunFunnel?.engineVersion === "acquisition-v2" ? <div className="monitor-run-funnel"><strong>Latest acquisition funnel</strong><span>{monitor.lastRunFunnel.candidatesFetched || 0}<small>Candidates fetched</small></span><span>{monitor.lastRunFunnel.uniqueEvidenceEvaluated || 0}<small>Unique discussions/evidence evaluated</small></span><span>{monitor.lastRunFunnel.weakMatchesRejected || 0}<small>Weak matches rejected</small></span><span>{monitor.lastRunFunnel.qualifiedOpportunities || 0}<small>Qualified opportunities</small></span></div> : <div className="monitor-count-explainer"><strong>Legacy monitor history</strong><span>Stored totals predate the current acquisition funnel and may represent cumulative or raw processing activity. They are preserved, not reinterpreted.</span></div> : null}
        {(monitor.feedUrls || []).some(isBiggerPocketsUrl) ? <div className="public-community-sources"><strong>BiggerPockets legacy URL</strong><span>The saved URL is preserved, but Lead Porch has no dedicated reliable BiggerPockets adapter.</span><small>Current acquisition uses Bing-indexed public BiggerPockets results only. It does not crawl behind authentication or anti-bot controls.</small></div> : null}
        {monitor.lastRunStatus === "running" ? <div className="monitor-run-progress" role="status"><span className="monitor-run-progress__spinner"/><div><strong>Search is running now</strong><p>Lead Porch is checking each enabled source. Totals and the next hourly check will appear only after this search finishes. You can leave this page.</p><small>Started {monitor.lastRunAt ? new Date(monitor.lastRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"}</small></div></div> : <><div className="monitor-card-summary"><div><strong>{currentLeadCount}</strong><span>current deduplicated leads in Live Leads</span></div><div><strong>{monitor.nextRunAt ? new Date(monitor.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</strong><span>next automatic check</span></div><div><strong>{failures.length}</strong><span>{failures.length ? failures.map((health) => health.source.replaceAll("_", " ")).join(", ") + " will retry next check" : "all enabled sources completed"}</span></div></div><div className="monitor-count-explainer"><strong>{currentLeadCount ? "Review the results" : "No qualified matches yet"}</strong><span>{currentLeadCount ? "This is the same deduplicated count shown in Live Leads." : `The completed search did not find a result that passed the ${monitor.monitorType === "investor_profile" ? "professional and investor-fit" : monitor.monitorType === "community_partner" ? "community-partner" : "buyer-intent"} filters. The monitor will search again automatically.`}</span><button type="button" onClick={() => setActiveTab("leads")}>Open Live Leads</button></div>{(monitor.feedUrls || []).length ? <div className="public-community-sources monitor-saved-urls"><strong>Saved public URLs</strong><span>{monitor.feedUrls.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{index ? " · " : ""}{url}</a>)}</span><small>{monitor.feedUrls.some(isBiggerPocketsUrl) ? "BiggerPockets is preserved as legacy configuration and is discovered through Bing indexing only." : "Supported accessible pages or feeds contribute candidates to the latest-run funnel."}</small></div> : null}<p className="monitor-last-result">Latest completed check: {friendlyMonitorMessage(monitor.lastRunMessage) || "No completed check yet."}</p></>}
        {qualityEditingId === String(monitor._id) ? <section className="quality-editor"><header><div><span>Improve future results</span><h3>Teach Lead Porch what a good lead looks like</h3></div><button type="button" onClick={() => setQualityEditingId("")}>Close</button></header><div><label><span>Who is a good buyer?</span><textarea value={qualityDraft.query} onChange={(event) => setQualityDraft((current) => ({ ...current, query: event.target.value }))} /><small>Describe an adult with the role, business situation, and reason they could benefit from the event.</small></label><label><span>Language that signals buying interest</span><textarea value={qualityDraft.keywords} onChange={(event) => setQualityDraft((current) => ({ ...current, keywords: event.target.value }))} /><small>Use specific phrases such as “looking for a business coach” or “need systems to scale.”</small></label><label><span>Always reject</span><textarea value={qualityDraft.negativeKeywords} onChange={(event) => setQualityDraft((current) => ({ ...current, negativeKeywords: event.target.value }))} /><small>Minors, schoolwork, no-budget posts, promotions, and job seekers are also blocked automatically.</small></label><label><span>Public community or feed URLs</span><textarea value={qualityDraft.feedUrls} onChange={(event) => setQualityDraft((current) => ({ ...current, feedUrls: event.target.value }))} placeholder="One public RSS, Atom, or accessible discussion URL per line" /><small>Use a documented public feed or a normal public discussion page. BiggerPockets is available through Bing-indexed discovery only, not as a dedicated direct feed.</small></label></div><footer><Button loading={qualitySaving} onClick={() => saveLeadQuality(monitor)}>Save and check again</Button><span>This changes future monitoring. It does not contact anyone.</span></footer></section> : null}
        <div className="public-community-sources"><strong>Where this monitor is actually searching</strong><span>{(monitor.sourceHealth || []).filter((health) => monitorSourceEnabled(monitor, health.source)).map((health) => health.source.replaceAll("_", " ") + ": " + friendlySourceState(health.state)).join(" · ") || "Waiting for the first check"}</span><small>Facebook and LinkedIn private group posts: unavailable without platform-approved group access. Public group pages can only be found when a directory or search engine exposes them.</small></div><details className="monitor-details"><summary>Source details and errors</summary><p>Each source reports whether it completed and what needs attention. A failed optional source does not erase results from sources that worked.</p><div className="source-health-list">{(monitor.sourceHealth || []).map((health) => { const contribution = monitor.lastRunFunnel?.sourceContributions?.find((item) => item.source === health.source)?.candidates; const completed = ["healthy", "empty"].includes(health.state) && health.lastSuccessfulCheck; return <div key={health.source} className={monitorSourceEnabled(monitor, health.source) ? `is-` : "is-disabled"}><span className="source-health-dot"></span><strong>{health.source.replaceAll("_", " ")}</strong><span>{monitorSourceEnabled(monitor, health.source) ? friendlySourceState(health.state) : "Disabled"}</span><small>{monitor.lastRunFunnel?.engineVersion === "acquisition-v2" ? `${contribution ?? 0} candidates contributed in the latest run` : `${health.resultsCollected || 0} legacy stored source count`}</small><small>{completed ? `Completed ${new Date(health.lastSuccessfulCheck).toLocaleString()}` : sourceAction(health)}</small>{health.source === "feeds" ? <span>Managed by saved URLs</span> : <button type="button" onClick={() => toggleExistingSource(monitor, health.source)}>{monitorSourceEnabled(monitor, health.source) ? "Disable" : "Enable"}</button>}</div>; })}</div></details>
      </article>; })}</div> : <div className="friendly-empty"><strong>No monitors yet</strong><p>Create one above and Lead Porch will begin checking its purpose-built public sources automatically.</p></div>}
    </DashboardCard>

    <details className="activity-drawer"><summary>View monitoring activity</summary><p className="activity-help">This is an optional audit trail. Source retries are informational; you do not need to fix them.</p><div className="monitor-timeline">{monitorActivity.length ? monitorActivity.slice(0, 20).map((item) => <article key={item._id} className={`is-${item.type}`}><span></span><div><strong>{friendlyActivityMessage(item)}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></div></article>) : <p>No activity yet.</p>}</div></details></> : null}

    {activeTab === "leads" ? <><section className="lead-review-hero"><div><span>Your opportunity inbox</span><h2>{signalSummary.total} results, separated by what they actually are</h2><p>A person can move toward direct outreach. A community needs an organizer or partnership approach. An organization needs a decision-maker. An intent signal needs identity research. These are no longer treated as the same kind of lead.</p></div><div className="lead-review-stats"><div><strong>{signalSummary.person}</strong><span>named people</span></div><div><strong>{signalSummary.community_partner}</strong><span>community partners</span></div><div><strong>{signalSummary.needsIdentity}</strong><span>need a person</span></div></div></section>
    <section className="discovery-track-tabs" aria-label="Discovery track">{[["live_lead", "Live Leads", bucketSummary.live_lead], ["watchlist", "Watchlist", bucketSummary.watchlist], ["community_opportunity", "Community Opportunities", bucketSummary.community_opportunity], ["rejected", "Rejected", bucketSummary.rejected]].map(([id, label, count]) => <button key={id} type="button" className={discoveryTrack === id ? "is-active" : ""} onClick={() => loadDiscoveryTrack(id)}>{label} {count}</button>)}</section>
    {discoveryTrack !== "live_lead" ? <DashboardCard title={discoveryTrack === "watchlist" ? "Watchlist — relevant people without confirmed current intent" : discoveryTrack === "community_opportunity" ? "Community Opportunities" : "Rejected — recorded reason for every irrelevant result"}>
      {trackError ? <p className="form-error" role="alert">{trackError}</p> : null}
      {trackLoading ? <p>Loading…</p> : trackSignals.length ? <div className="intent-signal-list">{trackSignals.map((signal) => <article key={signal._id}>
        <div className="intent-signal-main"><div><span>{intentSourceLabel(signal)} · {signal.monitorName}</span><small>{signal.publishedAt ? new Date(signal.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"}</small></div><h3>{displayText(signal.title) || "Public evidence requiring review"}</h3><p>{displayText(signal.excerpt) || "Open the original source to review the context."}</p>
          {discoveryTrack === "rejected" ? <div className="signal-why"><strong>Rejected: {String(signal.rejectionReason || "other").replaceAll("_", " ")}</strong><span>{(signal.scoreReasons || []).slice(0, 3).join(" · ")}</span></div> : null}
          {discoveryTrack === "watchlist" ? <div className="signal-why"><strong>Score {signal.score}/100 — relevant but no confirmed current need yet</strong><span>{(signal.scoreReasons || []).slice(0, 4).join(" · ")}</span></div> : null}
          {discoveryTrack === "community_opportunity" ? <div className="signal-why"><strong>{signal.communityProfile?.platform || "Community"}</strong><span>Audience: {signal.communityProfile?.audienceFit || "Real-estate investing"} · Organizer: {signal.communityProfile?.organizerEvidence || "Not yet identified"}</span><span>Promotion rules: {signal.communityProfile?.promotionRules}</span><span>Recommended approach: {signal.communityProfile?.recommendedApproach}</span></div> : null}
          <a href={signal.sourceUrl} target="_blank" rel="noreferrer">View exact public evidence ↗</a>
        </div>
      </article>)}</div> : <div className="friendly-empty"><strong>Nothing here yet</strong><p>{discoveryTrack === "rejected" ? "Rejected results and their reasons will appear here as monitors run." : discoveryTrack === "watchlist" ? "People with relevant background but no confirmed current need will appear here." : "Public community groups, organizers, and partners will appear here as monitors run."}</p></div>}
    </DashboardCard> : <>
    <DashboardCard title="Research Agent: weekly Discovery brief" action={<Button variant="outline" size="sm" disabled={weeklyBriefBusy} onClick={runWeeklyBrief}>{weeklyBriefBusy ? "Summarizing…" : "Summarize this week's findings"}</Button>}>
      <p className="weekly-brief-note">AI assistance only, grounded in this week's real Discovery signals. Nothing is contacted or added to CRM automatically.</p>
      {weeklyBriefError ? <p className="form-error" role="alert">{weeklyBriefError}</p> : null}
      {weeklyBrief ? <div className="weekly-brief-result">
        <p>{weeklyBrief.data.summary}</p>
        {weeklyBrief.data.topFindings?.length ? <><strong>Top findings</strong><ul>{weeklyBrief.data.topFindings.map((item, index) => <li key={index}><b>{item.title}</b>{item.why ? ` — ${item.why}` : ""}</li>)}</ul></> : null}
        {weeklyBrief.data.recommendedFollowUps?.length ? <><strong>Recommended follow-ups</strong><ul>{weeklyBrief.data.recommendedFollowUps.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}
      </div> : null}
    </DashboardCard>
    <section className="lead-type-tabs" aria-label="Opportunity type"><button type="button" className={opportunityView === "all" ? "is-active" : ""} onClick={() => setOpportunityView("all")}>All {signalSummary.total}</button><button type="button" className={opportunityView === "person" ? "is-active" : ""} onClick={() => setOpportunityView("person")}>People {signalSummary.person}</button><button type="button" className={opportunityView === "community_partner" ? "is-active" : ""} onClick={() => setOpportunityView("community_partner")}>Communities {signalSummary.community_partner}</button><button type="button" className={opportunityView === "organization" ? "is-active" : ""} onClick={() => setOpportunityView("organization")}>Organizations {signalSummary.organization}</button><button type="button" className={opportunityView === "intent_signal" ? "is-active" : ""} onClick={() => setOpportunityView("intent_signal")}>Intent signals {signalSummary.intent_signal}</button></section>
    <section className="lead-workflow"><div><strong>People</strong><span>Verify the evidence and email, then add to CRM and prepare outreach.</span></div><div><strong>Communities</strong><span>Find the organizer and prepare a partnership request—not a member scrape.</span></div><div><strong>Organizations & intent</strong><span>Identify a real decision-maker before treating the result as contactable.</span></div></section>
    <DashboardCard title="Opportunity review" action={<div className="lead-view-tabs"><button type="button" className={leadView === "new" ? "is-active" : ""} onClick={() => setLeadView("new")}>Needs a decision</button><button type="button" className={leadView === "qualified" ? "is-active" : ""} onClick={() => setLeadView("qualified")}>Saved</button><button type="button" className={leadView === "all" ? "is-active" : ""} onClick={() => setLeadView("all")}>All active</button></div>}>
      {visibleSignals.length ? <div className="intent-signal-list">{visibleSignals.map((signal) => { const account = publicAccount(signal); const hasIdentifiedPerson = Boolean(identifiedPersonName(signal)); const identityResult = identityResults[signal._id]; return <article key={signal._id} className={`is-${signal.status}`}>
        <div className="signal-priority"><span>{String(signal.opportunityType || "opportunity").replaceAll("_", " ")}</span><strong>{signal.score >= 75 ? "High" : signal.score >= 55 ? "Medium" : "Review"}</strong><small>{signal.score}/100 match</small></div>
        <div className="intent-signal-main"><div><span>{intentSourceLabel(signal)} · {signal.monitorName}</span><small>{signal.publishedAt ? new Date(signal.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"}</small></div><h3>{displayText(signal.title) || "Public evidence requiring review"}</h3><p>{displayText(signal.excerpt) || "Open the original source to review the context."}</p><div className="signal-why"><strong>Why it scored {signal.score}/100</strong><span>{(signal.scoreReasons || []).slice(0, 4).join(" · ") || "A specific current need matched your audience rules."}</span></div>{signal.evidence?.length > 1 ? <small>{signal.evidence.length} evidence records reconciled into this candidate.</small> : null}<a href={signal.sourceUrl} target="_blank" rel="noreferrer">View exact public evidence ↗</a></div>
        {isBiggerPocketsUrl(signal.sourceUrl) ? <aside className="signal-contact biggerpockets-policy"><span>Public Engagement Opportunity</span><strong>No promotional outreach — BiggerPockets policy.</strong><small>Do not enrich or contact this author elsewhere because of this post. Only a useful public response may be drafted for manual review and manual posting.</small></aside> : <aside className="signal-contact"><span>{hasIdentifiedPerson ? "Identified person" : "Contact person"}</span>{hasIdentifiedPerson ? (account.url ? <a href={account.url} target="_blank" rel="noreferrer">{account.label} ↗</a> : <strong>{account.label}</strong>) : <strong>No person identified yet</strong>}<small>{hasIdentifiedPerson ? "A public source displays this name. Review the evidence before adding the person to CRM." : "This result is a community or organization. Lead Porch must identify a real contact person before drafting email."}</small>{signal.organizationName || signal.organizationDomain ? <><span>Community or organization</span><strong>{signal.organizationName || signal.organizationDomain}</strong>{signal.identityResolution?.status !== "supported" ? <small>The community is public; its relationship to a named person has not been established.</small> : null}</> : null}{signal.publishedEmails?.length ? <div className="published-email-note">{hasIdentifiedPerson ? "Published email found · still unverified" : "Community email found · not tied to a person"}</div> : null}</aside>}
        {isBiggerPocketsUrl(signal.sourceUrl) ? <div className="intent-signal-actions"><Button size="sm" loading={signalBusyId === signal._id} onClick={() => openBiggerPocketsResponse(signal)}>Draft helpful public response</Button><small>Manual review and manual posting only. No DM, enrichment, email, Closer sequence, link, or sales CTA.</small><Button size="sm" variant="outline" disabled={signalBusyId === signal._id} onClick={() => reviewSignal(signal, "dismissed")}>Not a fit</Button></div> : <div className="intent-signal-actions">{["qualified", "converted"].includes(signal.status) ? <><div className="intent-next-step"><span>Next step</span><strong>{!hasIdentifiedPerson ? "Find a real contact person and email" : !signal.emailDrafts?.length ? "Create the Deal to Close email" : !signal.crmContact ? "Add the identified person to CRM" : signal.crmContact.emailStatus !== "verified" ? "Confirm the contact email" : "Review and move the draft to Outreach"}</strong><small>Nothing is sent automatically.</small></div><div className="intent-action-row">{hasIdentifiedPerson ? <Button size="sm" onClick={() => openEmailDraft(signal)}>{signal.emailDrafts?.length ? "Review generated email" : "Generate Deal to Close email"}</Button> : <Button size="sm" loading={signalBusyId === signal._id} onClick={() => researchSignalIdentity(signal)}>Find contact person & email</Button>}{/reddit/i.test(signal.source || "") ? <Button size="sm" variant="outline" onClick={() => openRedditDrafts(signal)}>Create Reddit reply & DM</Button> : null}{hasIdentifiedPerson ? <Button size="sm" variant="outline" loading={signalBusyId === signal._id} onClick={() => researchSignalIdentity(signal)}>Research identity & email</Button> : null}{signal.status === "converted" ? <Button size="sm" variant="outline" onClick={() => navigate(`/contacts?tab=attention&search=${encodeURIComponent(signal.crmContact?.name || "Identity research needed")}`)}>Open contact next steps</Button> : hasIdentifiedPerson ? <Button size="sm" variant="outline" disabled={signalBusyId === signal._id} onClick={() => addSignalToCrm(signal)}>Add identified person to CRM</Button> : null}</div><IdentityResearchResult result={identityResult} busy={signalBusyId === signal._id} onSelect={(person) => researchSignalIdentity(signal, person)} /><ol className="intent-progress"><li className="is-done">Opportunity approved</li><li className={hasIdentifiedPerson ? "is-done" : ""}>Person identified</li><li className={signal.crmContact ? "is-done" : ""}>CRM contact added</li><li className={signal.crmContact?.emailStatus === "verified" ? "is-done" : ""}>Email confirmed</li><li className={signal.emailDrafts?.some((draft) => draft.status === "transferred") ? "is-done" : ""}>Ready in Outreach</li></ol><small>{hasIdentifiedPerson ? "The identified person still requires CRM and email review before Outreach." : "Lead Porch checks the public page directly without OpenAI credits. If no person is published, keep this as a community opportunity."}</small></> : <><Button size="sm" loading={signalBusyId === signal._id} disabled={signalBusyId === signal._id} onClick={() => reviewSignal(signal, "qualified")}>{hasIdentifiedPerson ? "Yes—prepare follow-up" : "Yes—find the contact person"}</Button><small>{hasIdentifiedPerson ? "Saves the lead and opens an unsent email draft." : "Saves the opportunity and checks its public pages for a named contact. No email is drafted yet."}</small></>}<Button size="sm" variant="outline" disabled={signalBusyId === signal._id || signal.status === "converted"} onClick={() => reviewSignal(signal, "dismissed")}>Not a fit</Button></div>}
      </article>; })}</div> : <div className="friendly-empty"><strong>{leadView === "new" ? "You’re caught up" : "No leads in this view"}</strong><p>{leadView === "new" ? "Lead Porch will place the next plausible adult buyer here after the automatic filters run." : "Change the view above or wait for the next monitoring check."}</p></div>}
    </DashboardCard></>}</> : null}

    {activeTab === "saved" ? <><DashboardCard title="Saved company targeting and result sets" action={<Button variant="outline" loading={historyLoading} onClick={loadResearchHistory}>Refresh</Button>}>
      <p className="crm-review-explainer"><strong>What belongs here:</strong> saved company targeting profiles and company-discovery result sets. People requests stay in People Research; active signal searches stay in Intent Monitoring. Historical Apollo-labeled records are preserved and marked legacy rather than presented as the current source.</p>
      {researchHistory.length ? <div className="research-history-list">{researchHistory.map((entry) => {
        const jobStatus = entry.job?.status || (entry.totalOrgs ? "completed" : "saved");
        const statistics = entry.job?.statistics || {};
        return <article key={entry._id} className={`research-history-item is-${jobStatus}`}>
          <div className="research-history-main"><span>{jobStatus.replaceAll("_", " ")}</span><strong>{entry.name}</strong><p>{entry.description || entry.job?.question || "Saved prospect list"}</p></div>
          <div className="research-history-counts"><strong>{entry.totalOrgs || statistics.received || 0}</strong><span>organizations</span><small>{entry.job ? `${statistics.created || 0} new · ${statistics.updated || 0} refreshed` : /apollo/i.test(entry.source || "") ? "Legacy Apollo-labeled research" : entry.source || "Saved targeting profile"}</small></div>
          <div className="research-history-actions"><small>{new Date(entry.createdAt).toLocaleString()}</small><Button size="sm" variant="outline" loading={openingHistoryId === String(entry._id)} onClick={() => openSavedResearch(entry)}>Open results</Button></div>
          {entry.job?.error ? <p className="research-history-error">{entry.job.error}</p> : null}
        </article>;
      })}</div> : <div className="table-state table-state--empty">No saved research yet. Research started in ChatGPT or on this page will appear here automatically.</div>}
    </DashboardCard></> : null}

    {activeTab === "people" ? <div id="people-research-previews" className="people-research-workspace">
      <section className="people-search-guide"><div><span>People Research</span><h2>Find named decision-makers at real organizations</h2><p>This is different from Intent Monitoring. Jarvis searches public organization and leadership evidence for owners, founders, executives, and other named roles you describe. A title identifies a person; it does not prove buyer intent.</p></div><div className="people-search-steps"><div><strong>1</strong><span><b>Describe the people</b>Include role, industry, location, and how many you want.</span></div><div><strong>2</strong><span><b>Jarvis researches</b>It finds public evidence, company details, and published emails when available.</span></div><div><strong>3</strong><span><b>You review</b>Nothing enters the CRM until you select and confirm each import.</span></div></div></section>
      <DashboardCard title="Start a people search"><div className="people-search-launcher"><label><span>Tell Jarvis exactly who to find</span><textarea value={peopleSearchPrompt} onChange={(event) => setPeopleSearchPrompt(event.target.value)} /></label><div><Button disabled={!peopleSearchPrompt.trim()} onClick={() => navigate(`/jarvis?prompt=${encodeURIComponent(peopleSearchPrompt)}`)}>Open this request in Jarvis</Button><small>Jarvis will show the request before searching. Public emails remain unverified.</small></div></div><div className="people-search-examples"><span>Good requests include:</span><button type="button" onClick={() => setPeopleSearchPrompt("Find 20 owners of property-management companies in the United States with evidence of an active business. Exclude students, job seekers, and companies without a public website.")}>Property-management owners</button><button type="button" onClick={() => setPeopleSearchPrompt("Find 20 founders or CEOs of established service businesses in the United States who may need systems to scale. Require a public leadership or company source.")}>Established service-business founders</button><button type="button" onClick={() => setPeopleSearchPrompt("Find 20 adult real estate investors or multifamily principals in the United States with a public company, portfolio, or leadership page.")}>Real estate investors</button></div></DashboardCard>
      <DashboardCard title="Jarvis research previews" action={<Button variant="outline" loading={peoplePreviewsLoading} onClick={loadPeoplePreviews}>Refresh</Button>}>
        <p className="people-preview-intro">People found by Lead Porch stay here for review before they become CRM contacts. A published email is still unverified and cannot be used for outreach until it passes your verification rules.</p>
        {peoplePreviews.length ? <div className="people-preview-list">{peoplePreviews.map((preview) => {
          const isOpen = openPeoplePreviewId === String(preview._id);
          return <article key={preview._id} className={`people-preview-batch is-${preview.status}`}>
            <header>
              <div><span>{preview.status.replaceAll("_", " ")}</span><strong>{preview.name}</strong><small>{new Date(preview.updatedAt).toLocaleString()} · {preview.source === "chatgpt_public_web" ? "ChatGPT connection" : "Jarvis"} public-web research</small></div>
              <div className="people-preview-summary"><strong>{preview.summary?.total || preview.people?.length || 0}</strong><span>people</span><small>{preview.summary?.newContacts || 0} new · {preview.summary?.existingContacts || 0} existing · {preview.summary?.publishedEmails || 0} published emails</small></div>
              <Button size="sm" variant="outline" onClick={() => setOpenPeoplePreviewId(isOpen ? "" : String(preview._id))}>{isOpen ? "Hide people" : "Review people"}</Button>
            </header>
            {isOpen ? <div className="people-preview-rows">{(preview.people || []).map((person, index) => <div className="people-preview-person" key={`${person.firstName}-${person.lastName}-${person.company}-${index}`}>
              <div><strong>{[person.firstName, person.lastName].filter(Boolean).join(" ") || "Unnamed person"}</strong><span>{[person.title, person.company].filter(Boolean).join(" · ") || "Role needs review"}</span></div>
              <div><small>Email</small><strong>{person.email || "Not publicly listed"}</strong><span className={`people-email-state is-${person.emailStatus}`}>{String(person.emailStatus || "missing").replaceAll("_", " ")}</span></div>
              <div><small>CRM review</small><strong>{String(person.reviewStatus || "new").replaceAll("_", " ")}</strong>{person.matchReason ? <span>{person.matchReason}</span> : null}</div>
              <div className="people-preview-evidence"><small>Evidence</small><p>{person.evidenceSummary || "Public source attached for manual review."}</p><a href={person.evidenceUrl} target="_blank" rel="noreferrer">Open source</a></div>
            </div>)}</div> : null}
            {preview.status !== "imported" ? <p className="people-preview-footnote">Staged only—these people have not been added to Contacts. Import remains a separate confirmed step.</p> : <p className="people-preview-footnote is-imported">Imported as needs-review prospects. Open Prospect review below to qualify them.</p>}
          </article>;
        })}</div> : <div className="table-state table-state--empty">No staged people previews yet. Ask Jarvis to find public-web decision-makers; the preview will appear here automatically.</div>}
      </DashboardCard>

      <DashboardCard title="Public-web research (optional discovery sources)">
        <p className="people-preview-intro">
          <strong>Vertex AI and OpenAI Web Search actively search the public web</strong> for
          real, citable results — each result carries a real source URL and, for people, a
          verified evidence date. <strong>Up to 5 new people per search.</strong> Nothing else
          runs automatically: PDL enrichment, CRM import, monitors, and outreach all require your
          own explicit action, every time — this search alone never enriches, imports, contacts,
          or monitors anyone. Every result waits in the review queue below until you decide.
        </p>
        {suggestedSearches.length ? (
          <div className="grounding-suggested-searches">
            <span>Suggested searches from your approved Offers &amp; Programs</span>
            <div className="grounding-suggested-searches__buttons">
              {suggestedSearches.map((suggestion) => (
                <Button key={suggestion.noteId} size="sm" variant="outline" onClick={() => applySuggestedSearch(suggestion)}>
                  {suggestion.title}
                </Button>
              ))}
            </div>
            <small>Clicking a suggestion fills in the search box below — edit it freely before searching.</small>
          </div>
        ) : null}
        <div className="people-search-launcher">
          <label>
            <span>What should the public web be searched for?</span>
            <textarea value={groundingQuery} onChange={(event) => setGroundingQuery(event.target.value)} placeholder="e.g. real estate investor associations and their named organizers near Austin, Texas" disabled={groundingBusy} />
          </label>
          <label>
            <span>Source</span>
            <select value={groundingSource} onChange={(event) => setGroundingSource(event.target.value)} disabled={groundingBusy}>
              <option value="both">Both (Vertex + OpenAI Web Search)</option>
              <option value="vertex">Vertex Grounding only</option>
              <option value="openai_web_search">OpenAI Web Search only</option>
            </select>
          </label>
          <fieldset className="grounding-type-fieldset">
            <legend>Result types</legend>
            {["person", "organization", "event", "community"].map((type) => (
              <label key={type} className="grounding-type-checkbox">
                <input
                  type="checkbox"
                  checked={groundingTypes.includes(type)}
                  disabled={groundingBusy}
                  onChange={(event) => setGroundingTypes((current) => event.target.checked ? [...current, type] : current.filter((row) => row !== type))}
                />
                {type}
              </label>
            ))}
          </fieldset>
          <div>
            <Button disabled={!groundingQuery.trim() || !groundingTypes.length} loading={groundingBusy} onClick={runGroundingSearch}>
              {groundingBusy ? "Searching (can take up to a minute)…" : "Search public web"}
            </Button>
          </div>
          {groundingError ? <p className="form-error">{groundingError}</p> : null}
          {groundingSourceErrors.length ? groundingSourceErrors.map((sourceError) => (
            <p key={sourceError.source} className="form-error">
              {sourceError.source === "vertex_grounding" ? "Vertex Grounding" : "OpenAI Web Search"} unavailable: {sourceError.message}
            </p>
          )) : null}
        </div>

        <div className="discovery-review-filters">
          {["pending_review", "saved", "dismissed"].map((status) => (
            <Button key={status} size="sm" variant={groundingResultsStatus === status ? "primary" : "outline"} onClick={() => { setGroundingResultsStatus(status); setSelectedGroundingIds([]); loadGroundingResults(status); }}>
              {status.replace("_", " ")}
            </Button>
          ))}
          <Button size="sm" variant="outline" loading={groundingResultsLoading} onClick={() => loadGroundingResults()}>Refresh</Button>
          {groundingResultsStatus === "pending_review" ? (
            <Button size="sm" variant="outline" disabled={!selectedGroundingIds.length} loading={rankBusy} onClick={rankSelectedGroundingResults}>
              Rank {selectedGroundingIds.length || ""} selected for program fit (OpenAI/Jarvis)
            </Button>
          ) : null}
        </div>

        {groundingResults.length ? <div className="people-preview-list">
          {groundingResults.map((result) => (
            <article key={result._id} className={`people-preview-batch is-${result.status}`}>
              <header>
                <div>
                  {result.status === "pending_review" ? (
                    <input type="checkbox" checked={selectedGroundingIds.includes(result._id)} onChange={() => toggleGroundingSelection(result._id)} aria-label={`Select ${result.name} for ranking`} />
                  ) : null}
                  <span>{result.type} · {result.confidence.replace("_", " ")} · via {(result.providers || []).join(", ") || "vertex_grounding"}</span>
                  <strong>{result.name}</strong>
                  <small>{[result.organizationName, result.organizationDomain].filter(Boolean).join(" · ") || "No organization listed"}</small>
                  {result.fitScore != null ? <small className="grounding-fit-score">Program fit: {result.fitScore}/100 — {(result.fitReasons || []).join("; ")}</small> : null}
                  {result.type === "person" ? (
                    <small>{result.evidenceDate ? `Evidence date: ${new Date(result.evidenceDate).toLocaleDateString()} (${result.evidenceAgeDays} day${result.evidenceAgeDays === 1 ? "" : "s"} old)` : "No verifiable evidence date"}</small>
                  ) : null}
                  {result.pdlEnrichment?.attempted ? (
                    <small>
                      {result.pdlEnrichment.error ? `PDL error: ${result.pdlEnrichment.errorMessage || "unknown error"}`
                        : result.pdlEnrichment.matched ? `PDL verified: ${result.pdlEnrichment.email || "match found, no email"}`
                          : "PDL: no confident match"}
                    </small>
                  ) : null}
                </div>
                {result.status === "pending_review" ? (
                  <div>
                    {result.type === "person" && !result.pdlEnrichment?.attempted ? (
                      <Button size="sm" variant="outline" loading={pdlEnrichBusyId === result._id} disabled={Boolean(pdlEnrichBusyId) && pdlEnrichBusyId !== result._id} onClick={() => enrichGroundingResultWithPdl(result._id)}>Enrich via PDL</Button>
                    ) : null}
                    <Button size="sm" onClick={() => saveGroundingResult(result._id)}>Save with attribution</Button>
                    <Button size="sm" variant="outline" onClick={() => dismissGroundingResult(result._id)}>Dismiss</Button>
                  </div>
                ) : <span className="people-preview-footnote">{result.status === "saved" ? "Saved" : "Dismissed"}</span>}
              </header>
              <div className="people-preview-evidence">
                <small>Summary</small>
                <p>{result.summary || "No summary provided."}</p>
                <small>Citations</small>
                <div className="grounding-citations">
                  {(result.evidenceUrls || []).map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
                </div>
              </div>
            </article>
          ))}
        </div> : <div className="table-state table-state--empty">No {groundingResultsStatus.replace("_", " ")} public-web research results yet.</div>}
      </DashboardCard>
    </div> : null}

    {activeTab === "company" ? <><DashboardCard title="External research source">
      <div className={`research-source-status ${researchSource?.configured ? "is-ready" : "is-needed"}`}>
        <div><span>{researchSource?.configured ? "Connected" : "Source required"}</span><strong>{researchSource?.name || "Checking source…"}</strong><p>{researchSource?.message || "Lead Porch is checking the external-data configuration."}</p></div>
        <Button loading={externalRunning} disabled={!marketPlan || !researchSource?.configured} onClick={runExternalResearch}>Discover up to 1,000 organizations</Button>
      </div>
      {externalJob ? <div className="research-job-progress"><strong>{externalJob.status.replace(/_/g, " ")}</strong><span>{externalJob.statistics?.received || 0} received · {externalJob.statistics?.created || 0} new · {externalJob.statistics?.updated || 0} refreshed · {externalJob.statistics?.duplicates || 0} duplicates</span></div> : null}
    </DashboardCard>

    <DashboardCard title="Research criteria" action={<select value={targetPreset} onChange={(event) => selectTemplate(event.target.value)}><option value="custom">New profile</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}>
      <div className="target-grid">
        <label><span>Profile name</span><input value={target.name} onChange={(event) => setField("name", event.target.value)} placeholder="Sacramento event venues" /></label>
        <label><span>Industries</span><input value={target.industries} onChange={(event) => setField("industries", event.target.value)} placeholder="Hospitality, Event Services" /></label>
        <label><span>Business keywords</span><input value={target.keywords} onChange={(event) => setField("keywords", event.target.value)} placeholder="conference venue, corporate events" /></label>
        <label><span>Locations</span><input value={target.locations} onChange={(event) => setField("locations", event.target.value)} placeholder="Sacramento, CA" /></label>
        <label><span>Minimum employees</span><input type="number" min="0" value={target.employeeMin} onChange={(event) => setField("employeeMin", event.target.value)} /></label>
        <label><span>Maximum employees</span><input type="number" min="0" value={target.employeeMax} onChange={(event) => setField("employeeMax", event.target.value)} /></label>
      </div>
      <div className="target-actions"><Button variant="outline" loading={savingTemplate} onClick={saveTemplate}>Save profile</Button><Button loading={running} onClick={runResearch}>Match saved organizations</Button></div>
      {researchResult ? <div className="discovery-result-summary"><strong>{researchResult.organizationsFound || 0} matched organizations</strong><span>{researchResult.organizationsCreated || 0} new · {researchResult.organizationsUpdated || 0} refreshed</span></div> : null}
    </DashboardCard>

    {researchResult ? <div id="ranked-research-results"><DashboardCard title="Ranked organization list" action={<Button variant="outline" disabled={!researchOrganizations.length} onClick={exportResearchList}>Export CSV</Button>}>
      {researchOrganizations.length ? <div className="market-result-list">{researchOrganizations.map((organization, index) => <article key={organization._id}>
        <span className="market-result-rank">{index + 1}</span>
        <div><strong>{organization.name}</strong><small>{[organization.industry, organization.location].filter(Boolean).join(" · ") || "Business details need research"}</small><p>{(organization.scoreReasons || []).join(" · ") || "No scoring evidence recorded yet."}</p></div>
        <div className="market-result-score"><strong>{organization.audienceScore || 0}</strong><span>{organization.audienceTier || "unscored"}</span></div>
        <div className="market-result-evidence"><strong>{organization.researchEvidence?.length || 0} sources</strong><span>{organization.lastResearchVerifiedAt ? `Checked ${new Date(organization.lastResearchVerifiedAt).toLocaleDateString()}` : "Verification needed"}</span></div>
      </article>)}</div> : <div className="table-state table-state--empty">No stored organizations match this plan yet. Lead Porch did not manufacture results.</div>}
    </DashboardCard></div> : null}</> : null}

    {activeTab === "people" ? <DashboardCard title="CRM import review" action={<div className="discovery-review-filters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search staged people" /><select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}><option value="">All campaigns</option>{campaigns.map((campaign) => <option key={campaign._id} value={campaign._id}>{campaign.name}</option>)}</select><select value={emailFilter} onChange={(event) => setEmailFilter(event.target.value)}><option value="verified">Verified email</option><option value="review">Needs review</option><option value="all">All</option></select></div>}>
      <p className="crm-review-explainer"><strong>When to use this:</strong> People appear here only after a People Research import has been confirmed and staged for final CRM approval. Approve moves one person into Contacts. Delete removes that staged person. Neither action sends outreach.</p>
      {filtered.length ? <div className="discovery-review-list">{filtered.map((prospect) => <article key={prospect._id}><div><strong>{prospect.name || "Unnamed prospect"}</strong><span>{[prospect.title, prospect.company].filter(Boolean).join(" · ") || "Company details needed"}</span><small>{prospect.email || "No email"} · {prospect.emailStatus || "unverified"}</small></div><div><Button size="sm" onClick={() => approve(prospect)}>Approve into Contacts</Button><Button size="sm" variant="outline" onClick={() => setDeleteTarget(prospect)}>Remove</Button></div></article>)}</div> : <div className="friendly-empty"><strong>No staged people need CRM approval</strong><p>Run People Research first, review its evidence, then confirm an import. Those people will appear here for the final decision.</p></div>}
    </DashboardCard> : null}

    <Modal isOpen={Boolean(biggerPocketsSignal)} onClose={() => setBiggerPocketsSignal(null)} title="Helpful public response" footer={<><Button variant="outline" onClick={() => setBiggerPocketsSignal(null)}>Close</Button><Button variant="outline" onClick={copyBiggerPocketsResponse}>Check and copy for manual review</Button></>}>
      <div className="biggerpockets-response"><strong>No promotional outreach — BiggerPockets policy.</strong><p>This draft answers the public question only. Review and individualize it before manually posting. Lead Porch will not log in, post, message, enrich the author, or move this result to Outreach.</p><label><span>Editable public response</span><textarea value={biggerPocketsDraft} onChange={(event) => setBiggerPocketsDraft(event.target.value)} /></label><small>Do not add Ellie, Lead Porch, any company, client, affiliation, program, product, service, link, contact information, invitation, promotional transition, or sales CTA. Classifieds advertising is a separate fully manual activity and is never generated here.</small></div>
    </Modal>

    <Modal isOpen={Boolean(socialSignal)} onClose={() => setSocialSignal(null)} title="Reddit follow-up drafts" footer={<><Button variant="outline" onClick={() => setSocialSignal(null)}>Close</Button>{!socialDraft ? <Button disabled={!socialCampaignId} onClick={generateRedditDrafts}>Generate both drafts</Button> : null}</>}>
      <div className="reddit-draft-workspace"><section><span>Manual review required</span><h3>Start helpful in public, share links privately</h3><p>Lead Porch does not connect to Reddit or post anything. Review subreddit rules, copy the draft, and post or message it yourself.</p></section><label><span>Existing event campaign</span><select value={socialCampaignId} onChange={(event) => { setSocialCampaignId(event.target.value); setSocialDraft(null); }}><option value="">Choose a campaign</option>{campaigns.filter((campaign) => campaign.campaignKind !== "program").map((campaign) => <option key={campaign._id} value={campaign._id}>{campaign.name}</option>)}</select></label>{socialDraft ? <div className="reddit-draft-grid"><article><header><div><span>Public reply</span><strong>No registration links</strong></div><Button size="sm" variant="outline" onClick={() => copySocialDraft(socialDraft.reply, "Reddit reply")}>Copy reply</Button></header><textarea value={socialDraft.reply} onChange={(event) => setSocialDraft((current) => ({ ...current, reply: event.target.value }))} /><small>Use this first. It offers details without dropping promotional links into a public discussion.</small></article><article><header><div><span>Private Reddit message</span><strong>Includes Eventbrite + Meetup</strong></div><Button size="sm" variant="outline" onClick={() => copySocialDraft(socialDraft.dm, "Reddit private message")}>Copy private message</Button></header><textarea value={socialDraft.dm} onChange={(event) => setSocialDraft((current) => ({ ...current, dm: event.target.value }))} /><small>Send manually only if the account accepts messages and the invitation is appropriate.</small></article></div> : <div className="reddit-draft-empty">Choose the existing Deal to Close campaign, then generate an editable public reply and private invitation.</div>}</div>
    </Modal>

    <Modal isOpen={Boolean(draftSignal)} onClose={() => !draftBusy && setDraftSignal(null)} title="Personalized email draft" footer={<>{draftEditor?.status === "transferred" ? <><Button variant="outline" onClick={() => setDraftSignal(null)}>Close</Button><Button onClick={() => navigate(`/outreach?campaignId=${draftEditor.campaignId}`)}>Open in Outreach</Button></> : draftEditor ? <><Button variant="outline" disabled={draftBusy} onClick={() => setDraftSignal(null)}>Close</Button><Button variant="outline" loading={draftBusy} onClick={saveReviewedEmailDraft}>Save reviewed draft</Button>{draftEditor.status === "reviewed" ? <Button loading={draftBusy} onClick={moveDraftToOutreach}>Move to Outreach</Button> : null}</> : <><Button variant="outline" disabled={draftBusy} onClick={() => setDraftSignal(null)}>Cancel</Button><Button loading={draftBusy} disabled={!draftCampaignId} onClick={generateEmailDraft}>Generate unsent draft</Button></>}</>}>
      <div className="intent-draft-modal">
        <div className="intent-draft-safety"><strong>Draft only—nothing sends from this window.</strong><span>Every draft must contain both registration links. Moving it to Outreach later requires a CRM contact with a verified email.</span></div>
        {!draftEditor ? <><label><span>Event campaign</span><select value={draftCampaignId} onChange={(event) => setDraftCampaignId(event.target.value)}><option value="">Choose a campaign</option>{campaigns.filter((campaign) => campaign.campaignKind !== "program").map((campaign) => { const hasEventbrite = Boolean(campaign.registrationLinks?.eventbrite?.url); const hasMeetup = Boolean(campaign.registrationLinks?.meetup?.url); return <option key={campaign._id} value={campaign._id}>{campaign.name}{hasEventbrite && hasMeetup ? "" : " · add both registration links first"}</option>; })}</select><small>Lead Porch will select the required named audience template from this campaign. That template must be approved first.</small></label><div className="intent-draft-basis"><span>Personalization source</span><strong>{displayText(draftSignal?.title)}</strong><p>The approved template controls the message. Public evidence only determines which audience template applies; it is not turned into unapproved email copy.</p></div></> : <><header className="intent-draft-status"><div><span>{draftEditor.status === "reviewed" ? "Reviewed and unsent" : draftEditor.status === "transferred" ? "Pending in Outreach" : "Generated draft—review required"}</span><strong>{draftEditor.templateAudienceLabel ? `${draftEditor.templateAudienceLabel} · version ${draftEditor.templateVersion}` : "Old untracked draft · regenerate before Outreach"}</strong></div>{draftEditor.status !== "transferred" ? <button type="button" onClick={() => { setDraftEditor(null); setDraftError(""); }}>Choose another campaign</button> : null}</header><div className="intent-draft-links"><a href={draftEditor.eventbriteUrl} target="_blank" rel="noreferrer"><span>Eventbrite</span><strong>Included in draft ↗</strong></a><a href={draftEditor.meetupUrl} target="_blank" rel="noreferrer"><span>Meetup</span><strong>Included in draft ↗</strong></a></div><label><span>Subject</span><input disabled={draftEditor.status === "transferred"} value={draftEditor.subject || ""} onChange={(event) => setDraftEditor((current) => ({ ...current, subject: event.target.value, status: "draft" }))} /></label><label><span>Email body</span><textarea disabled={draftEditor.status === "transferred"} value={draftEditor.body || ""} onChange={(event) => setDraftEditor((current) => ({ ...current, body: event.target.value, status: "draft" }))} /></label><p className="intent-draft-placeholder"><strong>{"{{firstName}}"}</strong> stays as a placeholder until the person is researched in the CRM. A published or guessed email cannot move into Outreach.</p></>}
        {draftError ? <div className="intent-draft-error" role="alert"><strong>Action required</strong><span>{draftError}</span></div> : null}
      </div>
    </Modal>

    <Modal isOpen={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete this prospect?" footer={<><Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button onClick={remove}>Delete permanently</Button></>}><p>This removes {deleteTarget?.name || "this prospect"} from Lead Porch. This cannot be undone.</p></Modal>
  </div>;
}
