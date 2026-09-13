import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import PublicWebDiscoveryPanel from "./PublicWebDiscoveryPanel.jsx";
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
  moveIntentSignal,
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
  fetchLeadGenerationProviderAvailability,
  fetchLeadGenerationPrograms,
  proposeLeadGenerationSearch,
  approveLeadGenerationSearch,
  enrichVertexGroundingResultWithApollo,
  qualifyLeadGenerationResults,
  proposeLeadGenerationMonitor,
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
const LEADGEN_PROVIDERS = [
  ["vertex", "Vertex Grounding"],
  ["openai_web_search", "OpenAI Web Search"],
  ["pdl_person_search", "PDL Person Search"],
  ["apollo_person_search", "Apollo People Search"],
];
const LEADGEN_COUNT_OPTIONS = [5, 10, 25];
const EMPTY_ICP_DRAFT = { titles: "", industries: "", locations: "", keywords: "", seniority: "", companySizeRange: "", exclusions: "" };
const icpArrayToDraftString = (values) => (values || []).join(", ");
const icpDraftStringToArray = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

const displayText = (value) => String(value || "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:#32|nbsp);/gi, " ")
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

const DISCOVERY_LANES = [
  ["prospective_students", "Prospective students", "People with a plausible program fit or current learning signal."],
  ["communities", "Communities & partnerships", "Groups, events, directories, and organizations that need a partnership approach."],
  ["competitors", "Competitor intelligence", "Coaches, programs, and competing education offers to review—not contact."],
  ["content", "Content intelligence", "Podcasts, forums, and useful market conversations for research."],
  ["vendors", "Vendors", "Brokers, lenders, service providers, and sellers kept out of the student lane."],
  ["irrelevant", "Irrelevant results", "Not-a-fit and dismissed findings retained for review history and deduplication."],
];

const discoveryLaneOf = (result) => {
  const text = `${result.name || ""} ${result.organizationName || ""} ${result.summary || ""} ${(result.exclusionFlags || []).join(" ")}`.toLowerCase();
  if (result.status === "dismissed" || result.qualificationLabel === "not_a_fit") return "irrelevant";
  if (/\b(vendor|broker|lender|agency|consultant|service provider|software|saas|capital rais|syndicator)\b/.test(text)) return "vendors";
  if (/\b(competitor|coach|course seller|educator|training program|mastermind)\b/.test(text)) return "competitors";
  if (["podcast", "forum"].includes(result.type) || result.discoveryCategory === "intent_discussions") return "content";
  if (["community", "organization", "event", "directory"].includes(result.type) || ["facebook_groups", "communities", "organizations", "events", "directories"].includes(result.discoveryCategory)) return "communities";
  return result.type === "person" ? "prospective_students" : "content";
};

const resultImageOf = (result) => result.profileImageUrl || result.profilePictureUrl || result.avatarUrl || result.photoUrl || result.logoUrl || "";
const initialsOf = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

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
  const [activeTab, setActiveTab] = useState(() => searchParams.get("tab") || "people");
  const [monitorPresets, setMonitorPresets] = useState([]);
  const [monitorActivity, setMonitorActivity] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showMonitorSetup, setShowMonitorSetup] = useState(true);
  const [leadView, setLeadView] = useState("all");
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
  const [groundingQuery, setGroundingQuery] = useState("");
  const [groundingTypes, setGroundingTypes] = useState(["person", "organization"]);
  const [groundingSource, setGroundingSource] = useState("both");
  const [groundingBusy, setGroundingBusy] = useState(false);
  const [groundingError, setGroundingError] = useState("");
  const [groundingSourceErrors, setGroundingSourceErrors] = useState([]);
  const [suggestedSearches, setSuggestedSearches] = useState([]);
  const [leadGenProviderAvailability, setLeadGenProviderAvailability] = useState(null);
  const [leadGenSelectedSources, setLeadGenSelectedSources] = useState([]);
  const [leadGenRequestedCount, setLeadGenRequestedCount] = useState(10);
  const [leadGenIcpDraft, setLeadGenIcpDraft] = useState(EMPTY_ICP_DRAFT);
  const [leadGenPrograms, setLeadGenPrograms] = useState([]);
  // "" = nothing chosen yet (the required default); "all" = the "All
  // programs" pill; otherwise a specific program's noteId.
  const [selectedProgramPillKey, setSelectedProgramPillKey] = useState("");
  const [selectedProgramNoteId, setSelectedProgramNoteId] = useState("");
  const [leadGenRequest, setLeadGenRequest] = useState("Find likely buyers for our approved programs");
  const [leadGenProposeBusy, setLeadGenProposeBusy] = useState(false);
  const [leadGenProposal, setLeadGenProposal] = useState(null);
  const [leadGenApproveBusy, setLeadGenApproveBusy] = useState(false);
  const [leadGenError, setLeadGenError] = useState("");
  const [apolloEnrichBusyId, setApolloEnrichBusyId] = useState("");
  const [qualifyBusy, setQualifyBusy] = useState(false);
  const [monitorSuggestion, setMonitorSuggestion] = useState(null);
  const [monitorProposeBusy, setMonitorProposeBusy] = useState(false);
  const [groundingResults, setGroundingResults] = useState([]);
  const [groundingResultsLoading, setGroundingResultsLoading] = useState(false);
  const [groundingResultsStatus, setGroundingResultsStatus] = useState("pending_review");
  const [pdlEnrichBusyId, setPdlEnrichBusyId] = useState("");
  const [selectedGroundingIds, setSelectedGroundingIds] = useState([]);
  const [reviewFilters, setReviewFilters] = useState({ run: "all", newOnly: false, provider: "all", qualification: "all", location: "", freshness: "all", identityConfidence: "all" });
  const [expandedResultIds, setExpandedResultIds] = useState([]);
  const [qualifySummary, setQualifySummary] = useState(null);
  const [qualifyOutcomeFilter, setQualifyOutcomeFilter] = useState("all");
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
  const [watchedProfiles, setWatchedProfiles] = useState([{ url: "", role: "you" }, { url: "", role: "competitor" }, { url: "", role: "teammate" }]);
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

  const loadLeadGenPrograms = async () => {
    try {
      const response = await fetchLeadGenerationPrograms();
      setLeadGenPrograms(response.data || []);
    } catch {
      setLeadGenPrograms([]);
    }
  };

  const loadLeadGenProviderAvailability = async () => {
    try {
      const response = await fetchLeadGenerationProviderAvailability();
      const availability = response.data || {};
      setLeadGenProviderAvailability(availability);
      // Default-select only providers that are currently enabled and configured.
      setLeadGenSelectedSources(LEADGEN_PROVIDERS.filter(([key]) => availability[key]?.available).map(([key]) => key));
    } catch {
      setLeadGenProviderAvailability({});
      setLeadGenSelectedSources([]);
    }
  };

  // Changing sources/count after a plan was already proposed would make the
  // shown credit estimate stale, so either invalidates the current proposal
  // rather than silently leaving a mismatched estimate on screen — the
  // owner just clicks "Ask Jarvis" again for a fresh, accurate one.
  const toggleLeadGenSource = (key) => {
    setLeadGenSelectedSources((current) => current.includes(key) ? current.filter((source) => source !== key) : [...current, key]);
    setLeadGenProposal(null);
  };

  const selectLeadGenCount = (count) => {
    setLeadGenRequestedCount(count);
    setLeadGenProposal(null);
  };

  const selectLeadGenProgram = (program) => {
    setSelectedProgramPillKey(program.noteId);
    setSelectedProgramNoteId(program.noteId);
    setLeadGenProposal(null);
    setLeadGenRequest(`Find likely buyers for ${program.title}`);
  };

  const selectAllPrograms = () => {
    setSelectedProgramPillKey("all");
    setSelectedProgramNoteId("");
    setLeadGenProposal(null);
    setLeadGenRequest("Find likely buyers for our approved programs");
  };

  const proposeLeadGenSearch = async () => {
    if (!leadGenRequest.trim() || leadGenProposeBusy || !leadGenSelectedSources.length) return;
    setLeadGenProposeBusy(true);
    setLeadGenError("");
    setMonitorSuggestion(null);
    try {
      const response = await proposeLeadGenerationSearch({
        naturalLanguageRequest: leadGenRequest, programNoteId: selectedProgramNoteId || undefined,
        sources: leadGenSelectedSources, requestedCount: leadGenRequestedCount,
      });
      setLeadGenProposal(response.data);
      const icp = response.data.icp || {};
      setLeadGenIcpDraft({
        titles: icpArrayToDraftString(icp.titles), industries: icpArrayToDraftString(icp.industries),
        locations: icpArrayToDraftString(icp.locations), keywords: icpArrayToDraftString(icp.keywords),
        seniority: icpArrayToDraftString(icp.seniority), companySizeRange: icp.companySizeRange || "",
        exclusions: icpArrayToDraftString(icp.exclusions),
      });
    } catch (err) {
      setLeadGenError(err.response?.data?.error || "Unable to propose this search.");
      setLeadGenProposal(null);
    } finally {
      setLeadGenProposeBusy(false);
    }
  };

  const updateLeadGenIcpDraft = (field, value) => setLeadGenIcpDraft((current) => ({ ...current, [field]: value }));

  const approveLeadGenSearch = async () => {
    if (!leadGenProposal?._id || leadGenApproveBusy) return;
    setLeadGenApproveBusy(true);
    setLeadGenError("");
    try {
      const icpOverride = {
        titles: icpDraftStringToArray(leadGenIcpDraft.titles), industries: icpDraftStringToArray(leadGenIcpDraft.industries),
        locations: icpDraftStringToArray(leadGenIcpDraft.locations), keywords: icpDraftStringToArray(leadGenIcpDraft.keywords),
        seniority: icpDraftStringToArray(leadGenIcpDraft.seniority), companySizeRange: leadGenIcpDraft.companySizeRange,
        exclusions: icpDraftStringToArray(leadGenIcpDraft.exclusions),
      };
      const response = await approveLeadGenerationSearch(leadGenProposal._id, { icp: icpOverride, requestedCount: leadGenRequestedCount, sources: leadGenSelectedSources });
      const summary = response.data.runSummary || {};
      // The explanation already states the true survived count and why —
      // see the per-provider breakdown table rendered below for detail —
      // so the notice never leads with a generic count that could imply
      // the full requested amount was found.
      setNotice(`Search ${response.data.status}: ${summary.explanation || `${summary.created || 0} new, ${summary.merged || 0} merged, ${summary.withConflicts || 0} flagged with conflicts.`}`);
      setLeadGenProposal(response.data);
      setGroundingResultsStatus("pending_review");
      await loadGroundingResults("pending_review");
    } catch (err) {
      setLeadGenError(err.response?.data?.error || "Unable to run this search.");
    } finally {
      setLeadGenApproveBusy(false);
    }
  };

  const discardLeadGenProposal = () => { setLeadGenProposal(null); setLeadGenIcpDraft(EMPTY_ICP_DRAFT); setLeadGenError(""); };

  const enrichGroundingResultWithApollo = async (id) => {
    if (apolloEnrichBusyId) return;
    setApolloEnrichBusyId(id);
    try {
      const res = await enrichVertexGroundingResultWithApollo(id);
      const outcome = res.data.apolloEnrichment;
      setNotice(
        outcome?.error ? `Apollo enrichment error: ${outcome.errorMessage || "unknown error"}`
          : outcome?.matched ? "Apollo found a verified match."
            : "Apollo did not find a confident match — no email added.",
      );
      await loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "Apollo enrichment failed.");
    } finally {
      setApolloEnrichBusyId("");
    }
  };

  // The single "Have Jarvis qualify selected leads" action — replaces the
  // old separate "Rank for program fit" / "Qualify & recommend" buttons.
  // Jarvis scores identity confidence (recomputed from real signals),
  // program fit against ONLY this workspace's real approved programs, and
  // buyer-intent evidence as three separate signals, then combines them
  // into one qualificationLabel — see leadGenerationCoordinatorService.js's
  // qualifyAndRecommend()/computeQualificationOutcome(). Shows an accurate
  // completion summary and refreshes the cards so the change is visible.
  const qualifySelectedGroundingResults = async () => {
    if (!selectedGroundingIds.length || qualifyBusy) return;
    setQualifyBusy(true);
    setQualifySummary(null);
    try {
      const res = await qualifyLeadGenerationResults(selectedGroundingIds);
      const s = res.data.summary || { processed: res.data.qualified || 0, qualified: res.data.qualified || 0, needsReview: 0, notAFit: 0, failed: 0 };
      setQualifySummary(s);
      setNotice(`Jarvis processed ${s.processed} of ${res.data.requested} selected: ${s.qualified} qualified, ${s.needsReview} needs review, ${s.notAFit} not a fit${s.failed ? `, ${s.failed} failed` : ""}.`);
      setSelectedGroundingIds([]);
      await loadGroundingResults();
    } catch (err) {
      setNotice(err.response?.data?.error || "Qualification failed.");
    } finally {
      setQualifyBusy(false);
    }
  };

  const proposeMonitorForLeadGenSearch = async () => {
    if (!leadGenProposal?._id || monitorProposeBusy) return;
    setMonitorProposeBusy(true);
    try {
      const res = await proposeLeadGenerationMonitor(leadGenProposal._id);
      setMonitorSuggestion(res.data);
    } catch (err) {
      setNotice(err.response?.data?.error || "Unable to propose a monitor for this search.");
    } finally {
      setMonitorProposeBusy(false);
    }
  };

  const runGroundingSearch = async () => {
    if (!groundingQuery.trim() || groundingBusy || !groundingTypes.length) return;
    setGroundingBusy(true);
    setGroundingError("");
    setGroundingSourceErrors([]);
    try {
      const response = await runVertexGroundingDiscoverySearch({ query: groundingQuery, resultTypes: groundingTypes, source: groundingSource });
      const staleNote = response.data.excludedForFreshness ? ` ${response.data.excludedForFreshness} person result(s) were excluded for missing or stale (older than ${response.data.personFreshnessDays} days) evidence.` : "";
      const selfMatchNote = response.data.excludedForSelfMatch ? ` ${response.data.excludedForSelfMatch} excluded as a self-match (workspace owner/team/business).` : "";
      setNotice(`Public-web search (${response.data.source}) found ${response.data.total} result(s): ${response.data.created} new, ${response.data.merged} merged into existing pending results.${staleNote}${selfMatchNote}`);
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

  const runKeyOf = (result) => result.discoverySearchId || result.discoveryRunId || "manual";

  const toggleDetails = (id) => {
    setExpandedResultIds((current) => current.includes(id) ? current.filter((row) => row !== id) : [...current, id]);
  };

  const selectAllNewFromRun = () => {
    setSelectedGroundingIds(visibleGroundingResults.filter((r) => r.isNew).map((r) => r._id));
  };
  const selectAllVisible = () => {
    setSelectedGroundingIds(visibleGroundingResults.map((r) => r._id));
  };
  const clearGroundingSelection = () => setSelectedGroundingIds([]);

  const saveSelectedQualified = async () => {
    const qualifiedIds = visibleGroundingResults.filter((r) => selectedGroundingIds.includes(r._id) && r.qualificationLabel === "qualified").map((r) => r._id);
    if (!qualifiedIds.length) return;
    for (const id of qualifiedIds) {
      await saveGroundingResult(id);
    }
    setSelectedGroundingIds((current) => current.filter((id) => !qualifiedIds.includes(id)));
  };
  const dismissSelected = async () => {
    if (!selectedGroundingIds.length) return;
    for (const id of selectedGroundingIds) {
      await dismissGroundingResult(id);
    }
    setSelectedGroundingIds([]);
  };

  // One entry per distinct run (a DiscoverySearch or PublicWebDiscoveryRun)
  // present in the currently-loaded results, newest first — so the owner
  // can filter to exactly today's batch and never accidentally select an
  // older run's results alongside it.
  const runOptions = useMemo(() => {
    const groups = new Map();
    for (const r of groundingResults) {
      const key = runKeyOf(r);
      if (!groups.has(key)) groups.set(key, { key, count: 0, latest: r.createdAt, kind: r.discoverySearchId ? "search" : r.discoveryRunId ? "high-volume run" : "manual/other" });
      const g = groups.get(key);
      g.count += 1;
      if (new Date(r.createdAt) > new Date(g.latest)) g.latest = r.createdAt;
    }
    return [...groups.values()].sort((a, b) => new Date(b.latest) - new Date(a.latest));
  }, [groundingResults]);

  const providerOptions = useMemo(() => [...new Set(groundingResults.flatMap((r) => r.providers || []))].sort(), [groundingResults]);

  const visibleGroundingResults = useMemo(() => groundingResults.filter((r) => {
    if (reviewFilters.run !== "all" && runKeyOf(r) !== reviewFilters.run) return false;
    if (reviewFilters.newOnly && !r.isNew) return false;
    if (reviewFilters.provider !== "all" && !(r.providers || []).includes(reviewFilters.provider)) return false;
    if (reviewFilters.qualification !== "all" && (r.qualificationLabel || "unscored") !== reviewFilters.qualification) return false;
    if (reviewFilters.location.trim() && !`${r.summary || ""} ${r.organizationName || ""}`.toLowerCase().includes(reviewFilters.location.trim().toLowerCase())) return false;
    if (reviewFilters.freshness !== "all" && (r.freshnessTier || "n/a") !== reviewFilters.freshness) return false;
    if (reviewFilters.identityConfidence !== "all" && (r.identityConfidence || "low") !== reviewFilters.identityConfidence) return false;
    if (qualifyOutcomeFilter !== "all" && (r.qualificationLabel || "") !== qualifyOutcomeFilter) return false;
    return true;
  }), [groundingResults, reviewFilters, qualifyOutcomeFilter]);

  const groundingResultsByLane = useMemo(() => {
    const lanes = Object.fromEntries(DISCOVERY_LANES.map(([key]) => [key, []]));
    visibleGroundingResults.forEach((result) => lanes[discoveryLaneOf(result)].push(result));
    return lanes;
  }, [visibleGroundingResults]);

  useEffect(() => {
    if (activeTab !== "people") return undefined;
    const timer = window.setTimeout(() => { loadGroundingResults(); loadSuggestedSearches(); loadLeadGenPrograms(); loadLeadGenProviderAvailability(); }, 0);
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

  /**
   * A persistent, explicit human override — always wins over the automatic
   * classifier from now on (see routes/audience.js's GET /research/signals).
   * Refreshes the current track afterward so the moved item disappears
   * from it immediately, and the tab counts reflect the change right away.
   */
  const moveTrackSignal = async (signal, bucket) => {
    if (signalBusyId) return;
    setSignalBusyId(signal._id);
    try {
      await moveIntentSignal(signal._id, bucket);
      await loadDiscoveryTrack(discoveryTrack);
    } catch (err) {
      setTrackError(err.response?.data?.error || "Unable to move this result.");
    } finally {
      setSignalBusyId("");
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
        watchedProfiles: watchedProfiles.filter((profile) => profile.url.trim()),
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
    <header className="discovery-header discovery-header--minimal"><div><h1>Discovery</h1><p>Find people, listen for buying signals, and review every match.</p></div><button className="notification-button" type="button" onClick={() => setShowNotifications((value) => !value)} aria-expanded={showNotifications} aria-label={`${notifications.filter((item) => !item.readAt).length} discovery updates`}>Updates {notifications.filter((item) => !item.readAt).length ? <span>{notifications.filter((item) => !item.readAt).length}</span> : null}</button></header>

    {showNotifications ? <div className="notification-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNotifications(false); }}><section className="notification-panel" role="dialog" aria-modal="true" aria-label="Monitoring notifications"><header><div><strong>Notifications</strong><span>{notifications.filter((item) => !item.readAt).length} unread · select one to open its destination</span></div><div className="notification-panel__controls">{notifications.length ? <button type="button" onClick={clearNotifications}>Clear all</button> : null}<button type="button" onClick={() => setShowNotifications(false)} aria-label="Close notifications">Close ×</button></div></header><div className="notification-list">{notifications.length ? notifications.slice(0, 20).map((item) => <button type="button" key={item._id} className={item.readAt ? "is-read" : ""} onClick={() => openNotification(item)}><strong>{item.type === "source_failure" ? "Some sources are retrying" : item.title}</strong><span>{item.type === "source_failure" ? "Other sources still completed. Select this to open monitoring details." : item.message}</span><small>{new Date(item.createdAt).toLocaleString()} · Open {item.actionUrl ? "Privacy requests" : ["high_score", "published_email", "qualified_lead"].includes(item.type) ? "Live Leads" : "Intent Monitoring"}</small></button>) : <p>No notifications yet.</p>}</div></section></div> : null}

    <nav className="discovery-flow-nav" aria-label="Discovery actions">
      <button type="button" className={activeTab === "people" ? "is-active" : ""} onClick={() => setActiveTab("people")}>Find people</button>
      <button type="button" className={activeTab === "leads" ? "is-active" : ""} onClick={() => setActiveTab("leads")}>Review leads {bucketSummary.live_lead ? <span>{bucketSummary.live_lead}</span> : null}</button>
      <button type="button" className={activeTab === "monitoring" ? "is-active" : ""} onClick={() => setActiveTab("monitoring")}>LinkedIn listening</button>
      <details><summary>Other tools</summary><div><button type="button" onClick={() => setActiveTab("company")}>Find companies</button><button type="button" onClick={() => setActiveTab("saved")}>Past searches</button></div></details>
    </nav>

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

    {activeTab === "monitoring" ? <><section className="discovery-section-heading"><div><span>LinkedIn listening</span><h2>Profiles and topics to watch</h2><p>Add your LinkedIn URL, a competitor, and a teammate or expert below. Lead Porch checks publicly indexed activity only.</p></div></section>
    <details className="monitor-performance-drawer"><summary>Search performance and recommendations</summary><DashboardCard title="Search quality — measured by enrollments and revenue, not raw volume" action={<div className="lead-view-tabs"><Button variant="outline" size="sm" loading={monitorPerformanceLoading} onClick={loadMonitorPerformance}>Refresh</Button><Button size="sm" disabled={strategyBusy} onClick={runStrategyRecommendations}>{strategyBusy ? "Analyzing…" : "Get AI strategy recommendations"}</Button></div>}>
      {!monitorPerformance ? <p>Loading monitor performance…</p> : <div className="monitor-performance-table"><table><thead><tr><th>Monitor</th><th>Candidates</th><th>Live leads</th><th>Rejected</th><th>Enrolled</th><th>Won revenue</th></tr></thead><tbody>{monitorPerformance.performance.map((row) => <tr key={row.monitorId}><td>{row.name}{!row.enabled ? <small> (disabled)</small> : null}</td><td>{row.totalCandidates}</td><td>{row.buckets.live_lead}</td><td>{row.rejectionRate}%</td><td>{row.enrolled}</td><td>${row.wonRevenue.toLocaleString()}</td></tr>)}</tbody></table></div>}
      {monitorPerformance?.recommendations?.length ? <div className="monitor-recommendations"><strong>Recommendations</strong><ul>{monitorPerformance.recommendations.map((rec, index) => <li key={index}><b>{rec.monitorName}:</b> {rec.detail}</li>)}</ul></div> : null}
      {strategyError ? <p className="form-error" role="alert">{strategyError}</p> : null}
      {strategy ? <div className="discovery-strategy-result">
        <p>{strategy.summary}</p>
        {strategy.coverageGaps?.length ? <><strong>Coverage gaps</strong><ul>{strategy.coverageGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></> : null}
        {strategy.monitorsToReview?.length ? <><strong>Monitors to review</strong><ul>{strategy.monitorsToReview.map((item, index) => <li key={index}><b>{item.monitorName}</b> — {item.issue}: {item.recommendation}</li>)}</ul></> : null}
        {strategy.suggestedSearches?.length ? <><strong>Suggested new searches</strong><ul>{strategy.suggestedSearches.map((item, index) => <li key={index}><b>{item.program}:</b> {item.query} — {item.rationale}</li>)}</ul></> : null}
      </div> : null}
    </DashboardCard></details>

    <DashboardCard title="Your active monitors" action={<div className="monitor-header-actions"><Button variant="outline" onClick={loadAutomaticResearch}>Refresh</Button><Button onClick={() => setShowMonitorSetup((value) => !value)}>{showMonitorSetup ? "Close setup" : "Create a monitor"}</Button></div>}>
      {showMonitorSetup ? <section className="monitor-setup-panel"><header><span>New automatic search</span><h3>What should Lead Porch listen for?</h3><p>Start with a Jarvis-generated setup, then edit the topics and sources before turning it on.</p></header>{monitorPresets.map((preset) => <button className="monitor-preset" type="button" key={preset.id} onClick={() => applyMonitorPreset(preset)}><span>Jarvis starting point</span><strong>{preset.name}</strong><small>{preset.monitorType === "investor_profile" ? "Find multifamily-relevant professionals or self-described investors; titles alone never qualify" : preset.monitorType === "community_partner" ? "Find public community organizations and organizers—not individual members" : "Find specific public multifamily questions, problems, or learning requests"}</small></button>)}<div className="intent-monitor-builder">
        <label><span>What should this monitor find?</span><select value={monitorDraft.monitorType} onChange={(event) => { const type = event.target.value; setMonitorDraft((current) => ({ ...current, monitorType: type })); setSelectedSources(monitorSources(type)); }}><option value="investor_profile">Qualified investor prospects</option><option value="buyer_intent">Individual student / buyer intent</option><option value="community_partner">Community partners</option></select><small>Student intent, investor fit, and community discovery use separate eligibility rules and source defaults.</small></label><label><span>Monitor name</span><input value={monitorDraft.name} onChange={(event) => setMonitorDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label><span>Check frequency</span><select value={monitorDraft.intervalMinutes} onChange={(event) => setMonitorDraft((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))}><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={1440}>Daily</option></select></label>
        <label className="span-2"><span>{monitorAudienceLabel(monitorDraft.monitorType)}</span><textarea value={monitorDraft.query} onChange={(event) => setMonitorDraft((current) => ({ ...current, query: event.target.value }))} /></label>
        <label className="span-2"><span>{monitorKeywordLabel(monitorDraft.monitorType)}</span><textarea value={monitorDraft.keywords} onChange={(event) => setMonitorDraft((current) => ({ ...current, keywords: event.target.value }))} /><small>Jarvis generated this starting list. Use commas or new lines; you can change every phrase.</small></label>
        <section className="monitor-watchlist-options span-2"><div className="monitor-signal-card"><header><span>in</span><div><strong>LinkedIn profiles to watch</strong><small>Add the public profiles whose audience activity may reveal relevant buyers.</small></div></header>{watchedProfiles.map((profile, index) => <label key={index}><span className="sr-only">LinkedIn profile {index + 1} URL</span><input aria-label={`LinkedIn profile ${index + 1} URL`} value={profile.url} onChange={(event) => setWatchedProfiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://www.linkedin.com/in/..."/><select aria-label={`LinkedIn profile ${index + 1} relationship`} value={profile.role} onChange={(event) => setWatchedProfiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value } : item))}><option value="you">My profile</option><option value="competitor">Competitor</option><option value="teammate">Teammate</option><option value="expert">Industry expert</option><option value="partner">Partner</option></select></label>)}<button type="button" onClick={() => setWatchedProfiles((current) => [...current, { url: "", role: "expert" }])}>+ Add another profile</button><p>Publicly indexed activity only. Lead Porch cannot read private posts, messages, or member lists.</p></div></section>
        {monitorDraft.intentCategories?.length ? <div className="intent-category-editor span-2">{monitorDraft.intentCategories.map((category, categoryIndex) => <label key={`${category.name}-${categoryIndex}`}><span>{category.name}</span><textarea value={(category.phrases || []).join("\n")} onChange={(event) => setMonitorDraft((current) => ({ ...current, intentCategories: current.intentCategories.map((item, index) => index === categoryIndex ? { ...item, phrases: splitValues(event.target.value) } : item) }))} /></label>)}</div> : null}
        <label className="span-2"><span>Always ignore</span><textarea value={monitorDraft.negativeKeywords} onChange={(event) => setMonitorDraft((current) => ({ ...current, negativeKeywords: event.target.value }))} /></label>
        <details className="advanced-monitor-options span-2"><summary>Advanced source options</summary><label><span>{monitorDraft.monitorType === "community_partner" ? "Public community or feed URLs" : "Public discussion or feed URLs"}</span><textarea value={monitorDraft.feedUrls} onChange={(event) => setMonitorDraft((current) => ({ ...current, feedUrls: event.target.value }))} placeholder={monitorDraft.monitorType === "community_partner" ? "One public community URL per line" : "One public forum, discussion, RSS, or Atom URL per line"} /><small>{monitorDraft.monitorType === "community_partner" ? "Public LinkedIn/Facebook group pages, Meetup, REIA, and other community directories provide community metadata—not member conversations." : "Use URLs that expose specific public discussions. A directory, group description, or professional title is not buyer intent."}</small></label><div className="intent-source-chips">{SOURCE_OPTIONS.filter(([, , use]) => use === "all" || (monitorDraft.monitorType === "community_partner" && use === "community") || (monitorDraft.monitorType !== "buyer_intent" && use === "nonstudent")).map(([id, label]) => <button type="button" className={`${selectedSources.includes(id) ? "is-on" : ""} ${UNSTABLE_MONITOR_SOURCES.has(id) ? "is-optional" : ""}`} key={id} onClick={() => toggleDraftSource(id)}>{selectedSources.includes(id) ? "On · " : "Off · "}{label}</button>)}</div><div className="public-community-sources"><strong>Public web / community discovery</strong><span>Indexed public pages and metadata only. These sources do not mean a customer social account is connected.</span><small>Connected social accounts are a separate OAuth capability. Without authorization, Lead Porch cannot access private groups, authenticated feeds, private posts, DMs, member lists, or private profiles.</small></div></details>
      </div>
      <div className="monitor-setup-actions"><Button loading={monitorSaving} disabled={!monitorDraft.query.trim()} onClick={createMonitor}>Start this monitor</Button><small>You can pause it at any time. No outreach is ever sent.</small></div></section> : null}
      {monitors.length ? <div className="intent-monitor-list">{monitors.map((monitor) => { const monitorSignals = intentSignals.filter((signal) => String(signal.monitorId) === String(monitor._id) && signal.status !== "dismissed"); const currentLeadCount = monitorSignals.length; const failures = (monitor.sourceHealth || []).filter((health) => (monitor.sources || []).includes(health.source) && ["failed", "blocked", "rate_limited"].includes(health.state)); return <article key={monitor._id}>
        <header className="monitor-card-header"><div><span className={`intent-monitor-state is-${monitor.lastRunStatus}`}>{monitor.lastRunStatus === "never" && monitor.enabled ? "Starting first check now" : monitor.lastRunStatus === "running" ? "Checking public sources now" : monitor.enabled ? "Monitoring is on" : "Monitoring paused"}</span><strong>{monitor.name}</strong><small>Goal: find {monitorGoal(monitor.monitorType)}</small></div><div className="intent-monitor-actions">{(monitor.sources || []).some((source) => UNSTABLE_MONITOR_SOURCES.has(source)) ? <Button size="sm" onClick={() => repairMonitorSources(monitor)}>Fix source list</Button> : <Button size="sm" onClick={() => openQualityEditor(monitor)}>Improve lead quality</Button>}<Button size="sm" variant="outline" loading={monitorRunningId === monitor._id} disabled={!monitor.enabled || monitor.lastRunStatus === "running"} onClick={() => runMonitorNow(monitor._id)}>Run again now</Button><Button size="sm" variant="outline" onClick={() => toggleMonitor(monitor)}>{monitor.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" disabled={monitorRunningId === monitor._id} onClick={() => removeMonitor(monitor)}>Delete</Button></div></header>
        {monitor.lastRunStatus !== "running" ? monitor.lastRunFunnel?.engineVersion === "acquisition-v2" ? <div className="monitor-run-funnel"><strong>Latest acquisition funnel</strong><span>{monitor.lastRunFunnel.candidatesFetched || 0}<small>Candidates fetched</small></span><span>{monitor.lastRunFunnel.uniqueEvidenceEvaluated || 0}<small>Unique discussions/evidence evaluated</small></span><span>{monitor.lastRunFunnel.weakMatchesRejected || 0}<small>Weak matches rejected</small></span><span>{monitor.lastRunFunnel.qualifiedOpportunities || 0}<small>Qualified opportunities</small></span></div> : <div className="monitor-count-explainer"><strong>Legacy monitor history</strong><span>Stored totals predate the current acquisition funnel and may represent cumulative or raw processing activity. They are preserved, not reinterpreted.</span></div> : null}
        {(monitor.feedUrls || []).some(isBiggerPocketsUrl) ? <div className="public-community-sources"><strong>BiggerPockets legacy URL</strong><span>The saved URL is preserved, but Lead Porch has no dedicated reliable BiggerPockets adapter.</span><small>Current acquisition uses Bing-indexed public BiggerPockets results only. It does not crawl behind authentication or anti-bot controls.</small></div> : null}
        {monitor.watchedProfiles?.length ? <div className="public-community-sources"><strong>Watching {monitor.watchedProfiles.length} public LinkedIn profile{monitor.watchedProfiles.length === 1 ? "" : "s"}</strong><span>{monitor.watchedProfiles.map((profile) => `${profile.role}: ${profile.url}`).join(" · ")}</span><small>Publicly indexed activity only. Lead Porch does not log into, scrape, or message through these profiles.</small></div> : null}
        {monitor.lastRunStatus === "running" ? <div className="monitor-run-progress" role="status"><span className="monitor-run-progress__spinner"/><div><strong>Search is running now</strong><p>Lead Porch is checking each enabled source. Totals and the next hourly check will appear only after this search finishes. You can leave this page.</p><small>Started {monitor.lastRunAt ? new Date(monitor.lastRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"}</small></div></div> : <><div className="monitor-card-summary"><div><strong>{currentLeadCount}</strong><span>current deduplicated leads in Live Leads</span></div><div><strong>{monitor.nextRunAt ? new Date(monitor.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</strong><span>next automatic check</span></div><div><strong>{failures.length}</strong><span>{failures.length ? failures.map((health) => health.source.replaceAll("_", " ")).join(", ") + " will retry next check" : "all enabled sources completed"}</span></div></div><div className="monitor-count-explainer"><strong>{currentLeadCount ? "Review the results" : "No qualified matches yet"}</strong><span>{currentLeadCount ? "This is the same deduplicated count shown in Live Leads." : `The completed search did not find a result that passed the ${monitor.monitorType === "investor_profile" ? "professional and investor-fit" : monitor.monitorType === "community_partner" ? "community-partner" : "buyer-intent"} filters. The monitor will search again automatically.`}</span><button type="button" onClick={() => setActiveTab("leads")}>Open Live Leads</button></div>{(monitor.feedUrls || []).length ? <div className="public-community-sources monitor-saved-urls"><strong>Saved public URLs</strong><span>{monitor.feedUrls.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{index ? " · " : ""}{url}</a>)}</span><small>{monitor.feedUrls.some(isBiggerPocketsUrl) ? "BiggerPockets is preserved as legacy configuration and is discovered through Bing indexing only." : "Supported accessible pages or feeds contribute candidates to the latest-run funnel."}</small></div> : null}<p className="monitor-last-result">Latest completed check: {friendlyMonitorMessage(monitor.lastRunMessage) || "No completed check yet."}</p></>}
        {qualityEditingId === String(monitor._id) ? <section className="quality-editor"><header><div><span>Improve future results</span><h3>Teach Lead Porch what a good lead looks like</h3></div><button type="button" onClick={() => setQualityEditingId("")}>Close</button></header><div><label><span>Who is a good buyer?</span><textarea value={qualityDraft.query} onChange={(event) => setQualityDraft((current) => ({ ...current, query: event.target.value }))} /><small>Describe an adult with the role, business situation, and reason they could benefit from the event.</small></label><label><span>Language that signals buying interest</span><textarea value={qualityDraft.keywords} onChange={(event) => setQualityDraft((current) => ({ ...current, keywords: event.target.value }))} /><small>Use specific phrases such as “looking for a business coach” or “need systems to scale.”</small></label><label><span>Always reject</span><textarea value={qualityDraft.negativeKeywords} onChange={(event) => setQualityDraft((current) => ({ ...current, negativeKeywords: event.target.value }))} /><small>Minors, schoolwork, no-budget posts, promotions, and job seekers are also blocked automatically.</small></label><label><span>Public community or feed URLs</span><textarea value={qualityDraft.feedUrls} onChange={(event) => setQualityDraft((current) => ({ ...current, feedUrls: event.target.value }))} placeholder="One public RSS, Atom, or accessible discussion URL per line" /><small>Use a documented public feed or a normal public discussion page. BiggerPockets is available through Bing-indexed discovery only, not as a dedicated direct feed.</small></label></div><footer><Button loading={qualitySaving} onClick={() => saveLeadQuality(monitor)}>Save and check again</Button><span>This changes future monitoring. It does not contact anyone.</span></footer></section> : null}
        <div className="public-community-sources"><strong>Where this monitor is actually searching</strong><span>{(monitor.sourceHealth || []).filter((health) => monitorSourceEnabled(monitor, health.source)).map((health) => health.source.replaceAll("_", " ") + ": " + friendlySourceState(health.state)).join(" · ") || "Waiting for the first check"}</span><small>Facebook and LinkedIn private group posts: unavailable without platform-approved group access. Public group pages can only be found when a directory or search engine exposes them.</small></div><details className="monitor-details"><summary>Source details and errors</summary><p>Each source reports whether it completed and what needs attention. A failed optional source does not erase results from sources that worked.</p><div className="source-health-list">{(monitor.sourceHealth || []).map((health) => { const contribution = monitor.lastRunFunnel?.sourceContributions?.find((item) => item.source === health.source)?.candidates; const completed = ["healthy", "empty"].includes(health.state) && health.lastSuccessfulCheck; return <div key={health.source} className={monitorSourceEnabled(monitor, health.source) ? `is-` : "is-disabled"}><span className="source-health-dot"></span><strong>{health.source.replaceAll("_", " ")}</strong><span>{monitorSourceEnabled(monitor, health.source) ? friendlySourceState(health.state) : "Disabled"}</span><small>{monitor.lastRunFunnel?.engineVersion === "acquisition-v2" ? `${contribution ?? 0} candidates contributed in the latest run` : `${health.resultsCollected || 0} legacy stored source count`}</small><small>{completed ? `Completed ${new Date(health.lastSuccessfulCheck).toLocaleString()}` : sourceAction(health)}</small>{health.source === "feeds" ? <span>Managed by saved URLs</span> : <button type="button" onClick={() => toggleExistingSource(monitor, health.source)}>{monitorSourceEnabled(monitor, health.source) ? "Disable" : "Enable"}</button>}</div>; })}</div></details>
      </article>; })}</div> : <div className="friendly-empty"><strong>No monitors yet</strong><p>Create one above and Lead Porch will begin checking its purpose-built public sources automatically.</p></div>}
    </DashboardCard>

    <details className="activity-drawer"><summary>View monitoring activity</summary><p className="activity-help">This is an optional audit trail. Source retries are informational; you do not need to fix them.</p><div className="monitor-timeline">{monitorActivity.length ? monitorActivity.slice(0, 20).map((item) => <article key={item._id} className={`is-${item.type}`}><span></span><div><strong>{friendlyActivityMessage(item)}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></div></article>) : <p>No activity yet.</p>}</div></details></> : null}

    {activeTab === "leads" ? <><section className="discovery-section-heading"><div><span>Review leads</span><h2>{bucketSummary.live_lead} live lead{bucketSummary.live_lead === 1 ? "" : "s"}</h2><p>{intentSignals.length} lead records are loaded below. Choose a view to review or continue their next action.</p></div></section>
    <section className="discovery-track-tabs" aria-label="Discovery track">{[["live_lead", "Live Leads", bucketSummary.live_lead], ["watchlist", "Watchlist", bucketSummary.watchlist], ["community_opportunity", "Community Opportunities", bucketSummary.community_opportunity], ["rejected", "Rejected", bucketSummary.rejected]].map(([id, label, count]) => <button key={id} type="button" className={discoveryTrack === id ? "is-active" : ""} onClick={() => loadDiscoveryTrack(id)}>{label} {count}</button>)}</section>
    {discoveryTrack !== "live_lead" ? <DashboardCard title={discoveryTrack === "watchlist" ? "Watchlist — relevant people without confirmed current intent" : discoveryTrack === "community_opportunity" ? "Community Opportunities" : "Rejected — recorded reason for every irrelevant result"}>
      {trackError ? <p className="form-error" role="alert">{trackError}</p> : null}
      {trackLoading ? <p>Loading…</p> : trackSignals.length ? <div className="intent-signal-list">{trackSignals.map((signal) => <article key={signal._id} className="track-signal">
        <div className="intent-signal-main"><div><span>{intentSourceLabel(signal)} · {signal.monitorName}</span><small>{signal.publishedAt ? new Date(signal.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"}</small></div><h3>{displayText(signal.title) || "Public evidence requiring review"}</h3><p>{displayText(signal.excerpt) || "Open the original source to review the context."}</p>
          {discoveryTrack === "rejected" ? <div className="signal-why"><strong>Rejected: {String(signal.rejectionReason || "other").replaceAll("_", " ")}</strong><span>{(signal.scoreReasons || []).slice(0, 3).join(" · ")}</span></div> : null}
          {discoveryTrack === "watchlist" ? <div className="signal-why"><strong>Score {signal.score}/100 — relevant but no confirmed current need yet</strong><span>{(signal.scoreReasons || []).slice(0, 4).join(" · ")}</span></div> : null}
          {discoveryTrack === "community_opportunity" ? <div className="signal-why"><strong>{signal.communityProfile?.platform || "Community"}</strong><span>Audience: {signal.communityProfile?.audienceFit || "Real-estate investing"} · Organizer: {signal.communityProfile?.organizerEvidence || "Not yet identified"}</span><span>Promotion rules: {signal.communityProfile?.promotionRules}</span><span>Recommended approach: {signal.communityProfile?.recommendedApproach}</span></div> : null}
          <a href={signal.sourceUrl} target="_blank" rel="noreferrer">View exact public evidence ↗</a>
        </div>
        <div className="intent-signal-actions">
          {discoveryTrack === "watchlist" ? <Button size="sm" loading={signalBusyId === signal._id} onClick={() => moveTrackSignal(signal, "live_lead")}>Move to Live Leads</Button> : null}
          {discoveryTrack === "community_opportunity" ? <Button size="sm" loading={signalBusyId === signal._id} onClick={() => moveTrackSignal(signal, "live_lead")}>Move to Live Leads</Button> : null}
          {discoveryTrack !== "rejected" ? <Button size="sm" variant="outline" disabled={signalBusyId === signal._id} onClick={() => moveTrackSignal(signal, "rejected")}>Not a fit</Button> : <Button size="sm" variant="outline" disabled={signalBusyId === signal._id} onClick={() => moveTrackSignal(signal, "watchlist")}>Restore to Watchlist</Button>}
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

    {/* "discovery-workflow" was deliberately dropped from this wrapper's
        classes — DiscoveryReview.css defines an UNRELATED, older
        .discovery-workflow rule (a 3-column grid for a small numbered-
        badge row) that collided with this entirely different People
        Research layout, forcing the hero and the Step 1/2/3 sections
        into three equal columns instead of stacking — that's what was
        squeezing the hero's heading into single-word-per-line wrapping
        and jamming Step 1/Step 2 side by side with a mismatched-height
        empty gap. .people-research-workspace alone already provides the
        real (single-column, vertically-stacked) layout for this page. */}
    {activeTab === "people" ? <div id="people-research-previews" className="people-research-workspace">
      <details className="discovery-prior-results">
      <summary>Previously staged Jarvis searches ({peoplePreviews.length})</summary>
      <DashboardCard title="Previous Jarvis research" action={<Button variant="outline" loading={peoplePreviewsLoading} onClick={loadPeoplePreviews}>Refresh</Button>}>
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
      </DashboardCard></details>

      <section className="discovery-workflow-section" aria-labelledby="find-leads-heading"><header><span>Step 1</span><h2 id="find-leads-heading">What are you selling?</h2><p>Choose the program you want students or buyers for. That is all you need to start.</p></header>
      <DashboardCard title="Choose a program">
        <p className="people-preview-intro">
          Jarvis reads the approved program details and creates the audience, keywords, and buying signals automatically. <strong>You will see the exact plan and estimated cost before anything runs.</strong>
        </p>

        <div className="leadgen-field-group">
          <span className="leadgen-field-label">Program {leadGenPrograms.length ? `(${leadGenPrograms.length} approved)` : ""}</span>
          <div className="leadgen-pill-row" role="group" aria-label="Choose an approved program">
            <button type="button" className={`leadgen-pill${selectedProgramPillKey === "all" ? " is-selected" : ""}`} aria-pressed={selectedProgramPillKey === "all"} onClick={selectAllPrograms}>
              All programs
            </button>
            {leadGenPrograms.map((program) => (
              <button key={program.noteId} type="button" className={`leadgen-pill${selectedProgramPillKey === program.noteId ? " is-selected" : ""}`} aria-pressed={selectedProgramPillKey === program.noteId} onClick={() => selectLeadGenProgram(program)}>
                {program.title}
              </button>
            ))}
          </div>
        </div>

        <details className="leadgen-search-settings">
          <summary>Search settings <small>Optional — the recommended choices are already selected</small></summary>
        <div className="leadgen-field-group">
          <span className="leadgen-field-label">Where Lead Porch can look</span>
          <div className="leadgen-pill-row" role="group" aria-label="Choose sourcing providers">
            {LEADGEN_PROVIDERS.map(([key, label]) => {
              const availability = leadGenProviderAvailability?.[key];
              const isAvailable = Boolean(availability?.available);
              const isSelected = leadGenSelectedSources.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={`leadgen-pill${isSelected ? " is-selected" : ""}${isAvailable ? "" : " is-disabled"}`}
                  aria-pressed={isSelected}
                  disabled={!isAvailable || leadGenProposeBusy}
                  title={isAvailable ? "" : (availability?.reason || "Not currently available")}
                  onClick={() => toggleLeadGenSource(key)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {LEADGEN_PROVIDERS.some(([key]) => !leadGenProviderAvailability?.[key]?.available) ? (
            <small className="leadgen-provider-reasons">
              {LEADGEN_PROVIDERS.filter(([key]) => !leadGenProviderAvailability?.[key]?.available).map(([key, label]) => (
                <span key={key}>{label} — {leadGenProviderAvailability?.[key]?.reason || "Not currently available"}</span>
              ))}
            </small>
          ) : null}
        </div>

        <div className="leadgen-field-group">
          <span className="leadgen-field-label">Maximum number of people</span>
          <div className="leadgen-pill-row" role="group" aria-label="Choose how many people to find">
            {LEADGEN_COUNT_OPTIONS.map((count) => (
              <button key={count} type="button" className={`leadgen-pill${leadGenRequestedCount === count ? " is-selected" : ""}`} aria-pressed={leadGenRequestedCount === count} onClick={() => selectLeadGenCount(count)}>
                {count}
              </button>
            ))}
          </div>
        </div>
        </details>

        <div className="people-search-launcher">
          <details className="leadgen-optional-request"><summary>Optional: give Jarvis extra direction</summary><label><span>Only use this if you want to narrow the program&apos;s normal audience</span><textarea value={leadGenRequest} onChange={(event) => setLeadGenRequest(event.target.value)} placeholder="For example: Focus on buyers in Texas" disabled={leadGenProposeBusy} /></label></details>
          <div>
            <Button disabled={!leadGenRequest.trim() || !leadGenSelectedSources.length} loading={leadGenProposeBusy} onClick={proposeLeadGenSearch}>
              {leadGenProposeBusy ? "Building your plan…" : "Build my search plan"}
            </Button>
          </div>
          {!leadGenSelectedSources.length ? <p className="form-error">Select at least one available source above.</p> : null}
          {leadGenError ? <p className="form-error">{leadGenError}</p> : null}
        </div>

        {leadGenProposal ? (
          <section className="leadgen-review-panel" role="region" aria-labelledby="leadgen-review-heading" aria-live="polite">
            <h4 id="leadgen-review-heading">{leadGenProposal.status === "proposed" ? "Review before running — nothing spent yet" : `Search ${leadGenProposal.status}`}</h4>

            {leadGenProposal.status === "proposed" ? (
              <><section className="leadgen-signal-editor"><header><span>#</span><div><strong>Keywords and relevant topics</strong><small>Auto-generated from the selected program. Remove or edit anything that is not useful.</small></div></header><div className="leadgen-signal-chips">{icpDraftStringToArray(leadGenIcpDraft.keywords).map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section><div className="leadgen-review-grid">
                <label><span>Program</span><input type="text" value={leadGenProposal.programName || "(not specified)"} readOnly /></label>
                <label><span>Titles</span><input type="text" value={leadGenIcpDraft.titles} onChange={(event) => updateLeadGenIcpDraft("titles", event.target.value)} placeholder="comma-separated" /></label>
                <label><span>Industries</span><input type="text" value={leadGenIcpDraft.industries} onChange={(event) => updateLeadGenIcpDraft("industries", event.target.value)} placeholder="comma-separated" /></label>
                <label><span>Locations</span><input type="text" value={leadGenIcpDraft.locations} onChange={(event) => updateLeadGenIcpDraft("locations", event.target.value)} placeholder="comma-separated" /></label>
                <label><span>Keywords</span><input type="text" value={leadGenIcpDraft.keywords} onChange={(event) => updateLeadGenIcpDraft("keywords", event.target.value)} placeholder="comma-separated" /></label>
                <label><span>Seniority</span><input type="text" value={leadGenIcpDraft.seniority} onChange={(event) => updateLeadGenIcpDraft("seniority", event.target.value)} placeholder="comma-separated" /></label>
                <label><span>Company size</span><input type="text" value={leadGenIcpDraft.companySizeRange} onChange={(event) => updateLeadGenIcpDraft("companySizeRange", event.target.value)} /></label>
                <label><span>Exclusions</span><input type="text" value={leadGenIcpDraft.exclusions} onChange={(event) => updateLeadGenIcpDraft("exclusions", event.target.value)} placeholder="comma-separated, e.g. current customers" /></label>
              </div></>
            ) : (
              <dl className="leadgen-review-grid">
                <dt>Program</dt><dd>{leadGenProposal.programName || "(not specified)"}</dd>
                <dt>Titles</dt><dd>{leadGenProposal.icp?.titles?.join(", ") || "(broad)"}</dd>
                <dt>Exclusions</dt><dd>{leadGenProposal.icp?.exclusions?.join(", ") || "None"}</dd>
              </dl>
            )}

            <dl className="leadgen-review-summary">
              <dt>Freshness</dt><dd>Public-web evidence within {leadGenProposal.freshnessDays} days</dd>
              <dt>Sources</dt><dd>{leadGenProposal.sources.join(", ")}</dd>
              <dt>Requested count</dt><dd>Up to {leadGenProposal.requestedCount} people</dd>
              <dt>Estimated credit use</dt>
              <dd>
                {leadGenProposal.estimatedCreditUse?.pdl ? `PDL: up to ${leadGenProposal.estimatedCreditUse.pdl} · ` : ""}
                {leadGenProposal.estimatedCreditUse?.apollo ? `Apollo: up to ${leadGenProposal.estimatedCreditUse.apollo} · ` : ""}
                {leadGenProposal.estimatedCreditUse?.vertex || ""} {leadGenProposal.estimatedCreditUse?.openai || ""}
                <br /><small>{leadGenProposal.estimatedCreditUse?.note}</small>
              </dd>
              <dt>Destination</dt><dd>Review queue below — nothing is imported into the CRM automatically.</dd>
            </dl>

            {leadGenProposal.status !== "proposed" && leadGenProposal.runSummary ? (
              <div className="leadgen-run-summary">
                <p className="leadgen-run-explanation">{leadGenProposal.runSummary.explanation || `${leadGenProposal.runSummary.created || 0} new, ${leadGenProposal.runSummary.merged || 0} merged.`}</p>
                {leadGenProposal.runSummary.providerBreakdown?.length ? (
                  <div className="leadgen-provider-breakdown-wrap">
                    <table className="leadgen-provider-breakdown">
                      <thead>
                        <tr><th>Provider</th><th>Requested</th><th>Returned</th><th>Rejected: self</th><th>Rejected: freshness</th><th>Rejected: dedup</th><th>Accepted</th><th>Error</th></tr>
                      </thead>
                      <tbody>
                        {leadGenProposal.runSummary.providerBreakdown.map((row, index) => (
                          <tr key={`${row.provider}-${index}`}>
                            <td>{row.provider}</td>
                            <td>{row.requested}</td>
                            <td>{row.returned}</td>
                            <td>{row.rejectedSelf}</td>
                            <td>{row.rejectedFreshness}</td>
                            <td>{row.rejectedDedup}</td>
                            <td>{row.accepted}</td>
                            <td>{row.error ? <span className="form-error">{row.error}</span> : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}

            {leadGenProposal.status === "proposed" ? (
              <div className="leadgen-review-actions">
                <Button loading={leadGenApproveBusy} onClick={approveLeadGenSearch}>Approve &amp; find people</Button>
                <Button variant="outline" onClick={discardLeadGenProposal}>Discard</Button>
              </div>
            ) : (
              <div>
                {!monitorSuggestion ? (
                  <div>
                    <Button size="sm" variant="outline" loading={monitorProposeBusy} onClick={proposeMonitorForLeadGenSearch}>Save this search as a disabled recurring monitor</Button>
                    <p className="leadgen-run-disclosure">Saving spends nothing and does not run until you separately enable it.</p>
                  </div>
                ) : (
                  <div className="leadgen-monitor-suggestion">
                    <strong>Saved — disabled recurring monitor</strong>
                    <p>{monitorSuggestion.name}</p>
                    <small>
                      Query: {monitorSuggestion.query} · Providers: {monitorSuggestion.sources.join(", ")} · Schedule: {monitorSuggestion.scheduleDescription} ·
                      Cap: {monitorSuggestion.capPerRun}/run · Destination: {monitorSuggestion.destination.replace("_", " ")}
                    </small>
                    <p className="form-error">Saving spends nothing and does not run until separately enabled. Scheduled execution for this monitor type isn&apos;t built yet — this suggestion stays disabled; enabling it does not run anything.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : null}
      </DashboardCard>

      <details className="discovery-specialized-tools">
        <summary>Specialized search tools <small>Optional — most people will not need these</small></summary>
        <p>These are direct provider controls for research professionals. They are separate from the guided program search above and are hidden so they do not interrupt the normal workflow.</p>
      <details className="leadgen-advanced-search">
        <summary>Direct public-web search</summary>
        <div className="leadgen-advanced-search__body">
          <p className="people-preview-intro">
            Search the public web directly with your own query and source choice — the same Vertex/OpenAI
            pipeline Jarvis uses above, without the guided ICP planning step. <strong>Up to 5 new people per
            search.</strong> PDL enrichment, CRM import, monitors, and outreach still all require your own
            explicit action below, every time.
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
        </div>
      </details>

      <PublicWebDiscoveryPanel onResultsChanged={() => { loadGroundingResults("pending_review"); setGroundingResultsStatus("pending_review"); }} />
      </details>
      </section>

      <section className="discovery-workflow-section discovery-results-section" aria-labelledby="todays-results-heading"><header><span>Step 2</span><h2 id="todays-results-heading">Today&apos;s Results</h2><p>Every finding stays in its own lane so a prospective student is never confused with a vendor, competitor, or community.</p></header>
      <DashboardCard title="Review queue">
        <p className="people-preview-intro">
          Every person Jarvis or the advanced manual search finds lands here first. Nothing enters the CRM,
          a monitor, or outreach without your explicit action below.
        </p>
        <div className="discovery-review-filters">
          {["pending_review", "saved", "dismissed"].map((status) => (
            <Button key={status} size="sm" variant={groundingResultsStatus === status ? "primary" : "outline"} onClick={() => { setGroundingResultsStatus(status); setSelectedGroundingIds([]); setQualifySummary(null); loadGroundingResults(status); }}>
              {status.replace("_", " ")}
            </Button>
          ))}
          <Button size="sm" variant="outline" loading={groundingResultsLoading} onClick={() => loadGroundingResults()}>Refresh</Button>
        </div>

        {groundingResultsStatus === "pending_review" ? (
          <div className="review-queue-toolbar">
            <div className="review-queue-filter-row">
              <label><span>Run</span><select value={reviewFilters.run} onChange={(e) => setReviewFilters((c) => ({ ...c, run: e.target.value }))}>
                <option value="all">All runs</option>
                {runOptions.map((r) => <option key={r.key} value={r.key}>{r.key === "manual" ? "Manual search" : `${r.kind} · ${new Date(r.latest).toLocaleString()}`} ({r.count})</option>)}
              </select></label>
              <label className="review-queue-checkbox-filter"><input type="checkbox" checked={reviewFilters.newOnly} onChange={(e) => setReviewFilters((c) => ({ ...c, newOnly: e.target.checked }))} /><span>New only</span></label>
              <label><span>Provider</span><select value={reviewFilters.provider} onChange={(e) => setReviewFilters((c) => ({ ...c, provider: e.target.value }))}>
                <option value="all">All providers</option>
                {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></label>
              <label><span>Qualification</span><select value={reviewFilters.qualification} onChange={(e) => setReviewFilters((c) => ({ ...c, qualification: e.target.value }))}>
                <option value="all">Any status</option>
                <option value="qualified">Qualified</option>
                <option value="needs_review">Needs review</option>
                <option value="not_a_fit">Not a fit</option>
                <option value="unscored">Not yet qualified</option>
              </select></label>
              <label><span>Location contains</span><input type="text" value={reviewFilters.location} onChange={(e) => setReviewFilters((c) => ({ ...c, location: e.target.value }))} placeholder="e.g. Texas" /></label>
              <label><span>Freshness</span><select value={reviewFilters.freshness} onChange={(e) => setReviewFilters((c) => ({ ...c, freshness: e.target.value }))}>
                <option value="all">Any freshness</option>
                <option value="recent">Recent (0-90d)</option>
                <option value="aging">Aging (91-365d)</option>
                <option value="evergreen">Evergreen/undated</option>
                <option value="n/a">Not applicable (ICP match)</option>
              </select></label>
              <label><span>Identity confidence</span><select value={reviewFilters.identityConfidence} onChange={(e) => setReviewFilters((c) => ({ ...c, identityConfidence: e.target.value }))}>
                <option value="all">Any confidence</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="conflict">Conflict / needs review</option>
              </select></label>
            </div>

            <div className="review-queue-selection-row">
              <Button size="sm" variant="outline" onClick={selectAllNewFromRun}>Select all new from this run</Button>
              <Button size="sm" variant="outline" onClick={selectAllVisible}>Select all visible</Button>
              <Button size="sm" variant="outline" disabled={!selectedGroundingIds.length} onClick={clearGroundingSelection}>Clear selection</Button>
              <span className="review-queue-selected-count">{selectedGroundingIds.length} selected of {visibleGroundingResults.length} shown</span>
              <Button size="sm" disabled={!selectedGroundingIds.length} loading={qualifyBusy} onClick={qualifySelectedGroundingResults}>
                Have Jarvis qualify {selectedGroundingIds.length || ""} selected leads
              </Button>
            </div>
            {qualifyBusy ? <p className="review-queue-progress" role="status">Jarvis is qualifying {selectedGroundingIds.length} candidate(s) against your approved programs — this can take up to a minute. Please wait; the button is disabled to prevent duplicate submissions.</p> : null}
            {qualifySummary ? (
              <div className="review-queue-summary" role="status">
                <strong>Qualification complete</strong>
                <span>{qualifySummary.processed} processed · {qualifySummary.qualified} qualified · {qualifySummary.needsReview} needs review · {qualifySummary.notAFit} not a fit{qualifySummary.failed ? ` · ${qualifySummary.failed} failed` : ""}</span>
              </div>
            ) : null}
            <div className="review-queue-bulk-actions">
              {[["all", "All"], ["qualified", "View Qualified"], ["needs_review", "View Needs review"], ["not_a_fit", "View Not a fit"]].map(([value, label]) => (
                <Button key={value} size="sm" variant={qualifyOutcomeFilter === value ? "primary" : "outline"} onClick={() => setQualifyOutcomeFilter(value)}>{label}</Button>
              ))}
              <Button size="sm" variant="outline" disabled={!selectedGroundingIds.some((id) => visibleGroundingResults.find((r) => r._id === id)?.qualificationLabel === "qualified")} onClick={saveSelectedQualified}>Save selected qualified candidates</Button>
              <Button size="sm" variant="outline" disabled={!selectedGroundingIds.length} onClick={dismissSelected}>Dismiss selected</Button>
            </div>
          </div>
        ) : null}

        {visibleGroundingResults.length ? <div className="discovery-lanes">
          {DISCOVERY_LANES.map(([laneKey, laneLabel, laneDescription]) => groundingResultsByLane[laneKey].length ? <section className={`discovery-lane lane-${laneKey}`} key={laneKey}>
            <header className="discovery-lane__header"><div><span>{laneLabel}</span><small>{laneDescription}</small></div><strong>{groundingResultsByLane[laneKey].length}</strong></header>
            <div className="review-queue-grid">{groundingResultsByLane[laneKey].map((result) => {
            const expanded = expandedResultIds.includes(result._id);
            const sourceLabel = result.discoveryMode === "icp_match" ? `${(result.providers || []).includes("apollo_person_search") ? "Apollo" : "PDL"} structured ICP match`
              : result.discoveryMode === "public_web_high_volume" ? "Public-web evidence (high-volume discovery)"
                : "Public-web evidence";
            const corroborated = (result.providers || []).length >= 2;
            return (
              <article key={result._id} className={`review-card is-${result.status} qualification-${result.qualificationLabel || "unscored"}`}>
                <header className="review-card__header">
                  {result.status === "pending_review" ? (
                    <button type="button" className={`review-card__check${selectedGroundingIds.includes(result._id) ? " is-checked" : ""}`} onClick={() => toggleGroundingSelection(result._id)} aria-pressed={selectedGroundingIds.includes(result._id)} aria-label={`Select ${result.name}`} />
                  ) : null}
                  <div className="review-card__avatar" aria-hidden="true">
                    {resultImageOf(result) ? <img src={resultImageOf(result)} alt="" loading="lazy" /> : <span>{initialsOf(result.name)}</span>}
                  </div>
                  <div className="review-card__title">
                    <strong>{result.name}</strong>
                    {result.isNew ? <span className="leadgen-badge-new">New</span> : null}
                  </div>
                  {result.qualificationLabel ? <span className={`review-card__qual-badge qual-${result.qualificationLabel}`}>{result.qualificationLabel.replace("_", " ")}</span> : null}
                </header>

                <div className="review-card__source-line">
                  <span>{sourceLabel}{corroborated ? " · cross-provider corroboration" : ""}</span>
                  <span className={`review-card__identity-badge identity-${result.identityConfidence || "low"}`}>Identity: {(result.identityConfidence || "low").replace("_", " ")}</span>
                </div>

                <small>{[result.organizationName, result.organizationDomain].filter(Boolean).join(" · ") || "No organization listed"}</small>
                {result.linkedinUrl ? <small><a href={result.linkedinUrl} target="_blank" rel="noreferrer">Profile URL ↗</a></small> : null}
                {result.email ? <small>Contact: {result.email} ({result.emailVerificationStatus || result.emailState || "unverified"})</small> : <small className="review-card__missing">No contact information yet</small>}
                {result.type === "person" && result.discoveryMode !== "icp_match" ? (
                  <small>{result.evidenceDate ? `Evidence date: ${new Date(result.evidenceDate).toLocaleDateString()} (${result.evidenceAgeDays} day${result.evidenceAgeDays === 1 ? "" : "s"} old)` : "No verifiable evidence date"}{result.freshnessTier ? ` · ${result.freshnessTier}` : ""}</small>
                ) : result.discoveryMode === "icp_match" ? <small>Structured database match — not a dated public post, never described as recent intent.</small> : null}
                {result.conflicts?.length ? <small className="form-error">Conflicts: {result.conflicts.join(" ")}</small> : null}
                {result.exclusionFlags?.length ? <small className="form-error">ICP exclusion flags: {result.exclusionFlags.join(", ")}</small> : null}

                {result.recommendedProgram?.name ? <small className="grounding-fit-score">Program: {result.recommendedProgram.name} — fit {result.fitScore}/100</small> : result.fitScore != null ? <small className="grounding-fit-score">Program fit: {result.fitScore}/100 (no approved program judged a genuine fit)</small> : null}
                {result.buyerIntentLevel ? <small>Buyer intent: {result.buyerIntentLevel}{result.buyerIntentEvidence ? ` — ${result.buyerIntentEvidence}` : ""}</small> : null}

                <section className={`review-card__why ${result.discoveryMode === "icp_match" && !result.evidenceUrls?.length ? "is-incomplete" : ""}`}>
                  <strong>{result.discoveryMode === "icp_match" && !result.evidenceUrls?.length ? "Why this is only a possible match" : "Why Lead Porch found this"}</strong>
                  <p>{result.fitReasons?.length ? result.fitReasons.join(" · ") : result.summary || "The provider returned this person for your selected audience rules."}</p>
                  {result.discoveryMode === "icp_match" && !result.evidenceUrls?.length ? <small>This is a database profile match, not proof that the person currently wants coaching. Research their public activity before outreach.</small> : null}
                </section>

                <button type="button" className="review-card__details-toggle" onClick={() => toggleDetails(result._id)} aria-expanded={expanded}>
                  {expanded ? "Hide details" : "View details"}
                </button>
                {expanded ? (
                  <div className="review-card__details">
                    <small>Summary</small>
                    <p>{result.summary || "No additional summary was provided by the source."}</p>
                    {result.fitReasons?.length ? <><small>Program fit reasons</small><p>{result.fitReasons.join("; ")}</p></> : null}
                    {result.recommendedNextAction ? <><small>Recommended next action</small><p>{result.recommendedNextAction}</p></> : null}
                    {result.outreachRecommended && result.outreachDraft ? <><small>Draft outreach (not sent)</small><p>{result.outreachDraft}</p></> : null}
                    <small>Discovered {new Date(result.createdAt).toLocaleDateString()} · via {(result.providers || []).join(", ") || "vertex_grounding"}</small>
                    <small>Citations</small>
                    <div className="grounding-citations">
                      {(result.evidenceUrls || []).map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
                      {!result.evidenceUrls?.length && result.discoveryMode === "icp_match" ? <span className="people-preview-footnote">No public-web citation — this is a structured ICP match, not a public-web find.</span> : null}
                    </div>
                    {result.pdlEnrichment?.attempted ? (
                      <small>{result.pdlEnrichment.error ? `PDL error: ${result.pdlEnrichment.errorMessage || "unknown error"}` : result.pdlEnrichment.matched ? `PDL verified: ${result.pdlEnrichment.email || "match found, no email"}` : "PDL: no confident match"}</small>
                    ) : null}
                    {result.apolloEnrichment?.attempted ? (
                      <small>{result.apolloEnrichment.error ? `Apollo error: ${result.apolloEnrichment.errorMessage || "unknown error"}` : result.apolloEnrichment.matched ? `Apollo verified: ${result.apolloEnrichment.email || "match found, no email"}` : "Apollo: no confident match"}</small>
                    ) : null}
                  </div>
                ) : null}

                {result.status === "pending_review" ? (
                  <div className="leadgen-row-actions">
                    {(result.type === "person" && (!result.pdlEnrichment?.attempted || !result.apolloEnrichment?.attempted)) ? (
                      <div className="leadgen-row-actions__group">
                        <span>Enrich:</span>
                        {!result.pdlEnrichment?.attempted ? (
                          <Button size="sm" variant="outline" loading={pdlEnrichBusyId === result._id} disabled={Boolean(pdlEnrichBusyId) && pdlEnrichBusyId !== result._id} onClick={() => enrichGroundingResultWithPdl(result._id)}>PDL</Button>
                        ) : null}
                        {!result.apolloEnrichment?.attempted ? (
                          <Button size="sm" variant="outline" loading={apolloEnrichBusyId === result._id} disabled={Boolean(apolloEnrichBusyId) && apolloEnrichBusyId !== result._id} onClick={() => enrichGroundingResultWithApollo(result._id)}>Apollo</Button>
                        ) : null}
                      </div>
                    ) : null}
                    <Button size="sm" onClick={() => saveGroundingResult(result._id)}>Save</Button>
                    <Button size="sm" variant="outline" onClick={() => dismissGroundingResult(result._id)}>Dismiss</Button>
                  </div>
                ) : <span className="people-preview-footnote">{result.status === "saved" ? "Saved" : "Dismissed"}</span>}
              </article>
            );
            })}</div>
          </section> : null)}
        </div> : <div className="table-state table-state--empty">No {groundingResultsStatus.replace("_", " ")} results match the current filters.</div>}
      </DashboardCard>
      </section>
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
