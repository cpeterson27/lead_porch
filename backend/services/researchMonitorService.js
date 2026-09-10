const crypto = require("node:crypto");
const os = require("node:os");
const OpenAI = require("openai");
const IntentSignal = require("../models/IntentSignal");
const ResearchMonitor = require("../models/ResearchMonitor");
const MonitorActivity = require("../models/MonitorActivity");
const InAppNotification = require("../models/InAppNotification");
const intentSourceService = require("./intentSourceService");
const { isBiggerPocketsForumTopicUrl, isCommunityPartnerMonitor, isInvestorProfileMonitor } = intentSourceService;
const { researchPublicWebsite } = require("./publicWebsiteResearchService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const CoachingProgram = require("../models/CoachingProgram");
const taxonomy = require("./leadDiscoveryTaxonomy");

const RUNNER_INTERVAL_MS = Math.max(15000, Number(process.env.RESEARCH_WORKER_POLL_MS) || 60000);
const LEASE_MS = Math.max(120000, Number(process.env.RESEARCH_WORKER_LEASE_MS) || 20 * 60000);
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let timer = null;
let polling = false;

function scoreSignal(signal, monitor, programProfiles = []) {
  const content = `${signal.title || ""} ${signal.excerpt || ""}`.toLowerCase();
  const categoryPhrases = (monitor.intentCategories || []).flatMap((category) => category.phrases || []);
  const positive = [...(monitor.keywords || []), ...categoryPhrases, ...(monitor.locations || [])].map((value) => String(value).toLowerCase()).filter(Boolean);
  const negative = (monitor.negativeKeywords || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const matched = positive.filter((keyword) => {
    if (content.includes(keyword)) return true;
    const concepts = [
      [/multifamily|real estate invest/, /\b(?:apartment|apartments|rental propert|investment propert|units?|landlord|portfolio|cap rate)\b/],
      [/raise capital|financ/, /\b(?:capital|funding|funds|loan|lender|hard money|financing)\b/],
      [/start|buy.*business|entrepreneur/, /\b(?:business owner|founder|entrepreneur|acquisition|buy a business|start a business)\b/],
      [/scale|business systems?/, /\b(?:scale|systems?|operations|process|growth|overwhelmed|stuck)\b/],
    ];
    if (concepts.some(([keywordPattern, contentPattern]) => keywordPattern.test(keyword) && contentPattern.test(content))) return true;
    const words = keyword.split(/\s+/).filter((word) => word.length > 3);
    return words.length > 1 && words.filter((word) => content.includes(word)).length >= Math.ceil(words.length / 2);
  });
  const excluded = negative.filter((keyword) => content.includes(keyword));
  const buyer = signalEligibility(signal, monitor, programProfiles);
  const dimensions = taxonomy.scoreDimensions({ text: content, signal, gate: buyer.gate || {}, monitor });
  if (isInvestorProfileMonitor(monitor)) {
    let prospectScore = buyer.eligible ? 35 : 0;
    const prospectReasons = buyer.reasons.slice();
    if (/\b(?:accredited investor|limited partner|lp investor|passive investor|multifamily investor|syndication investor)\b/i.test(content)) { prospectScore += 30; prospectReasons.push("Self-described investor evidence"); }
    if (/\b(?:vice president|vp|director|physician|doctor|orthodontist|dentist|software architect|tech founder|founder|managing partner|partner|practice owner|business owner|executive)\b/i.test(content)) { prospectScore += 25; prospectReasons.push("Matches a target professional role"); }
    if (/\b(?:owner|founder|partner|principal|president|chief executive|ceo)\b/i.test(content)) { prospectScore += 10; prospectReasons.push("Shows business or practice ownership"); }
    if (/\b(?:webinar|conference|meetup|reia|multifamily|syndication|crowdfunding|passive income)\b/i.test(content)) { prospectScore += 10; prospectReasons.push("Shows relevant investment or event activity"); }
    if (matched.length) { prospectScore += Math.min(10, matched.length * 2); prospectReasons.push(`Matched ${Math.min(matched.length, 5)} targeting rule${matched.length === 1 ? "" : "s"}`); }
    if (excluded.length) { prospectScore = 0; prospectReasons.push(`Excluded terms: ${excluded.join(", ")}`); }
    return { score: Math.min(100, prospectScore), reasons: prospectReasons, matched, dimensions, gate: buyer.gate, exclusionReason: buyer.exclusionReason || "" };
  }
  if (isCommunityPartnerMonitor(monitor)) {
    let partnerScore = buyer.eligible ? 20 : 0;
    const partnerReasons = buyer.reasons.slice();
    if (buyer.eligible && ["meetup_public", "configured_community", "community_directory"].includes(signal.source)) { partnerScore += 10; partnerReasons.push("Found on a direct public community page"); }
    if (buyer.eligible && matched.length) { partnerScore += Math.min(12, matched.length * 3); partnerReasons.push(`Matched ${Math.min(matched.length, 4)} targeting rule${matched.length === 1 ? "" : "s"}`); }
    if (/association|REIA|organizer|president|director|founder|host|admin|club|network|meetup/i.test(content)) { partnerScore += 12; partnerReasons.push("Shows community or leadership evidence"); }
    if (Number(signal.raw?.memberCount) >= 500) { partnerScore += 8; partnerReasons.push(`${Number(signal.raw.memberCount).toLocaleString()} public members`); }
    if (signal.raw?.recentActivity) { partnerScore += 8; partnerReasons.push("Shows recent or upcoming activity"); }
    if (signal.organizationName) { partnerScore += 4; partnerReasons.push("Community organization name identified"); }
    const restrictions = [...content.matchAll(/\b(?:no pitching|no promotions?|no selling|no products?\/?services?|no courses?|no solicitation)\b/gi)].map((match) => match[0].toLowerCase());
    if (restrictions.length) { partnerScore = Math.max(0, partnerScore - 25); partnerReasons.push(`Promotion restrictions affect partnership fit: ${[...new Set(restrictions)].join(", ")}`); }
    if (excluded.length) { partnerScore = Math.max(0, partnerScore - 60); partnerReasons.push(`Excluded terms: ${excluded.join(", ")}`); }
    return { score: Math.min(100, partnerScore), reasons: partnerReasons, matched, dimensions, gate: buyer.gate, exclusionReason: buyer.exclusionReason || "" };
  }
  if (!buyer.eligible) return { score: 0, reasons: buyer.reasons.slice(), matched, dimensions, gate: buyer.gate, exclusionReason: buyer.exclusionReason || "" };
  let score = buyer.eligible ? 55 : 0;
  const reasons = buyer.reasons.slice();
  if (buyer.eligible) score += Math.min(15, matched.length * 5);
  if (/\b(?:first (?:multifamily |apartment |\d+[- ]unit )?(?:deal|acquisition)|underwrit(?:e|ing)|deal analysis|cap rate|\bnoi\b|debt service|multifamily mentor|multifamily (?:course|class|bootcamp|training)|(?:mentor|mentoring|coaching) programs?|raising capital)\b/i.test(content)) { score += 20; reasons.push("Shows a specific current multifamily learning, coaching, or deal need"); }
  if (/\b(?:overwhelmed|stuck|confused|need guidance)\b/i.test(content)) { score += 10; reasons.push("Expresses being overwhelmed or needing guidance"); }
  if (/\$\s?\d[\d,.]*\s*[km]?\s*(?:-|–|to)\s*\$?\s?\d[\d,.]*\s*[km]?|\b(?:price|cost|budget)\b/i.test(content) && /\b(?:coach|coaching|mentor|mentoring|program|course|training)\b/i.test(content)) { score += 10; reasons.push("Shows concrete coaching-program price or budget awareness"); }
  if (/\b(?:urgent|as soon as possible|this month|right now|ready to|actively looking)\b/.test(content)) { score += 15; reasons.push("Shows current urgency"); }
  if (/\b(?:my business|my company|our company|my portfolio|i own|founder|business owner)\b/.test(content)) { score += 15; reasons.push("Indicates an existing business or portfolio"); }
  if (signal.organizationDomain && signal.identityResolution?.status === "supported") { score += 10; reasons.push("Organization connection has public support"); }
  if (signal.publishedAt && Date.now() - new Date(signal.publishedAt).valueOf() < 7 * 86400000) { score += 5; reasons.push("Posted recently"); }
  if (dimensions.exclusionRisk >= 60) { score = Math.max(0, score - 30); reasons.push(`Elevated exclusion risk: experience stage is "${dimensions.experienceStage || "experienced"}"`); }
  if (excluded.length) { score = Math.max(0, score - 60); reasons.push(`Excluded terms: ${excluded.join(", ")}`); }
  return { score: Math.min(100, score), reasons, matched, dimensions, gate: buyer.gate, exclusionReason: buyer.exclusionReason || "" };
}

/**
 * Decide which discovery-track bucket a signal belongs in, and (for
 * rejections) exactly why. This is the single source of truth other code
 * should use — never re-derive bucket logic elsewhere.
 */
function classifySignalBucket({ signal, monitor, eligibility, ranking }) {
  if (isCommunityPartnerMonitor(monitor)) {
    if (!eligibility.eligible || !ranking.matched.length) return { bucket: "rejected", rejectionReason: eligibility.exclusionReason || "generic_discussion" };
    return { bucket: "community_opportunity", rejectionReason: "" };
  }
  if (isInvestorProfileMonitor(monitor)) {
    if (!eligibility.eligible || ranking.score < 45) return { bucket: "rejected", rejectionReason: eligibility.exclusionReason || "no_current_need" };
    return { bucket: "live_lead", rejectionReason: "" };
  }
  if (!eligibility.eligible) return { bucket: "rejected", rejectionReason: eligibility.exclusionReason || "other" };
  if (ranking.dimensions?.exclusionRisk >= 100) return { bucket: "rejected", rejectionReason: eligibility.exclusionReason || ranking.dimensions.exclusionPersona?.reason || "other" };
  const gate = eligibility.gate || {};
  const passesFullGate = Boolean(gate.firstPersonEvidence && gate.currentNeed && gate.programMatch);
  if (passesFullGate && ranking.score >= 65) return { bucket: "live_lead", rejectionReason: "" };
  if (ranking.score < 45) return { bucket: "rejected", rejectionReason: "no_current_need" };
  return { bucket: "watchlist", rejectionReason: "" };
}

function communityPartnerAssessment(signal, monitor) {
  const text = `${signal.title || ""} ${signal.excerpt || ""} ${signal.organizationName || ""}`.toLowerCase();
  const negative = (monitor.negativeKeywords || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const excluded = negative.find((keyword) => text.includes(keyword));
  if (excluded) return { eligible: false, reason: `Excluded term: ${excluded}`, reasons: [`Excluded term: ${excluded}`], exclusionReason: "other" };
  const realEstate = /real estate|multifamily|apartment|landlord|rental propert|syndication|commercial propert|REIA|wealth building/i.test(text);
  const community = /community|association|meetup|group|club|network|forum|mastermind|podcast|newsletter|organizer|founder|president|director|host|admin|conference/i.test(text);
  if (!realEstate) return { eligible: false, reason: "No clear real-estate relevance.", reasons: ["Missing real-estate community evidence"], exclusionReason: "wrong_industry" };
  if (!community) return { eligible: false, reason: "No clear active community or leadership evidence.", reasons: ["Missing real-estate community evidence"], exclusionReason: "generic_discussion" };
  return { eligible: true, reason: "", reasons: ["Public evidence identifies a relevant real-estate community; a named leader still requires separate evidence"] };
}

function investorProfileAssessment(signal, monitor) {
  const basic = audienceEligibility(signal);
  if (!basic.eligible) return { ...basic, reasons: [basic.reason] };
  const text = `${signal.title || ""} ${signal.excerpt || ""} ${signal.organizationName || ""}`.toLowerCase();
  if (signal.source === "sec_form_d") return { eligible: false, reason: "SEC Form D identifies filing participants, not a qualified Ellie investor prospect.", reasons: ["Filing-only identity excluded"], exclusionReason: "wrong_industry" };
  const excluded = (monitor.negativeKeywords || []).map((value) => String(value).toLowerCase()).find((keyword) => keyword && text.includes(keyword));
  if (excluded) return { eligible: false, reason: `Excluded term: ${excluded}`, reasons: [`Excluded term: ${excluded}`], exclusionReason: "other" };
  const persona = taxonomy.detectExclusionPersona(text);
  if (persona.excluded) return { eligible: false, reason: `Excluded persona: ${persona.label}.`, reasons: [`Excluded persona: ${persona.label}`], exclusionReason: persona.reason };
  const professionalFit = /\b(?:vice president|vp|director|physician|doctor|orthodontist|dentist|software architect|tech founder|founder|managing partner|partner|practice owner|business owner|executive)\b/i.test(text);
  const investorFit = /\b(?:accredited investor|limited partner|lp investor|passive investor|multifamily investor|syndication investor)\b/i.test(text);
  const multifamilyFit = /\b(?:multifamily|multi-family|apartment|syndication|commercial real estate)\b/i.test(text);
  const genericInstitutional = /\b(?:venture capital|hedge fund|private equity|institutional fund|pooled investment fund|fund manager|securities offering)\b/i.test(text);
  if (genericInstitutional && !multifamilyFit) return { eligible: false, reason: "Generic institutional finance is outside the Ellie audience.", reasons: ["Missing multifamily audience fit"], exclusionReason: "wrong_industry" };
  if (!multifamilyFit || (!professionalFit && !investorFit)) return { eligible: false, reason: "Qualified investor prospects require multifamily relevance plus supported professional or investor evidence.", reasons: ["Missing multifamily and investor fit"], exclusionReason: "no_current_need" };
  const reasons = [];
  if (professionalFit) reasons.push("Public evidence matches a target professional role");
  if (investorFit) reasons.push("Public evidence includes self-described investor language");
  return { eligible: true, reason: "", reasons };
}

function signalEligibility(signal, monitor, programProfiles = []) {
  if (isInvestorProfileMonitor(monitor || {})) return investorProfileAssessment(signal, monitor || {});
  return isCommunityPartnerMonitor(monitor || {}) ? communityPartnerAssessment(signal, monitor || {}) : buyerIntentAssessment(signal, programProfiles);
}

function rulesClassify(signal) {
  const text = `${signal.title || ""} ${signal.excerpt || ""}`.toLowerCase();
  const patterns = [
    ["hypothetical_or_student", /assignment|homework|student|case study|hypothetical|for a class/],
    ["promotion", /my course|our service|book a call|limited offer|use my code|subscribe|we help|free (?:guide|kit|webinar|download)|looking for feedback|i(?:'m| am) (?:building|launching|offering)|join (?:us|my)|sign up/],
    ["job_seeker", /looking for (a )?job|seeking employment|resume|hiring|open to work/],
    ["buyer_intent", /i need|looking for|recommend|how (do|can) i|ready to|want to|planning to|help me/],
  ];
  const match = patterns.find(([, pattern]) => pattern.test(text));
  return { classification: match?.[0] || "uncertain", method: "rules", reason: match ? "Matched a transparent rules-based intent pattern." : "No decisive buyer or exclusion pattern was present." };
}

function audienceEligibility(signal) {
  const text = `${signal.title || ""} ${signal.excerpt || ""}`.toLowerCase();
  const minorPatterns = [
    /\b(?:i(?:'m| am)|aged?)\s*(?:1[0-7]|[0-9])\b/,
    /\b(?:1[0-7]|[0-9])\s*(?:years? old|yo)\b/,
    /\bminor\b|\bmiddle school\b|\bhigh school(?:er)?\b|\bfreshman in high school\b/,
  ];
  if (minorPatterns.some((pattern) => pattern.test(text))) return { eligible: false, reason: "Minor or school-age person—not an eligible ticket buyer.", exclusionReason: "not_a_person" };
  if (/\b(?:no money|broke|can't afford|cannot afford|zero budget|no budget)\b/.test(text)) return { eligible: false, reason: "The post explicitly indicates no current purchasing ability.", exclusionReason: "no_current_need" };
  if (/\b(?:homework|assignment|school project|for (?:my|a) class|student survey|hypothetical)\b/.test(text)) return { eligible: false, reason: "Student or hypothetical research—not buyer intent.", exclusionReason: "homework_or_hypothetical" };
  return { eligible: true, reason: "" };
}

function buyerIntentAssessment(signal, programProfiles = []) {
  const basic = audienceEligibility(signal);
  if (!basic.eligible) return { ...basic, reasons: [basic.reason], gate: { firstPersonEvidence: false, currentNeed: false, programMatch: "" } };
  const text = `${signal.title || ""} ${signal.excerpt || ""}`.toLowerCase();
  const persona = taxonomy.detectExclusionPersona(text);
  if (persona.excluded) return { eligible: false, reason: `Excluded persona: ${persona.label}.`, reasons: [`Excluded persona: ${persona.label}`], exclusionReason: persona.reason, gate: { firstPersonEvidence: false, currentNeed: false, programMatch: "" } };
  if (isBiggerPocketsForumTopicUrl(signal.sourceUrl) && signal.publishedAt && Date.now() - new Date(signal.publishedAt).valueOf() > 120 * 86400000) return { eligible: false, reason: "Historical BiggerPockets discussion retained as evidence, not a current outreach lead.", reasons: ["Public forum post is older than the 120-day buyer-intent window"], exclusionReason: "old_content", gate: { firstPersonEvidence: false, currentNeed: false, programMatch: "" } };
  const communityMetadataSources = new Set(["linkedin_public", "facebook_public", "meetup_public", "community_directories", "configured_community"]);
  if (signal.source === "sec_form_d") return { eligible: false, reason: "SEC Form D is filing evidence, not student buying intent.", reasons: ["Institutional filing excluded from student intent"], exclusionReason: "wrong_industry" };
  if (communityMetadataSources.has(signal.source)) return { eligible: false, reason: "Public community metadata belongs in Community Partner discovery, not individual student intent.", reasons: ["Community metadata is not an individual conversation"], exclusionReason: "generic_discussion" };
  if (/https?:\/\/(?:www\.)?(?:linkedin\.com\/groups|facebook\.com\/(?:groups|pages)|meetup\.com\/[^/]+\/?$)/i.test(String(signal.sourceUrl || ""))) return { eligible: false, reason: "An indexed community page is metadata, not an individual public discussion.", reasons: ["Indexed community metadata is not buyer intent"], exclusionReason: "generic_discussion" };
  const institutional = /\b(?:venture capital|hedge fund|private equity|institutional fund|pooled investment fund|fund manager|securities offering|form d|limited partnership fund)\b/i;
  if (institutional.test(text)) return { eligible: false, reason: "Institutional finance or securities evidence is not Ellie student intent.", reasons: ["Institutional finance evidence excluded"], exclusionReason: "wrong_industry" };
  const multifamily = /\b(?:multifamily|multi-family|apartment(?:s| building| acquisition)?|commercial real estate|syndicat(?:ion|e)|cap rate|net operating income|noi|debt service|underwrit(?:e|ing)|first (?:deal|property)|\d+[- ]unit|raising capital for (?:a|my) deal)\b/i;
  if (!multifamily.test(text)) return { eligible: false, reason: "No specific multifamily or apartment-investing relevance.", reasons: ["Missing multifamily relevance"], exclusionReason: "wrong_industry" };
  const promotion = /\b(?:free (?:business )?(?:guide|kit|webinar|download|resource)|looking for feedback|feedback on (?:my|our)|i(?:'m| am) (?:building|launching|offering|creating)|my (?:course|program|service|newsletter)|we help|book a call|subscribe|sign up|join (?:us|my)|use my code|limited offer)\b/;
  if (promotion.test(text)) return { eligible: false, reason: "Promotional or creator-feedback content—not a buyer request.", reasons: ["Appears to be promoting or testing an offer"], exclusionReason: "seller_or_promoter" };
  const informational = /\b(?:the best thing you could ever have|tips for (?:entrepreneurs|business owners)|entrepreneurs (?:should|must|need to)|here(?:'s| is) how|ultimate guide|top \d+|why every)\b/;
  if (informational.test(text)) return { eligible: false, reason: "General advice or content—not a first-person buying need.", reasons: ["General informational content"], exclusionReason: "generic_discussion" };
  const intentPatterns = [
    [/\b(?:i need|we need|need help|help me)\b/, "Explicitly asks for help", "strong"],
    [/\b(?:i(?:'m| am)|we(?:'re| are)) (?:actively )?looking for (?:a |an )?(?:coach|mentor|consultant|program|community|system|solution|event|training|advice|help)\b/, "Actively looking for help or a solution", "strong"],
    [/\b(?:how (?:do|can|should) i|what should i do)\b/, "Asks how to solve a current problem", "strong"],
    [/\b(?:i want to|we want to|i(?:'m| am) ready to|we(?:'re| are) ready to|i plan to|planning to) (?:start|buy|scale|grow|leave|quit|invest|build|systemize)\b/, "States a current business or investment goal", "strong"],
    [/\b(?:i(?:'m| am|'ve)|we(?:'re| are|'ve)) (?:thinking about|considering|trying to|looking to|exploring)\b|\bthinking about (?:my|our|the) next move\b/, "Actively considering a next business or investment move", "weak"],
    [/\b(?:struggling (?:to|with)|stuck (?:in|with)|overwhelmed (?:by|with))\b/, "Describes a current business challenge", "strong"],
    [/\b(?:can anyone recommend|recommendations? for|seeking (?:a |an )?(?:coach|mentor|consultant|program|community|system|solution))\b/, "Requests a recommendation", "strong"],
    [/\b(?:my first|our first|i(?:'m| am) (?:underwriting|analyzing)|we(?:'re| are) (?:underwriting|analyzing)|need help (?:with|calculating)|stuck (?:on|with)|looking for (?:a )?(?:multifamily )?(?:mentor|course|class|bootcamp|training))\b/, "Describes a current multifamily learning or deal-analysis need", "strong"],
  ];
  const matches = intentPatterns.filter(([pattern]) => pattern.test(text));
  const reasons = matches.map(([, reason]) => reason);
  if (!reasons.length) return { eligible: false, reason: "No clear first-person current need or buying request.", reasons: ["Keyword match without buyer behavior"], exclusionReason: "no_current_need", gate: { firstPersonEvidence: false, currentNeed: false, programMatch: "" } };
  const strongMatch = matches.some(([, , strength]) => strength === "strong");
  const programMatch = taxonomy.matchProgram(text, programProfiles);
  return { eligible: true, reason: "", reasons, gate: { firstPersonEvidence: true, currentNeed: strongMatch, programMatch: programMatch.matched ? programMatch.program : "Ellie multifamily coaching (general)" } };
}

function deduplicateSignals(signals = []) {
  const rows = new Map();
  for (const signal of signals) {
    const authorUrl = String(signal.authorUrl || "").trim().toLowerCase().replace(/\/$/, "");
    const supportedName = signal.identityResolution?.status === "supported" ? String(signal.authorName || "").trim().toLowerCase() : "";
    const domain = String(signal.organizationDomain || "").trim().toLowerCase();
    const key = authorUrl ? `author:${authorUrl}` : supportedName && domain ? `person:${supportedName}|${domain}` : `source:${signal.source}|${signal.sourceId}`;
    const existing = rows.get(key);
    if (!existing) { rows.set(key, { ...signal, evidence: [...(signal.evidence || [])], duplicateSignalIds: [signal._id] }); continue; }
    existing.evidence = [...new Map([...(existing.evidence || []), ...(signal.evidence || [])].map((item) => [item.url, item])).values()];
    existing.duplicateSignalIds.push(signal._id);
    if ((signal.score || 0) > (existing.score || 0)) {
      for (const field of ["title", "excerpt", "score", "scoreReasons", "source", "sourceId", "sourceUrl", "publishedAt", "monitorId", "classification", "classificationReason"]) existing[field] = signal[field];
    }
  }
  return [...rows.values()];
}

async function classifySignal(signal) {
  const fallback = rulesClassify(signal);
  if (process.env.JARVIS_OPENAI_ENABLED !== "true" || !process.env.OPENAI_API_KEY?.trim()) return fallback;
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
    const response = await client.chat.completions.create({
      model: process.env.INTENT_CLASSIFICATION_OPENAI_MODEL || process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: "Classify public content into exactly one category: buyer_intent, hypothetical_or_student, promotion, job_seeker, irrelevant, uncertain. Buyer intent requires first-person or clearly attributable evidence of a real current need. Return JSON with classification and a short reason. Do not infer identity or company affiliation." },
        { role: "user", content: JSON.stringify({ title: signal.title || "", excerpt: signal.excerpt || "", source: signal.source }) },
      ],
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    const allowed = new Set(["buyer_intent", "hypothetical_or_student", "promotion", "job_seeker", "irrelevant", "uncertain"]);
    if (!allowed.has(parsed.classification)) return fallback;
    return { classification: parsed.classification, method: "openai", reason: String(parsed.reason || "AI classification completed.").slice(0, 500) };
  } catch (_error) { return fallback; }
}

function identityResolution(signal) {
  const evidenceUrls = (signal.evidence || []).map((item) => item.url).filter(Boolean);
  const hasAuthorEvidence = Boolean(signal.authorName && (signal.authorUrl || evidenceUrls.length));
  const hasOrganizationEvidence = Boolean(signal.organizationDomain && evidenceUrls.some((url) => {
    try { return new URL(url).hostname.replace(/^www\./, "") === signal.organizationDomain; } catch (_error) { return false; }
  }));
  if (hasAuthorEvidence && (!signal.organizationDomain || hasOrganizationEvidence)) return { status: "supported", reason: hasOrganizationEvidence ? "The public source supports both the author and organization domain." : "The public source supports the displayed author only; no company affiliation was inferred.", evidenceUrls };
  return { status: "unresolved", reason: "A username, person, or company is displayed only where public evidence directly supports it. Affiliation remains unresolved.", evidenceUrls };
}

function buildCommunityProfile(signal, monitor) {
  const text = `${signal.title || ""} ${signal.excerpt || ""}`;
  const restrictions = [...text.matchAll(/\b(?:no pitching|no promotions?|no selling|no products?\/?services?|no courses?|no solicitation)\b/gi)].map((match) => match[0].toLowerCase());
  const organizerCandidates = signal.raw?.organizerCandidates || [];
  const platformLabels = { meetup_public: "Meetup", facebook_public: "Facebook", linkedin_public: "LinkedIn", community_directories: "Community directory", configured_community: "Configured community source" };
  return {
    platform: platformLabels[signal.source] || signal.source,
    audienceFit: signal.organizationName ? `Serves ${signal.organizationName}` : "Real-estate investing audience (public evidence)",
    location: (monitor.locations || []).join(", "),
    activityEvidence: signal.raw?.recentActivity ? "Shows recent or upcoming activity" : signal.raw?.memberCount ? `${Number(signal.raw.memberCount).toLocaleString()} public members` : "",
    organizerEvidence: organizerCandidates.length ? organizerCandidates.join(", ") : (signal.authorName || ""),
    promotionRules: restrictions.length ? [...new Set(restrictions)].join(", ") : "No explicit promotion restrictions found in public evidence",
    recommendedApproach: restrictions.length ? "Request a partnership conversation with the organizer before posting; direct promotion may violate stated group rules." : "Reach out to the organizer directly to propose a partnership or guest contribution.",
  };
}

function mapAiRejection(classification) {
  return { hypothetical_or_student: "homework_or_hypothetical", promotion: "seller_or_promoter", job_seeker: "other", irrelevant: "generic_discussion" }[classification] || "other";
}

async function activity(monitor, runId, type, message, count = 0, details = {}) {
  return MonitorActivity.create({ workspaceId: monitor.workspaceId, monitorId: monitor._id, runId, type, message, count, details });
}
async function notify(monitor, type, title, message, signalId = null) {
  return InAppNotification.create({ workspaceId: monitor.workspaceId, userId: monitor.userId, monitorId: monitor._id, signalId, type, title, message });
}

async function acquireMonitor(monitorId) {
  const now = new Date();
  return ResearchMonitor.findOneAndUpdate({ _id: monitorId, enabled: true, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { leaseOwner: WORKER_ID, leaseExpiresAt: new Date(Date.now() + LEASE_MS), lastRunStatus: "running", lastRunAt: now }, $unset: { runRequestedAt: 1 } }, { new: true });
}

async function runResearchMonitor(monitorId) {
  const monitor = await acquireMonitor(monitorId);
  if (!monitor) return null;
  const runId = crypto.randomUUID();
  await activity(monitor, runId, "run_started", "Monitoring run started.");
  try {
    const collected = await intentSourceService.collectMonitorSignals(monitor.toObject());
    const candidates = collected.groups.reduce((sum, group) => sum + group.signals.length, 0);
    const uniqueSignals = [...new Map(collected.groups.flatMap((group) => group.signals).map((signal) => [String(signal.sourceUrl || `${signal.source}:${signal.sourceId}`).trim().toLowerCase().replace(/\/$/, ""), signal])).values()];
    await activity(monitor, runId, "sources_checked", `Checked ${collected.groups.length + collected.failures.length} sources.`, collected.groups.length + collected.failures.length);
    await activity(monitor, runId, "candidates_collected", `Collected ${candidates} public candidates.`, candidates);
    const activePrograms = await CoachingProgram.find({ workspaceId: monitor.workspaceId, status: "active" }).select("name internalSummary publicPresentation.summary status").lean();
    const programProfiles = taxonomy.buildProgramProfiles(activePrograms);
    let found = 0; let rejected = 0; let watchlisted = 0; let communityOpportunities = 0;
    const websiteCandidates = [];
    for (const signal of uniqueSignals) {
        const eligibility = signalEligibility(signal, monitor, programProfiles);
        const ranking = scoreSignal(signal, monitor, programProfiles);
        let { bucket, rejectionReason } = classifySignalBucket({ signal, monitor, eligibility, ranking });
        let classification = { classification: "uncertain", method: "rules", reason: "Deterministic gate applied; no AI call was needed." };
        // Only spend an OpenAI call on candidates that already cleared the deterministic gate for an
        // individual buyer-intent conversation — never on community/investor rows or already-rejected ones.
        if (bucket !== "rejected" && !isInvestorProfileMonitor(monitor) && !isCommunityPartnerMonitor(monitor)) {
          classification = await classifySignal(signal);
          if (["hypothetical_or_student", "promotion", "job_seeker", "irrelevant"].includes(classification.classification)) {
            bucket = "rejected";
            rejectionReason = mapAiRejection(classification.classification);
          }
        }
        const communityProfile = bucket === "community_opportunity" ? buildCommunityProfile(signal, monitor) : undefined;
        const saved = await IntentSignal.findOneAndUpdate(
          { workspaceId: monitor.workspaceId, source: signal.source, sourceId: signal.sourceId },
          { $setOnInsert: { workspaceId: monitor.workspaceId, monitorId: monitor._id, ...signal }, $set: { matchedKeywords: ranking.matched, score: ranking.score, scoreReasons: ranking.reasons, discoveredAt: new Date(), classification: classification.classification, classificationMethod: classification.method, classificationReason: classification.reason, audienceEligible: bucket !== "rejected", audienceRejectionReason: bucket === "rejected" ? (eligibility.reason || classification.reason || "") : "", identityResolution: identityResolution(signal), bucket, rejectionReason, scoreBreakdown: { firstPersonEvidence: Boolean(eligibility.gate?.firstPersonEvidence), currentNeed: Boolean(eligibility.gate?.currentNeed), programMatch: eligibility.gate?.programMatch || "", learningIntent: ranking.dimensions?.learningIntent || 0, experienceStage: ranking.dimensions?.experienceStage || "", urgency: ranking.dimensions?.urgency || 0, readiness: ranking.dimensions?.readiness || 0, recency: ranking.dimensions?.recency || 0, evidenceQuality: ranking.dimensions?.evidenceQuality || 0, identityConfidence: ranking.dimensions?.identityConfidence || 0, contactability: ranking.dimensions?.contactability || 0, exclusionRisk: ranking.dimensions?.exclusionRisk || 0 }, ...(communityProfile ? { communityProfile } : {}) } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        if (bucket === "rejected") { rejected += 1; continue; }
        if (bucket === "watchlist") { watchlisted += 1; continue; }
        if (bucket === "community_opportunity") { communityOpportunities += 1; continue; }
        found += 1;
        if (["google_web", "bing_web", "duckduckgo"].includes(signal.source) && signal.organizationDomain && ranking.score >= 55 && !isBiggerPocketsForumTopicUrl(signal.sourceUrl)) websiteCandidates.push({ signalId: saved._id, domain: signal.organizationDomain });
        if (ranking.score >= 75) await notify(monitor, "high_scoring_lead", "High-scoring lead found", `${saved.title || "A public signal"} scored ${ranking.score}.`, saved._id);
    }
    await activity(monitor, runId, "weak_matches_rejected", `Rejected ${rejected} weak or non-buyer matches; ${watchlisted} placed on the Watchlist; ${communityOpportunities} community opportunities identified.`, rejected);
    let websitesResearched = 0;
    for (const candidate of websiteCandidates.slice(0, 10)) {
      try {
        await IntentSignal.updateOne({ _id: candidate.signalId }, { $set: { websiteResearchStatus: "pending" } });
        const research = await researchPublicWebsite(`https://${candidate.domain}`);
        const publishedEmails = research.emails || [];
        await IntentSignal.updateOne({ _id: candidate.signalId }, { $set: { publishedEmails, people: research.people || [], websiteResearchStatus: research.status || "completed" }, $addToSet: { evidence: { $each: research.evidence || [] } } });
        websitesResearched += 1;
        if (publishedEmails.length) await notify(monitor, "published_email", "Published email found", `A public website listed ${publishedEmails.length} email address${publishedEmails.length === 1 ? "" : "es"}. They remain unverified.`, candidate.signalId);
      } catch (_error) { await IntentSignal.updateOne({ _id: candidate.signalId }, { $set: { websiteResearchStatus: "failed" } }); }
    }
    await activity(monitor, runId, "websites_researched", `Researched ${websitesResearched} public websites.`, websitesResearched);
    const resultLabel = isInvestorProfileMonitor(monitor) ? "qualified investor prospects" : isCommunityPartnerMonitor(monitor) ? "community partner leads" : "live leads";
    await activity(monitor, runId, "leads_prepared", `${found} ${resultLabel} passed the filters${watchlisted ? `; ${watchlisted} added to the Watchlist` : ""}${communityOpportunities ? `; ${communityOpportunities} community opportunities` : ""}.`, found);
    for (const failure of collected.failures) {
      await activity(monitor, runId, "source_failure", `${failure.source} failed: ${failure.message}`, 1, failure);
    }
    if (collected.failures.length) await notify(monitor, "source_failure", "Some sources are retrying automatically", `${collected.failures.length} optional source${collected.failures.length === 1 ? " was" : "s were"} unavailable. Monitoring still completed using the other sources.`);
    const nextRunAt = new Date(Date.now() + monitor.intervalMinutes * 60000);
    const priorHealth = new Map((monitor.sourceHealth || []).map((item) => [item.source, item.toObject ? item.toObject() : item]));
    for (const group of collected.groups) priorHealth.set(group.source, { source: group.source, enabled: true, lastSuccessfulCheck: new Date(), lastErrorAt: priorHealth.get(group.source)?.lastErrorAt || null, lastError: "", resultsCollected: group.signals.length, state: group.signals.length ? "healthy" : "empty", nextScheduledAttempt: nextRunAt });
    for (const failure of collected.failures) priorHealth.set(failure.source, { source: failure.source, enabled: true, lastSuccessfulCheck: priorHealth.get(failure.source)?.lastSuccessfulCheck || null, lastErrorAt: new Date(), lastError: failure.message, resultsCollected: priorHealth.get(failure.source)?.resultsCollected || 0, state: failure.state, nextScheduledAttempt: failure.retryAt && new Date(failure.retryAt) > nextRunAt ? new Date(failure.retryAt) : nextRunAt });
    monitor.lastRunStatus = collected.failures.length ? "partial" : "completed";
    monitor.lastRunMessage = `${found} ${resultLabel} passed the filters; ${watchlisted} watchlisted; ${communityOpportunities} community opportunities; ${rejected} rejected${collected.failures.length ? `; ${collected.failures.length} optional source retry(s)` : ""}.`;
    const activeSignalFilter = { workspaceId: monitor.workspaceId, monitorId: monitor._id, audienceEligible: { $ne: false }, status: { $ne: "dismissed" } };
    const [activeSignalCount, activeQualifiedCount] = await Promise.all([
      IntentSignal.countDocuments(activeSignalFilter),
      IntentSignal.countDocuments({ ...activeSignalFilter, score: { $gte: 60 } }),
    ]);
    monitor.totals.runs += 1; monitor.totals.signalsFound = activeSignalCount; monitor.totals.signalsQualified = activeQualifiedCount;
    monitor.lastRunFunnel = { engineVersion: "acquisition-v2", candidatesFetched: candidates, uniqueEvidenceEvaluated: uniqueSignals.length, weakMatchesRejected: rejected, qualifiedOpportunities: found, sourceContributions: collected.groups.map((group) => ({ source: group.source, candidates: group.signals.length })), measuredAt: new Date() };
    // A "blocked" source (401/403 — an auth/permission failure, e.g. a
    // provider API that has closed to new customers or a revoked key) will
    // never self-resolve by retrying. Auto-disable it for this monitor so it
    // stops silently wasting cycles on every future run, and surface exactly
    // why so the owner can act (reconfigure credentials or accept it's gone).
    const newlyBlocked = (monitor.sources || []).filter((source) => priorHealth.get(source)?.state === "blocked");
    if (newlyBlocked.length) {
      monitor.sources = (monitor.sources || []).filter((source) => !newlyBlocked.includes(source));
      for (const source of newlyBlocked) {
        const health = priorHealth.get(source);
        await notify(monitor, "source_disabled", `${source} disabled`, `${source} returned an authorization/permission error and was automatically removed from this monitor's sources: ${health.lastError}`);
      }
    }
    monitor.nextRunAt = nextRunAt; monitor.sourceHealth = [...priorHealth.values()]; monitor.leaseOwner = ""; monitor.leaseExpiresAt = null;
    await monitor.save();
    await activity(monitor, runId, "run_completed", monitor.lastRunMessage, found);
    await notify(monitor, "monitor_complete", "Monitor completed", monitor.lastRunMessage);
    return monitor;
  } catch (error) {
    monitor.lastRunStatus = "failed"; monitor.lastRunMessage = error.message || "Monitoring failed."; monitor.nextRunAt = new Date(Date.now() + Math.max(15, monitor.intervalMinutes) * 60000); monitor.leaseOwner = ""; monitor.leaseExpiresAt = null;
    await monitor.save();
    await activity(monitor, runId, "run_completed", `Run failed: ${monitor.lastRunMessage}`);
    return monitor;
  }
}

async function requestResearchMonitorRun(monitorId) {
  return ResearchMonitor.findByIdAndUpdate(monitorId, { $set: { runRequestedAt: new Date(), nextRunAt: new Date() } }, { new: true });
}

async function runDueResearchMonitors() {
  if (polling) return;
  polling = true;
  try {
    const now = new Date();
    await ResearchMonitor.updateMany({ lastRunStatus: "running", leaseExpiresAt: { $lte: now } }, { $set: { lastRunStatus: "failed", lastRunMessage: "A previous worker stopped unexpectedly; the run was safely released for retry.", nextRunAt: now, leaseOwner: "", leaseExpiresAt: null } });
    const due = await ResearchMonitor.find({ enabled: true, $and: [{ $or: [{ runRequestedAt: { $lte: now } }, { nextRunAt: { $lte: now } }] }, { $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }] }).sort({ runRequestedAt: 1, nextRunAt: 1 }).limit(10).select("_id workspaceId");
    for (const monitor of due) {
      await runWithWorkspace(monitor.workspaceId, () => runResearchMonitor(monitor._id));
    }
  } finally { polling = false; }
}

function startResearchMonitorRunner() {
  if (timer) return timer;
  timer = setInterval(() => runDueResearchMonitors().catch((error) => console.error("Research worker failed:", error.message)), RUNNER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => runDueResearchMonitors().catch(() => {}), 1000).unref?.();
  return timer;
}

module.exports = { audienceEligibility, buildCommunityProfile, buyerIntentAssessment, classifySignal, classifySignalBucket, communityPartnerAssessment, deduplicateSignals, investorProfileAssessment, mapAiRejection, requestResearchMonitorRun, runResearchMonitor, runDueResearchMonitors, signalEligibility, startResearchMonitorRunner, scoreSignal };
