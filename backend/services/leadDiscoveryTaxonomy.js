/**
 * Shared, deterministic taxonomy for the lead-discovery pipeline: rejection
 * reasons, excluded-persona detection, program matching, and the
 * multi-dimensional score breakdown. No OpenAI calls here — this must work
 * with zero AI budget. Used by researchMonitorService.js.
 */

const REJECTION_REASONS = ["seller_or_promoter", "vendor_lender_agent_recruiter", "wrong_industry", "too_experienced", "no_coaching_intent", "generic_discussion", "homework_or_hypothetical", "old_content", "wrong_location", "no_current_need", "not_a_person", "bot_or_automated", "other"];
const BUCKETS = ["live_lead", "watchlist", "community_opportunity", "rejected"];

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "your", "you", "on", "is", "are", "this", "that", "will", "learn", "how", "from", "into", "you'll", "you're", "their", "them", "they", "our", "we'll", "we're"]);
const stem = (word) => word.length > 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word;
function significantTerms(text) {
  return [...new Set(String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOPWORDS.has(word)).map(stem))];
}

/** Build a per-program keyword profile from real CoachingProgram records. Never hardcode program names. */
function buildProgramProfiles(programs = []) {
  return (programs || []).filter((program) => program.status === "active").map((program) => ({
    id: String(program._id),
    name: program.name,
    terms: significantTerms(`${program.name} ${program.internalSummary || program.publicPresentation?.summary || ""}`),
  }));
}

/** Best-effort match of free text against real program profiles. Not a hard gate by itself. */
function matchProgram(text, profiles = []) {
  const words = new Set(significantTerms(text));
  let best = null;
  for (const profile of profiles) {
    const overlap = profile.terms.filter((term) => words.has(term));
    if (overlap.length >= 2 && (!best || overlap.length > best.overlap.length)) best = { program: profile.name, overlap };
  }
  return best ? { matched: true, program: best.program, evidence: best.overlap.slice(0, 6) } : { matched: false, program: "", evidence: [] };
}

// Persona-level exclusions: this is about WHO is posting, distinct from the
// existing promotional-content check (WHAT they are posting).
const EXCLUSION_PERSONAS = [
  {
    reason: "vendor_lender_agent_recruiter",
    label: "Vendor, lender, agent, or recruiter",
    pattern: /\b(?:mortgage broker|loan officer|hard money lender|private lender|licensed realtor|real estate agent(?:s)? (?:here|specializing)|property manager for hire|insurance agent|recruiter (?:here|for)|we're hiring|now hiring|staffing agency|general contractor available|i(?:'m| am) a (?:realtor|agent|broker|lender|recruiter))\b/i,
  },
  {
    reason: "seller_or_promoter",
    label: "Seller or promoter",
    pattern: /\b(?:i coach|i mentor|i teach|we coach|we mentor|check out my|link in bio|dm me for|book a call with me|my (?:coaching|mentoring|consulting) (?:program|service|business)|i (?:run|offer|sell) (?:a|an|my) (?:course|program|service|coaching)|join my (?:program|community|group|mastermind)|sign up for my)\b/i,
  },
  {
    reason: "bot_or_automated",
    label: "Bot or automated account",
    pattern: /\b(?:as an ai language model|i(?:'m| am) a bot|this (?:is|was) an automated (?:post|message)|beep boop|automated posting service)\b/i,
  },
  {
    reason: "too_experienced",
    label: "Experienced operator selling services, not a lead",
    pattern: /\b(?:i(?:'ve| have) closed \d+\+? (?:units|deals|doors)|i own \d+\+? (?:units|doors)|my portfolio of \d+|i(?:'m| am) a (?:syndicator|sponsor) with|gp on \d+\+? deals|\d+\+? years (?:as a|in) (?:syndicator|sponsor|operator))\b/i,
  },
];

function detectExclusionPersona(text) {
  const value = String(text || "");
  for (const persona of EXCLUSION_PERSONAS) {
    if (persona.pattern.test(value)) return { excluded: true, reason: persona.reason, label: persona.label };
  }
  return { excluded: false, reason: "", label: "" };
}

// Deterministic experience-stage signal, used both for scoring and for the
// "too experienced" rejection path (an experienced operator with no learning
// language is a poor fit for Ellie's coaching programs, not a promoter).
function experienceStage(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:20\+? years|15\+? years|i(?:'ve| have) closed \d{2,}|my portfolio of \d{3,}|i(?:'m| am) a (?:syndicator|sponsor) with)\b/.test(value)) return "experienced";
  if (/\b(?:my first deal|closed my first|a few deals in|analyzing my second|3rd deal|third deal)\b/.test(value)) return "intermediate";
  if (/\b(?:new to|just starting|beginner|getting started|thinking about (?:my )?first|haven't (?:closed|done) (?:a|my first) deal|no deals yet)\b/.test(value)) return "beginner";
  if (/\b(?:considering|exploring|thinking about|curious about|might want to)\b/.test(value)) return "aspiring";
  return "";
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

/**
 * Multi-dimensional score breakdown. Every number here must trace back to a
 * concrete regex/field match — no unexplained scores.
 */
function scoreDimensions({ text, signal = {}, gate = {}, monitor = {} }) {
  const value = String(text || "").toLowerCase();
  const learningIntent = clamp((/\b(?:coach|coaching|mentor|mentoring|mentorship|course|training|bootcamp|program)\b/.test(value) ? 40 : 0) + (/\b(?:need (?:help|guidance)|looking for (?:a )?(?:coach|mentor|program)|is coaching worth it|comparing (?:mentoring|coaching) programs)\b/.test(value) ? 40 : 0) + (gate.currentNeed ? 20 : 0), 0, 100);
  const stage = experienceStage(value);
  const urgency = clamp((/\b(?:urgent|asap|as soon as possible|this month|right now|ready to|actively looking|need help now)\b/.test(value) ? 60 : 0) + (/\$\s?\d[\d,.]*\s*[km]?\s*(?:-|–|to)\s*\$?\s?\d[\d,.]*\s*[km]?/.test(value) ? 20 : 0) + (gate.currentNeed ? 20 : 0), 0, 100);
  const readiness = clamp((/\b(?:budget|price|cost|invest in myself|ready to invest|save(?:d|ing) up)\b/.test(value) ? 35 : 0) + (stage === "beginner" || stage === "intermediate" ? 35 : stage === "aspiring" ? 15 : 0) + (gate.firstPersonEvidence ? 30 : 0), 0, 100);
  const recency = signal.publishedAt ? clamp(100 - Math.floor((Date.now() - new Date(signal.publishedAt).valueOf()) / (7 * 86400000)) * 15, 0, 100) : 40;
  const evidenceQuality = clamp((signal.evidence?.length ? 30 : 0) + (gate.firstPersonEvidence ? 40 : 0) + (value.length > 250 ? 30 : value.length > 80 ? 15 : 0), 0, 100);
  const identityConfidence = signal.identityResolution?.status === "supported" ? 80 : signal.authorName ? 35 : 10;
  const contactability = clamp((signal.publishedEmails?.length ? 50 : 0) + (signal.authorUrl ? 30 : 0) + (signal.identityResolution?.status === "supported" ? 20 : 0), 0, 100);
  const exclusion = detectExclusionPersona(value);
  const exclusionRisk = exclusion.excluded ? 100 : stage === "experienced" ? 60 : 0;
  return { learningIntent, experienceStage: stage, urgency, readiness, recency, evidenceQuality, identityConfidence, contactability, exclusionRisk, exclusionPersona: exclusion };
}

module.exports = { BUCKETS, REJECTION_REASONS, EXCLUSION_PERSONAS, buildProgramProfiles, matchProgram, detectExclusionPersona, experienceStage, scoreDimensions, significantTerms };
