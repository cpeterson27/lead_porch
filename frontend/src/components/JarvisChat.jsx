import { useState, useRef, useEffect } from "react";
import { FiMaximize2, FiMinimize2, FiChevronUp, FiChevronDown, FiVolume2, FiPlus } from "react-icons/fi";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useJarvis } from "../hooks/useJarvis";
import {
  buildJarvisCampaignPackage,
  confirmJarvisResearchImport,
  createContentBrief,
  fetchJarvisProfile,
  fetchPeopleResearchPreviews,
  jarvisGenerateImage,
  prepareJarvisResearchImport,
  synthesizeJarvisSpeech,
  updateJarvisProfile,
} from "../services/api.js";

// Recognizes a typed request to actually generate a picture (a flyer, a
// promo graphic) rather than just talk about one, so it can be routed to
// the real OpenAI image generator instead of the normal text chat.
const IMAGE_REQUEST_PATTERN = /\b(generate|create|design|make|draw)\b[^.!?\n]{0,60}\b(flyer|poster|banner|graphic|image|photo|picture|ad|advertisement)\b/i;
const isCampaignPackageRequest = (text) => /\b(create|make|build|design|prepare)\b/i.test(text) && /\b(social(?: media)?|campaign|content)\b/i.test(text) && /\b(flyer|graphic|image|program|platform|post)\b/i.test(text);

// Recognizes a request to actually draft reusable email/social copy, so
// the "Save as email template" / "Save as social draft" buttons only
// show up on the response to that kind of request — not on every plain
// chat answer.
const CONTENT_DRAFT_PATTERN = /\b(write|draft|compose|create)\b[^.!?\n]{0,60}\b(email|subject line|social( media)? post|caption|instagram|linkedin|twitter|tweet|facebook post|newsletter)\b/i;
import "./JarvisChat.css";

const OPENAI_VOICES = [
  { value: "marin", label: "Marin · natural and polished" },
  { value: "cedar", label: "Cedar · warm and confident" },
  { value: "coral", label: "Coral · bright and conversational" },
  { value: "nova", label: "Nova · clear and energetic" },
  { value: "sage", label: "Sage · calm and professional" },
  { value: "alloy", label: "Alloy · balanced and neutral" },
  { value: "ash", label: "Ash · direct and composed" },
  { value: "ballad", label: "Ballad · expressive and smooth" },
  { value: "echo", label: "Echo · steady and focused" },
  { value: "fable", label: "Fable · warm and expressive" },
  { value: "onyx", label: "Onyx · deep and authoritative" },
  { value: "shimmer", label: "Shimmer · friendly and upbeat" },
  { value: "verse", label: "Verse · versatile and natural" },
];
const OPENAI_VOICE_NAMES = new Set(OPENAI_VOICES.map((voice) => voice.value));

function sourceHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function JarvisResearchPreview({ message, approval, busy, onPrepare, onConfirm }) {
  const people = Array.isArray(message?.data?.people) ? message.data.people : [];
  const summary = message?.data?.preview || {};
  const previewId = String(message?.data?.previewId || "");
  const [selectedIndexes, setSelectedIndexes] = useState([]);
  const [dismissedIndexes, setDismissedIndexes] = useState([]);
  if (!people.length || !previewId) return null;
  const imported = approval?.status === "imported" || message.data.previewStatus === "imported";
  const selectionLocked = imported || Boolean(approval?.approvalId);
  const togglePerson = (index) => setSelectedIndexes((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index]);
  const selectNewPeople = () => setSelectedIndexes(people.map((person, index) => person.reviewStatus === "new" && !dismissedIndexes.includes(index) ? index : null).filter((index) => index !== null));
  const dismissPerson = (index) => {
    setDismissedIndexes((current) => current.includes(index) ? current : [...current, index]);
    setSelectedIndexes((current) => current.filter((item) => item !== index));
  };
  return <section className="jarvis-research-preview">
    <header className="jarvis-research-preview__header">
      <div><span>Research preview</span><strong>{summary.total || people.length} people found</strong><p>{summary.newContacts || 0} new · {summary.existingContacts || 0} CRM matches · {summary.publishedEmails || 0} published emails{dismissedIndexes.length ? ` · ${dismissedIndexes.length} removed by you` : ""}</p></div>
      <span className="jarvis-research-preview__state">{imported ? "Imported" : approval ? "Approval ready" : "Review first"}</span>
    </header>
    {!imported ? <div className="jarvis-research-selection"><strong>{selectedIndexes.length} selected for CRM import</strong><div><button type="button" disabled={selectionLocked} onClick={selectNewPeople}>Select all new</button><button type="button" disabled={selectionLocked} onClick={() => setSelectedIndexes([])}>Clear selection</button></div></div> : null}
    <div className="jarvis-research-people">
      {people.map((person, index) => dismissedIndexes.includes(index) ? null : <article className="jarvis-research-person" key={`${previewId}-${person.firstName}-${person.lastName}-${index}`}>
        <div className="jarvis-research-person__toprow">
          {!imported ? <label className="jarvis-research-person__select"><input type="checkbox" checked={selectedIndexes.includes(index)} disabled={selectionLocked} onChange={() => togglePerson(index)} /><span>{selectedIndexes.includes(index) ? "Selected" : "Select"}</span></label> : null}
          {!imported && !selectionLocked ? <button type="button" className="jarvis-research-person__dismiss" onClick={() => dismissPerson(index)}>Not a fit — remove</button> : null}
        </div>
        <div className="jarvis-research-person__identity">
          <strong>{[person.firstName, person.lastName].filter(Boolean).join(" ") || "Unnamed person"}</strong>
          <span>{person.title || "Role needs review"}</span>
          <p>{person.company}</p>
          {person.evidenceUrl ? (
            <a className="jarvis-research-person__source" href={person.evidenceUrl} target="_blank" rel="noreferrer">
              Source: {sourceHostname(person.evidenceUrl) || "public web"} ↗
            </a>
          ) : (
            <small className="jarvis-research-person__source jarvis-research-person__source--none">No public source found for this person</small>
          )}
        </div>
        <div className="jarvis-research-person__email"><small>Email</small><strong>{person.email || "Not publicly listed"}</strong><span>{String(person.emailStatus || "missing").replaceAll("_", " ")}</span></div>
        <details><summary>Evidence and duplicate review</summary><p>{person.evidenceSummary || "Public evidence is attached for review."}</p><div className="jarvis-research-person__review"><span>{String(person.reviewStatus || "new").replaceAll("_", " ")}</span>{person.matchReason ? <span>{person.matchReason}</span> : null}</div><a href={person.evidenceUrl} target="_blank" rel="noreferrer">Open public source</a></details>
      </article>)}
    </div>
    <div className="jarvis-research-approval">
      <p><strong>Nothing is sent.</strong> Importing only adds these people as needs-review prospects. Published emails remain unverified and blocked from campaigns.</p>
      {imported ? <div className="jarvis-import-success">Imported into the CRM for review. No outreach was sent.</div> : approval ? <div className="jarvis-confirm-import"><div><span>Final step required</span><strong>Click the green button below to add these contacts</strong><small>{approval.preview?.total || selectedIndexes.length} selected · approval expires {new Date(approval.expiresAt).toLocaleTimeString()}</small></div><button type="button" disabled={busy} onClick={() => onConfirm(previewId, approval)}>{busy ? "Adding contacts to CRM…" : `Add ${approval.preview?.total || selectedIndexes.length} selected contacts to CRM now`}</button></div> : <button type="button" className="jarvis-prepare-import" disabled={busy || !selectedIndexes.length} onClick={() => onPrepare(previewId, selectedIndexes)}>{busy ? "Preparing CRM import…" : selectedIndexes.length ? `Continue with ${selectedIndexes.length} selected` : "Select people to import"}</button>}
      {approval?.error ? <div className="jarvis-inline-error">{approval.error}</div> : null}
    </div>
  </section>;
}

function JarvisPublicMentionPreview({ message }) {
  const mentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];
  if (!message?.data?.fallbackResearch) return null;
  return <section className="jarvis-mention-preview">
    <header><span>No-credit fallback search</span><strong>{mentions.length} public evidence link{mentions.length === 1 ? "" : "s"}</strong><p>Matching usernames are clues only. Open a source and look for a direct statement connecting the account to a real name or business.</p></header>
    {mentions.length ? <div>{mentions.map((mention, index) => <article key={`${mention.url}-${index}`}><span>{String(mention.source || "public web").replaceAll("_", " ")}</span><strong>{mention.title}</strong><p>{mention.excerpt || "Open this public result to review its context."}</p><a href={mention.url} target="_blank" rel="noreferrer">Review public source ↗</a></article>)}</div> : <p className="jarvis-mention-preview__empty">No additional public account or business evidence was found. Jarvis will not manufacture an identity; use the original Reddit post/account if you decide to make contact.</p>}
  </section>;
}

function JarvisCampaignPackagePreview({ message, busy, onBuild, onOpen }) {
  const item = message?.data?.campaignPackage;
  if (!item) return null;
  const program = item.programDraft || {};
  return <section className="jarvis-package-preview">
    <header><div><span>Jarvis Campaign Studio</span><h3>{item.name}</h3><p>{item.objective}</p></div><strong>{item.status === "ready" ? "Ready for review" : "Proposal"}</strong></header>
    {item.image?.url ? <img src={item.image.url} alt={`${item.name} generated campaign graphic`} /> : <div className="jarvis-package-preview__flyer"><span>Flyer direction</span><p>{item.flyerPrompt}</p></div>}
    <div className="jarvis-package-preview__program"><span>{item.existingProgramId ? "Existing program" : "New program draft"}</span><h4>{program.name}</h4><p>{program.summary}</p><dl><div><dt>Audience</dt><dd>{program.audience || "Review before building"}</dd></div><div><dt>Length</dt><dd>{program.durationValue || "—"} {program.durationUnit || ""}</dd></div><div><dt>Price</dt><dd>{program.priceAmount ? `$${Number(program.priceAmount).toLocaleString()}` : "Not set"}</dd></div></dl></div>
    <div className="jarvis-package-preview__platforms">{(item.socialVariants || []).map((variant) => <article key={variant.provider}><span>{variant.provider}</span><p>{variant.body}</p><small>{(variant.hashtags || []).map((tag) => tag.startsWith("#") ? tag : `#${tag}`).join(" ")}</small></article>)}</div>
    <p className="jarvis-package-preview__safety"><strong>Draft boundary:</strong> Building creates a hidden program draft when needed, one permanent flyer, and correctly sized social drafts. Nothing is published or sent.</p>
    {item.status === "ready" ? <button type="button" onClick={onOpen}>Open in AI Content</button> : <button type="button" disabled={busy} onClick={onBuild}>{busy ? "Building campaign package…" : "Approve and build drafts"}</button>}
  </section>;
}

// Speech synthesis handles plain prose much better than rendered Markdown.
// Keep the visual response intact, but remove formatting and add natural pauses
// before handing a reply to the browser voice.
const prepareTextForSpeech = (text = "") =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*|__|[*_~]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/^\s*(.+?):\s*$/gm, "$1. ")
    .replace(/^\s*(.+?):\s*(.+)$/gm, "$1: $2. ")
    .replace(/\n+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * JarvisChat Component
 * Minimal Jarvis assistant chat interface
 */
export default function JarvisChat() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const intentResearchTask = searchParams.get("task") === "intent-identity";
  const containerRef = useRef(null);
  // No seeded first chat bubble: the orb header already introduces Jarvis
  // (see .jarvis-visual-greeting below), so repeating that text as the
  // first message in the transcript was pure duplication.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(() => String(searchParams.get("prompt") || ""));
  const [nextId, setNextId] = useState(2);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [testEmail, setTestEmail] = useState("");

  const { loading, error, sendMessage, recommendCampaign, prepareRecipients, sendTestEmail, getStatus } = useJarvis();
  const messagesEndRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [savingDraftId, setSavingDraftId] = useState(null);
  const [voiceName, setVoiceName] = useState("marin");
  const [voiceMode, setVoiceMode] = useState(() => localStorage.getItem("jarvisVoiceMode") || "automatic");
  const [browserVoices, setBrowserVoices] = useState([]);
  const [browserVoiceName, setBrowserVoiceName] = useState(() => localStorage.getItem("jarvisBrowserVoice") || "");
  const [speakingId, setSpeakingId] = useState(null);
  const [speechError, setSpeechError] = useState("");
  const audioRef = useRef(null);
  const audioUrlRef = useRef("");
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [buildingPackageId, setBuildingPackageId] = useState("");
  // Collapses the voice-settings block (source/OpenAI voice/browser
  // voice/test button) at the bottom of the conversation input — not the
  // big orb header — since that's the part that's genuinely just
  // settings and doesn't need to stay visible while reading what Jarvis
  // found. Defaults collapsed.
  const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState(() => localStorage.getItem("jarvisVoiceSettingsOpen") === "true");
  const toggleVoiceSettingsOpen = () => setIsVoiceSettingsOpen((value) => { localStorage.setItem("jarvisVoiceSettingsOpen", String(!value)); return !value; });
  const [researchApprovals, setResearchApprovals] = useState({});
  const [researchActionId, setResearchActionId] = useState("");
  const autoPromptStartedRef = useRef(false);
  const spokenResearchErrorRef = useRef("");
  const [researchStartedAt, setResearchStartedAt] = useState(null);
  const [researchElapsedSeconds, setResearchElapsedSeconds] = useState(0);
  const researchSourceUrl = String(searchParams.get("sourceUrl") || "");
  const researchLeadLabel = String(searchParams.get("leadLabel") || "Saved intent lead");
  const researchReturnTo = String(searchParams.get("returnTo") || "/discovery?tab=leads");

  useEffect(() => {
    getStatus().then(setStatus);
  }, [getStatus]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return undefined;
    const loadVoices = () => setBrowserVoices(window.speechSynthesis.getVoices().filter((voice) => /^en/i.test(voice.lang)));
    loadVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    fetchJarvisProfile().then((response) => {
      if (!response?.success) return;
      setProfile(response.data);
      setVoiceName(OPENAI_VOICE_NAMES.has(response.data.voiceName) ? response.data.voiceName : "marin");
      setAutoSpeak(response.data.autoSpeak !== false);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (intentResearchTask) return;
    fetchPeopleResearchPreviews(1).then((response) => {
      const preview = response?.previews?.[0];
      if (!preview?.people?.length) return;
      setMessages((current) => current.some((item) => item.previewHistoryId === String(preview._id)) ? current : [...current, {
        id: `research-${preview._id}`,
        previewHistoryId: String(preview._id),
        type: "assistant",
        text: preview.status === "imported" ? "Your latest research preview has already been imported into the CRM." : "Your latest staged research is ready below. Review every person and source, then approve the CRM import here when you are comfortable.",
        data: { previewId: preview._id, previewStatus: preview.status, preview: preview.summary, people: preview.people },
      }]);
    }).catch(() => {});
  }, [intentResearchTask]);

  const scrollToBottom = () => {
    const messagePanel = messagesEndRef.current?.parentElement;
    messagePanel?.scrollTo({ top: messagePanel.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const stopSpeaking = () => {
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = "";
    setSpeakingId(null);
  };

  const speakWithBrowser = (text, id) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return false;
    const utterance = new window.SpeechSynthesisUtterance(prepareTextForSpeech(text));
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => voice.name === browserVoiceName) || voices.find((voice) => /^en-US/i.test(voice.lang) && /Samantha|Alex|Google|Microsoft/i.test(voice.name)) || voices.find((voice) => /^en/i.test(voice.lang)) || null;
    utterance.rate = profile?.voiceRate || 1;
    utterance.onend = stopSpeaking;
    utterance.onerror = () => { stopSpeaking(); setSpeechError("Browser voice playback was interrupted."); };
    setSpeakingId(id);
    window.speechSynthesis.speak(utterance);
    setSpeechError("Using this device’s built-in Jarvis backup voice. OpenAI voice will return automatically when available.");
    return true;
  };

  const speakText = async (text, id) => {
    const spokenText = prepareTextForSpeech(text);
    if (!spokenText) return;
    setSpeechError("");
    stopSpeaking();
    setSpeakingId(id);
    if ((voiceMode === "browser" || (voiceMode === "automatic" && status?.openai?.voiceEnabled === false)) && speakWithBrowser(spokenText, id)) return;
    try {
      const blob = await synthesizeJarvisSpeech(spokenText, OPENAI_VOICE_NAMES.has(voiceName) ? voiceName : "marin");
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = profile?.voiceRate || 1;
      audio.onended = stopSpeaking;
      audio.onerror = () => { stopSpeaking(); setSpeechError("Jarvis voice could not be played."); };
      await audio.play();
    } catch {
      stopSpeaking();
      if (voiceMode !== "openai" && speakWithBrowser(spokenText, id)) return;
      setSpeechError("OpenAI voice is unavailable. Choose Automatic or Browser voice to keep Jarvis speaking without API credits.");
    }
  };

  const testVoice = () => {
    speakText(`Hi, I am ${profile?.name || "Jarvis"}. Voice playback is ready.`, "voice-test");
  };

  useEffect(() => () => stopSpeaking(), []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (isFullscreen) {
        if (document.fullscreenElement) await document.exitFullscreen();
        setIsFullscreen(false);
      } else {
        await containerRef.current?.requestFullscreen();
        setIsFullscreen(true);
      }
    } catch {
      // Keep a full-viewport fallback for browsers that block the native API.
      setIsFullscreen((current) => !current);
    }
  };

  const submitPrompt = async (prompt) => {
    if (!prompt.trim() || loading || generatingImage) return;

    // Add user message
    const userMessage = {
      id: nextId,
      type: "user",
      text: prompt,
    };
    setMessages((prev) => [...prev, userMessage]);
    setNextId(nextId + 1);
    setInput("");

    // "Generate me a flyer for..." is routed straight to the real image
    // generator (the same one the Campaigns page uses) instead of the
    // normal text chat — the request text itself becomes the image
    // prompt, so mentioning the specific program/offer in the message is
    // what makes the flyer about it.
    if (IMAGE_REQUEST_PATTERN.test(prompt) && !isCampaignPackageRequest(prompt)) {
      setGeneratingImage(true);
      try {
        const result = await jarvisGenerateImage(prompt);
        const imageMessage = {
          id: nextId + 1,
          type: "assistant",
          text: "Here's a draft. Nothing is posted anywhere — download it, ask for changes, or attach it to a campaign yourself.",
          imageUrl: result.data?.url,
        };
        setMessages((prev) => [...prev, imageMessage]);
        setNextId(nextId + 2);
      } catch (err) {
        const disabled = err.response?.data?.code === "IMAGE_GENERATION_DISABLED";
        const errorMessage = {
          id: nextId + 1,
          type: "error",
          text: disabled ? "Image generation isn't turned on for this workspace yet — ask your admin to enable OPENAI_IMAGE_GENERATION_ENABLED." : (err.response?.data?.error || "Jarvis couldn't generate that image."),
        };
        setMessages((prev) => [...prev, errorMessage]);
        setNextId(nextId + 2);
      } finally {
        setGeneratingImage(false);
      }
      return;
    }

    const response = await sendMessage(prompt);
    if (response) {
      const assistantMessage = {
        id: nextId + 1,
        type: "assistant",
        text: response.answer || "I couldn't generate a response.",
        data: response.data,
        actions: response.actionsAvailable,
        activity: response.activity || [],
        memorySources: response.memorySources || [],
        delegatedAgent: response.delegatedAgent || null,
        isContentDraft: CONTENT_DRAFT_PATTERN.test(prompt),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setNextId(nextId + 2);
      if (autoSpeak) speakText(assistantMessage.text, assistantMessage.id);
    } else if (error) {
      const errorMessage = {
        id: nextId + 1,
        type: "error",
        text: `Error: ${error}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
      setNextId(nextId + 2);
    }
  };
  const submitPromptRef = useRef(submitPrompt);
  useEffect(() => { submitPromptRef.current = submitPrompt; });
  const initialAutoPromptRef = useRef({
    prompt: String(searchParams.get("prompt") || "").trim(),
    autostart: searchParams.get("autostart") === "1",
  });

  useEffect(() => {
    const { prompt: initialPrompt, autostart } = initialAutoPromptRef.current;
    if (!autostart || !initialPrompt || autoPromptStartedRef.current) return;
    autoPromptStartedRef.current = true;
    setResearchStartedAt(Date.now());
    setInput("");
    submitPromptRef.current(initialPrompt);
  }, []);

  const intentResearchResult = messages.find((message) => message.data?.researchQuestion);
  const intentResearchState = intentResearchResult ? "complete" : error ? "failed" : researchElapsedSeconds >= 240 ? "delayed" : loading ? "searching" : researchStartedAt ? "waiting" : "starting";

  const speakWithBrowserRef = useRef(speakWithBrowser);
  useEffect(() => { speakWithBrowserRef.current = speakWithBrowser; });
  useEffect(() => {
    if (!researchStartedAt || ["complete", "failed", "delayed"].includes(intentResearchState)) return undefined;
    const updateElapsed = () => setResearchElapsedSeconds(Math.max(0, Math.floor((Date.now() - researchStartedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [researchStartedAt, intentResearchState]);

  useEffect(() => {
    if (!intentResearchTask || !error || !autoSpeak || spokenResearchErrorRef.current === error) return;
    spokenResearchErrorRef.current = error;
    speakWithBrowserRef.current(`Jarvis finished the search but could not establish a supported identity. No contact was added. You can use the original public post to reply or message the account manually.`, "research-error");
  }, [error, intentResearchTask, autoSpeak]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    const prompt = input;
    setInput("");
    submitPrompt(prompt);
  };

  const handleAction = async (action, message = null) => {
    try {
      if (action === "build_campaign_package") {
        const packageId = message?.data?.campaignPackage?._id;
        if (!packageId) return;
        setBuildingPackageId(String(packageId));
        const response = await buildJarvisCampaignPackage(packageId);
        const built = response.data;
        setMessages((current) => current.map((item) => item.id === message.id ? { ...item, text: `“${built.name}” is ready for review. I created the flyer, platform-specific sizes and copy, and ${built.generatedProgramId ? "a hidden program draft" : "linked your existing program"}. Nothing was published or sent.`, data: { ...item.data, campaignPackage: built }, actions: [] } : item));
        setBuildingPackageId("");
      } else if (action === "open_lead_discovery") {
        const question = message?.data?.researchQuestion || "";
        navigate(`/discovery${question ? `?question=${encodeURIComponent(question)}` : ""}`);
      } else if (action === "review_research_preview") {
        scrollToBottom();
      } else if (action === "view_development_requests") {
        navigate("/development-requests");
      } else if (action === "create_campaign") {
        // Create a campaign draft and add result to chat
        const result = await recommendCampaign({ templateType: "announcement" });

        if (result?.success) {
          setSelectedCampaignId(result.campaign.id);
          const actionResult = {
            id: nextId,
            type: "assistant",
            text: `✅ ${result.message}\n\nCampaign created: **${result.campaign.name}**\n\nYou can now prepare recipients or send a test email.`,
            actionResult: true,
          };
          setMessages((prev) => [...prev, actionResult]);
          setNextId(nextId + 1);
        }
      } else if (action === "prepare_recipients") {
        if (!selectedCampaignId) {
          alert("Please create a campaign first");
          return;
        }
        const result = await prepareRecipients(selectedCampaignId);

        if (result?.success) {
          const actionResult = {
            id: nextId,
            type: "assistant",
            text: `✅ Recipients prepared!\n\n**Total Recipients:** ${result.recipientCount}\n\n**By Source:**\n${Object.entries(
              result.bySource,
            )
              .map(([source, count]) => `• ${source}: ${count}`)
              .join("\n")}\n\nReady to send test email.`,
            actionResult: true,
          };
          setMessages((prev) => [...prev, actionResult]);
          setNextId(nextId + 1);
        }
      } else if (action === "send_test_email") {
        if (!selectedCampaignId) {
          alert("Please create a campaign first");
          return;
        }
        if (!testEmail.trim()) {
          alert("Enter a test email address before sending.");
          return;
        }
        const email = testEmail.trim();
        const result = await sendTestEmail(selectedCampaignId, email);

        if (result?.success) {
          const actionResult = {
            id: nextId,
            type: "assistant",
            text: `✅ Test email sent!\n\n**Recipient:** ${result.testEmail}\n**Message ID:** ${result.messageId}\n**Status:** ${result.status}`,
            actionResult: true,
          };
          setMessages((prev) => [...prev, actionResult]);
          setNextId(nextId + 1);
          setTestEmail("");
        }
      }
    } catch (err) {
      setBuildingPackageId("");
      const errorMessage = {
        id: nextId,
        type: "error",
        text: `Error executing action: ${err.response?.data?.error || err.message}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
      setNextId(nextId + 1);
    }
  };

  const getActionLabel = (action) => {
    const labels = {
      create_campaign: "📧 Create Campaign",
      prepare_recipients: "👥 Prepare Recipients",
      send_test_email: "✉️ Send Test Email",
      review_organization: "🏢 Review Organization",
      view_audience: "👥 View Audience",
      start_campaign: "📧 Start Campaign",
      view_organization: "🏢 View Organization",
      add_audience: "👥 Add to Audience",
      filter_by_source: "🔎 Filter by Source",
      export_contacts: "📤 Export Contacts",
      view_contacts: "👤 View Contacts",
      view_dashboard: "📊 View Dashboard",
      start_outreach: "📣 Start Outreach",
      view_audiences: "👥 View Audiences",
      create_audience: "➕ Create Audience",
      view_analytics: "📈 View Analytics",
      launch_campaign: "🚀 Launch Campaign",
      view_development_requests: "Review Development Request",
      open_lead_discovery: "Review Lead Search",
      review_research_preview: "Review Jarvis Research Preview",
      build_campaign_package: "Approve and build drafts",
    };
    return labels[action] || action;
  };

  const saveJarvisDraft = async (message, type) => {
    try {
      setSavingDraftId(message.id);
      const title = type === "email_template" ? "Jarvis email template" : "Jarvis social draft";
      await createContentBrief({ title, type, body: message.text, source: "jarvis" });
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, savedAs: type } : item));
    } catch (err) {
      setMessages((current) => [...current, { id: nextId, type: "error", text: err.response?.data?.error || "Unable to save this Jarvis draft." }]);
      setNextId((current) => current + 1);
    } finally {
      setSavingDraftId(null);
    }
  };

  const speakMessage = (message) => {
    speakText(message.text, message.id);
  };

  const startListening = () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition || listening || loading) return;
    stopSpeaking();
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => { recognitionRef.current = null; setListening(false); };
    recognition.onerror = () => { recognitionRef.current = null; setListening(false); };
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput("");
      submitPrompt(transcript);
    };
    recognition.start();
  };
  const startListeningRef = useRef(startListening);
  useEffect(() => { startListeningRef.current = startListening; });

  const handleVoiceCore = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (speakingId) {
      stopSpeaking();
      return;
    }
    startListening();
  };

  useEffect(() => {
    const onShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j" && !loading) {
        event.preventDefault();
        startListeningRef.current();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [loading]);

  const saveProfile = async (event) => {
    event.preventDefault();
    if (!profile) return;
    try {
      setSavingProfile(true);
      const response = await updateJarvisProfile({ ...profile, voiceName, autoSpeak });
      if (response?.success) {
        setProfile(response.data);
        setProfileOpen(false);
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const prepareResearchImport = async (previewId, selectedIndexes) => {
    try {
      setResearchActionId(previewId);
      const response = await prepareJarvisResearchImport(previewId, selectedIndexes);
      setResearchApprovals((current) => ({ ...current, [previewId]: response.data }));
    } catch (importError) {
      setResearchApprovals((current) => ({ ...current, [previewId]: { error: importError.response?.data?.error || "Unable to prepare this import." } }));
    } finally {
      setResearchActionId("");
    }
  };

  const confirmResearchImport = async (previewId, approval) => {
    try {
      setResearchActionId(previewId);
      const response = await confirmJarvisResearchImport(previewId, approval.approvalId, approval.confirmationPhrase);
      setResearchApprovals((current) => ({ ...current, [previewId]: { ...approval, status: "imported", result: response.data } }));
      setMessages((current) => [...current, {
        id: `imported-${previewId}-${Date.now()}`,
        type: "assistant",
        text: `Imported ${response.data.mongoCreated || 0} new prospect${response.data.mongoCreated === 1 ? "" : "s"} and updated ${response.data.mongoUpdated || 0} existing CRM record${response.data.mongoUpdated === 1 ? "" : "s"}. No outreach was sent.`,
      }]);
    } catch (importError) {
      setResearchApprovals((current) => ({ ...current, [previewId]: { ...approval, error: importError.response?.data?.error || "Unable to import this preview." } }));
    } finally {
      setResearchActionId("");
    }
  };

  const voiceInputSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const visualState = listening ? "listening" : speakingId ? "speaking" : loading ? "thinking" : "idle";
  const visualLabel = { idle: "Systems ready", listening: "Listening", thinking: "Analyzing workspace", speaking: "Responding" }[visualState];
  const friendlyJarvisError = /429|credits? remaining|billing/i.test(String(error || "")) ? "OpenAI credits are unavailable. Jarvis will keep using browser voice and the no-credit public-source search. Restart this identity search to run the fallback sources." : error;
  const startNewConversation = () => {
    stopSpeaking();
    recognitionRef.current?.stop();
    setMessages([]);
    setInput("");
    setSelectedCampaignId(null);
    setTestEmail("");
    setResearchApprovals({});
    setResearchActionId("");
    setNextId(2);
  };

  return (
    <div ref={containerRef} className={`jarvis-chat-container jarvis-chat-container--${profile?.theme || "executive"} ${intentResearchTask ? "jarvis-chat-container--intent-task" : ""} ${isFullscreen ? "jarvis-chat-container--fullscreen" : ""}`}>
      <div className={`jarvis-header jarvis-header--${visualState}`}>
        <div className="jarvis-circuit-field" aria-hidden="true">
          <svg viewBox="0 0 1200 360" preserveAspectRatio="none">
            <path d="M0 65h155l42 42h178l40-40h135" />
            <path d="M0 294h210l45-46h147l48 48h153" />
            <path d="M1200 54h-170l-45 47H820l-53-53H650" />
            <path d="M1200 300H990l-35-38H805l-55 55H610" />
            <path d="M120 0v35l55 55v96l-44 44v130" />
            <path d="M1080 0v70l-42 42v92l52 52v104" />
            <path d="M0 177h270l40-40h100" />
            <path d="M1200 182H940l-40-40H790" />
          </svg>
          <i className="jarvis-signal jarvis-signal--one" />
          <i className="jarvis-signal jarvis-signal--two" />
          <i className="jarvis-signal jarvis-signal--three" />
          <i className="jarvis-signal jarvis-signal--four" />
        </div>
        <div className="jarvis-visualizer">
          <button type="button" className="jarvis-core" onClick={handleVoiceCore} disabled={!voiceInputSupported || loading} aria-label={listening ? "Stop listening" : speakingId ? "Stop speaking" : "Talk to Jarvis"}>
            <span className="jarvis-core-ring jarvis-core-ring--outer" />
            <span className="jarvis-core-ring jarvis-core-ring--middle" />
            <span className="jarvis-core-ring jarvis-core-ring--inner" />
            <span className="jarvis-core-ring jarvis-core-ring--pulse" />
            <span className="jarvis-reticle jarvis-reticle--one" />
            <span className="jarvis-reticle jarvis-reticle--two" />
            <span className="jarvis-core-light" />
            <span className="jarvis-orbit jarvis-orbit--one"><i /></span>
            <span className="jarvis-orbit jarvis-orbit--two"><i /></span>
            <span className="jarvis-orbit jarvis-orbit--three"><i /></span>
            <span className="jarvis-core-name">{profile?.name || "Jarvis"}</span>
            <span className="jarvis-waveform" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</span>
          </button>
          <p className="jarvis-visual-state"><span />{visualLabel}</p>
          <p className="jarvis-visual-greeting">{profile?.greeting || "Your workspace assistant for lead research, campaign planning, and follow-through."}</p>
          {voiceInputSupported ? <button type="button" className="jarvis-primary-talk" onClick={handleVoiceCore} disabled={loading}>{listening ? "Stop listening" : speakingId ? "Stop speaking" : "Talk to Jarvis"}</button> : null}
          <p className="jarvis-voice-hint">{listening ? "Speak naturally. Jarvis will respond when you pause." : "Tap the core or press Command + J to begin."}</p>
        </div>
        <div className="jarvis-statuses" aria-label="Jarvis connection status">
          <button type="button" className="jarvis-new-conversation" onClick={startNewConversation}><FiPlus /><span>New conversation</span></button>
          <span className={status?.imageGeneration?.enabled ? "is-ready" : ""}>Images {status?.imageGeneration?.enabled ? "ready" : "not enabled"}</span>
          <span className={status?.discoveryProviders?.vertex?.available ? "is-ready" : ""}>Vertex {status?.discoveryProviders?.vertex?.available ? "ready" : "not enabled"}</span>
          <span className={status?.discoveryProviders?.openai_web_search?.available ? "is-ready" : ""}>OpenAI research {status?.discoveryProviders?.openai_web_search?.available ? "ready" : "not enabled"}</span>
          <button type="button" className="jarvis-persona-button" onClick={() => setProfileOpen((value) => !value)}>Personalize</button>
          <button type="button" className="jarvis-fullscreen-button" onClick={toggleFullscreen}>{isFullscreen ? <FiMinimize2 /> : <FiMaximize2 />}<span>{isFullscreen ? "Exit" : "Full screen"}</span></button>
        </div>
      </div>

      {profileOpen && profile ? <form className="jarvis-persona-panel" onSubmit={saveProfile}><header><strong>Personalize Jarvis</strong><button type="button" onClick={() => setProfileOpen(false)}>Close ×</button></header>
        <label>Name<input value={profile.name} maxLength="40" onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
        <label>Greeting<input value={profile.greeting} maxLength="240" onChange={(event) => setProfile({ ...profile, greeting: event.target.value })} /></label>
        <label>Visual style<select value={profile.theme} onChange={(event) => setProfile({ ...profile, theme: event.target.value })}><option value="executive">Executive</option><option value="midnight">Midnight</option><option value="copper">Copper</option></select></label>
        <label>Response style<select value={profile.responseStyle} onChange={(event) => setProfile({ ...profile, responseStyle: event.target.value })}><option value="concise">Concise</option><option value="collaborative">Collaborative</option><option value="detailed">Detailed</option></select></label>
        <label>Voice pace<input type="range" min="0.5" max="1.5" step="0.1" value={profile.voiceRate} onChange={(event) => setProfile({ ...profile, voiceRate: Number(event.target.value) })} /></label>
        <label>OpenAI voice<select value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>{OPENAI_VOICES.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}</select></label>
        <button type="submit" disabled={savingProfile}>{savingProfile ? "Saving…" : "Save Jarvis"}</button>
      </form> : null}

      {intentResearchTask ? <section className={`jarvis-intent-task is-${intentResearchState}`} aria-live="polite">
        <div><span>{intentResearchState === "complete" ? "Identity research complete" : intentResearchState === "failed" ? "Search finished—no supported identity" : intentResearchState === "delayed" ? "Search needs a restart" : "Identity research in progress"}</span><h2>{researchLeadLabel}</h2><p>{intentResearchState === "searching" || intentResearchState === "waiting" ? `Jarvis is checking the exact username, original post, public web results, business pages, and publicly indexed social profiles. ${researchElapsedSeconds < 15 ? "Starting source checks…" : `Running for ${Math.floor(researchElapsedSeconds / 60)}:${String(researchElapsedSeconds % 60).padStart(2, "0")}. Most searches finish within 1–3 minutes.`}` : intentResearchState === "complete" ? "The result and supporting sources are shown directly below. No unrelated organization counts are part of this search." : intentResearchState === "delayed" ? "This request did not return within four minutes. Restart it instead of waiting indefinitely." : "Jarvis finished without enough evidence to connect this account to a real person. No identity or email was invented."}</p></div>
        <div className="jarvis-research-progress" role="progressbar" aria-label="Identity research progress" aria-valuetext={intentResearchState === "complete" ? "Complete" : intentResearchState === "failed" ? "Finished without supported identity" : intentResearchState === "delayed" ? "Delayed, restart required" : "Searching and validating public evidence"}><span className={intentResearchState === "complete" ? "is-complete" : ["failed", "delayed"].includes(intentResearchState) ? "is-stopped" : "is-running"} /></div>
        <div className="jarvis-research-now"><strong>{intentResearchState === "complete" ? "Done—review findings below" : intentResearchState === "failed" ? "Done—no supported contact found" : intentResearchState === "delayed" ? "Stopped waiting" : researchElapsedSeconds < 25 ? "Searching public sources" : researchElapsedSeconds < 70 ? "Comparing account and business clues" : "Validating identity and contact evidence"}</strong><span>{["searching", "waiting"].includes(intentResearchState) ? "Results appear only after evidence is checked; temporary zeros are not final results." : intentResearchState === "delayed" ? "Use Restart search below." : "The final outcome is shown in the transcript below."}</span></div>
        <ol><li className="is-done">Original post attached</li><li className={["searching", "waiting"].includes(intentResearchState) ? "is-active" : "is-done"}>Public identity search</li><li className={["complete", "failed"].includes(intentResearchState) ? "is-done" : ""}>Review evidence and contact option</li></ol>
        <div className="jarvis-intent-task__actions"><button type="button" onClick={() => navigate(researchReturnTo.startsWith("/") ? researchReturnTo : "/discovery?tab=leads")}>Back to this lead</button>{researchSourceUrl ? <a href={researchSourceUrl} target="_blank" rel="noreferrer">Open original post or account ↗</a> : null}<a href={`https://www.google.com/search?q=${encodeURIComponent(`"${researchLeadLabel}" ${researchSourceUrl}`)}`} target="_blank" rel="noreferrer">Search this account on Google ↗</a></div>
        {intentResearchState === "delayed" ? <button type="button" className="jarvis-restart-search" onClick={() => window.location.reload()}>Restart identity search</button> : null}
        <p className="jarvis-intent-task__outcome"><strong>Possible result:</strong> Jarvis may find a supported name and published contact, or conclude that the Reddit account cannot be safely connected to a real person. In that case, the only responsible contact method is a manual public reply or platform message—never a guessed email.</p>
      </section> : null}

      {!intentResearchTask ? <div className="jarvis-conversation-toolbar"><div className="jarvis-conversation-identity"><button type="button" className={`jarvis-mini-core is-${visualState}`} onClick={handleVoiceCore} aria-label="Talk to Jarvis"><span>J</span></button><span><b>{profile?.name || "Jarvis"}</b><small>{visualLabel} · your AI workspace</small></span></div><div><button type="button" onClick={startNewConversation}><FiPlus /> New conversation</button><button type="button" onClick={() => setProfileOpen((value) => !value)}>Personalize</button></div></div> : null}

      <div className="jarvis-messages">
        {messages.filter((msg) => !intentResearchTask || msg.type === "user" || msg.type === "error" || msg.data?.researchQuestion).map((msg) => (
          <div
            key={msg.id}
            className={`jarvis-message jarvis-message--${msg.type}`}
          >
            <div className="jarvis-message-content">
              <div className="jarvis-message-text">{msg.text}</div>

              {msg.imageUrl ? (
                <div className="jarvis-generated-image">
                  <img src={msg.imageUrl} alt="AI-generated flyer draft" />
                  <a href={msg.imageUrl} target="_blank" rel="noreferrer" className="jarvis-generated-image__open">Open full size ↗</a>
                </div>
              ) : null}

              {msg.type === "assistant" ? <div className="jarvis-response-tools"><button type="button" className="jarvis-speak-button" onClick={() => speakMessage(msg)} disabled={speakingId === msg.id} aria-label={speakingId === msg.id ? "Speaking this reply" : "Read this reply aloud"} title={speakingId === msg.id ? "Speaking…" : "Read aloud"}><FiVolume2 /></button></div> : null}

              <JarvisResearchPreview message={msg} approval={researchApprovals[String(msg.data?.previewId || "")]} busy={researchActionId === String(msg.data?.previewId || "")} onPrepare={prepareResearchImport} onConfirm={confirmResearchImport} />
              <JarvisPublicMentionPreview message={msg} />
              <JarvisCampaignPackagePreview message={msg} busy={buildingPackageId === String(msg.data?.campaignPackage?._id || "")} onBuild={() => handleAction("build_campaign_package", msg)} onOpen={() => navigate("/content")} />

              {msg.activity?.length ? <div className="jarvis-activity"><p>Jarvis completed</p>{msg.activity.map((step, index) => <div key={`${msg.id}-${index}`}><span>{step.status === "warning" ? "!" : "✓"}</span>{step.label}</div>)}</div> : null}
              {msg.memorySources?.length ? <div className="jarvis-memory-sources"><strong>Vault notes consulted</strong>{msg.memorySources.map((source) => <span key={source}>{source}</span>)}</div> : null}
              {msg.delegatedAgent?.answer ? <div className="jarvis-delegated-agent"><strong>{msg.delegatedAgent.agent === "content" ? "Content Agent" : "Lead Agent"} says:</strong><p>{msg.delegatedAgent.answer}</p></div> : null}

              {!intentResearchTask && msg.actions && msg.actions.length > 0 && (
                <div className="jarvis-actions">
                  <p className="jarvis-actions-label">Available Actions:</p>
                  <div className="jarvis-actions-list">
                    {msg.actions.map((action) => (
                      <button
                        key={action}
                        className="jarvis-action-btn"
                        onClick={() => handleAction(action, msg)}
                        disabled={loading}
                      >
                        {getActionLabel(action)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!intentResearchTask && msg.type === "assistant" && msg.isContentDraft && !msg.savedAs && !msg.data?.people?.length ? (
                <div className="jarvis-draft-actions">
                  <button disabled={savingDraftId === msg.id} onClick={() => saveJarvisDraft(msg, "email_template")}>Save as email template</button>
                  <button disabled={savingDraftId === msg.id} onClick={() => saveJarvisDraft(msg, "social")}>Save as social draft</button>
                </div>
              ) : null}
              {msg.savedAs ? <p className="jarvis-saved-note">Saved to AI Content as a {msg.savedAs === "email_template" ? "reusable email template" : "social draft"}.</p> : null}

              {msg.data && typeof msg.data === "object" && (
                <div className="jarvis-data">
                  <details>
                    <summary>📊 View Details</summary>
                    <pre>{JSON.stringify(msg.data, null, 2)}</pre>
                  </details>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="jarvis-input-form">
        <div className="jarvis-input-group">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Jarvis to find decision-makers, review priorities, plan a campaign, or generate a flyer..."
            disabled={loading || generatingImage}
            className="jarvis-input"
          />
          <button
            type="submit"
            disabled={loading || generatingImage || !input.trim()}
            className="jarvis-send-btn"
          >
            {generatingImage ? "Generating image…" : loading ? "Working…" : "Ask Jarvis"}
          </button>
          {voiceInputSupported ? <button type="button" className="jarvis-mic-btn" onClick={startListening} disabled={loading || generatingImage || listening}>{listening ? "Listening…" : "Talk"}</button> : null}
        </div>

        <div className="jarvis-voice-controls-wrap">
          <button type="button" className="jarvis-voice-controls-toggle" onClick={toggleVoiceSettingsOpen} aria-expanded={isVoiceSettingsOpen}>
            <span>Voice settings</span>
            <span className="jarvis-voice-controls-toggle__arrow">{isVoiceSettingsOpen ? <FiChevronUp /> : <FiChevronDown />}</span>
          </button>
          {isVoiceSettingsOpen ? (
            <>
              <div className="jarvis-voice-controls"><label className="jarvis-voice-picker">Voice source<select value={voiceMode} onChange={(event) => { setVoiceMode(event.target.value); localStorage.setItem("jarvisVoiceMode", event.target.value); }}><option value="automatic">Automatic · OpenAI then browser backup</option><option value="browser">Browser voice · no API credits</option><option value="openai">OpenAI voice only</option></select></label>{voiceMode !== "browser" ? <label className="jarvis-voice-picker">Preferred OpenAI voice<select value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>{OPENAI_VOICES.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}</select></label> : null}{voiceMode !== "openai" ? <label className="jarvis-voice-picker">Browser backup voice<select value={browserVoiceName} onChange={(event) => { setBrowserVoiceName(event.target.value); localStorage.setItem("jarvisBrowserVoice", event.target.value); }}><option value="">Best available English voice</option>{browserVoices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>)}</select></label> : null}<button type="button" className="jarvis-voice-test" onClick={testVoice} disabled={Boolean(speakingId)}>{speakingId ? "Speaking…" : "Test selected voice"}</button><label className="jarvis-auto-speak"><input type="checkbox" checked={autoSpeak} onChange={(event) => setAutoSpeak(event.target.checked)} /> Speak findings automatically</label></div>
              <p className="jarvis-ai-voice-disclosure">Browser voices are free and stay on this device. Automatic mode returns to the selected OpenAI voice whenever API service is available.</p>
            </>
          ) : null}
        </div>

        {selectedCampaignId && (
          <div className="jarvis-test-email-group">
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="Test email address (optional)"
              className="jarvis-test-email-input"
            />
          </div>
        )}

        <p className="jarvis-input-note">Press ⌘J while Lead Porch is open to start a voice turn. Talk records one request and sends it to Jarvis. Jarvis never sends outreach or changes records without a confirmed action.</p>
        {speechError ? <div className={speechError.startsWith("Using this device") ? "jarvis-voice-notice" : "jarvis-error"}>{speechError}</div> : null}
        {error && <div className="jarvis-error">{intentResearchTask ? `${friendlyJarvisError} No identity was added unless supported evidence appears above.` : friendlyJarvisError}</div>}
      </form>
    </div>
  );
}
