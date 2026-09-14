const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");

const AUDIENCE_TERMS = {
  "airbnb investors": ["airbnb", "short-term rental", "short term rental", "vacation rental", "furnished rental"],
  "real estate investors": ["real estate investor", "real estate investment", "property investor", "acquisitions"],
  "house flippers": ["house flip", "fix and flip", "flipping", "wholesaling", "distressed properties", "renovation"],
  "property management companies": ["property management", "property manager", "leasing"],
  "multifamily investors": ["multifamily", "multi-family", "apartments", "apartment investor"],
  "beginner multifamily investors": [
    "multifamily", "multi-family", "apartment investor", "beginner investor",
    "new investor", "real estate investor",
  ],
  "capital raisers": [
    "capital raising", "capital raiser", "raise capital", "investor relations",
    "syndication", "syndicator",
  ],
  "passive investors": [
    "passive investor", "limited partner", "accredited investor", "passive income",
    "real estate investor",
  ],
  "real estate professionals": [
    "real estate", "realtor", "broker", "property manager", "acquisitions",
    "asset management", "developer",
  ],
  "entrepreneurs": ["entrepreneur", "founder", "owner", "business owner"],
  "w-2 professionals": ["w-2", "w2", "professional", "employee", "executive"],
  "medical professionals": [
    "medical", "physician", "doctor", "dentist", "nurse", "healthcare",
  ],
  "anyone looking to build passive income through commercial real estate": [
    "passive income", "commercial real estate", "multifamily", "multi-family",
    "apartment investor", "real estate investor",
  ],
  "experienced real-estate operators": ["operator", "developer", "owner", "founder", "asset management", "acquisitions"],
  "affiliate and referral partners": ["affiliate", "referral", "broker", "realtor", "real estate agent", "lender"],
  "high-ticket program buyers": ["operator", "developer", "owner", "founder", "investor", "acquisitions", "multifamily"],
  "skool community candidates": ["community", "education", "coach", "coaching", "training"],
};

function searchableText(contact = {}) {
  return [
    contact.title,
    contact.industry,
    contact.seniority,
    contact.company,
    ...(contact.audienceProfiles || []),
    ...(contact.tags || []),
    ...(contact.keywords || []),
    ...(contact.lists || []),
    contact.notes,
  ].filter(Boolean).join(" ").toLowerCase();
}

function matchReasons(contact, audiences = []) {
  const haystack = searchableText(contact);
  const title = String(contact.title || "").toLowerCase();
  const reasons = [];
  for (const audience of audiences) {
    const label = String(audience).toLowerCase().trim();
    const catalogEntry = Object.entries(AUDIENCE_TERMS).find(([key]) => label === key || label.includes(key) || key.includes(label));
    const meaningfulLabel = label
      .replace(/\b(?:email|emails|outreach|outreaches|template|templates|audience|contacts?)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const titleWords = meaningfulLabel.split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
    const titleMatch = title && titleWords.length && titleWords.every((word) => title.includes(word) || title.includes(word.replace(/s$/, "")));
    const terms = catalogEntry?.[1] || [meaningfulLabel || label];
    const hits = terms.filter((term) => haystack.includes(term));
    if (titleMatch && !hits.includes(meaningfulLabel)) hits.unshift(meaningfulLabel);
    if (hits.length) reasons.push({ audience, terms: hits.slice(0, 4) });
  }
  return reasons;
}

function rankAutomaticAudienceTemplates(contact = {}, audienceTemplates = []) {
  const normalizedProfiles = (contact.audienceProfiles || [])
    .map((profile) => String(profile).toLowerCase().trim());
  return audienceTemplates
    .map((candidate, index) => {
      const label = String(candidate.label || "").toLowerCase().trim();
      const reasons = matchReasons(contact, [candidate.label]);
      return {
        ...candidate,
        routingScore: (normalizedProfiles.includes(label) ? 100 : 0) + (reasons[0]?.terms?.length || 0),
        routingIndex: index,
      };
    })
    .filter((candidate) => candidate.routingScore > 0)
    .sort((left, right) => right.routingScore - left.routingScore || left.routingIndex - right.routingIndex);
}

function selectAutomaticAudienceTemplate(contact = {}, audienceTemplates = []) {
  return rankAutomaticAudienceTemplates(contact, audienceTemplates)[0] || null;
}

function connectionPriority(contact, campaign) {
  let score = 0;
  const reasons = [];
  const audienceReasons = matchReasons(contact, campaign.audience || []);
  const audienceHits = [...new Set(audienceReasons.flatMap((reason) => reason.terms))];
  if (audienceHits.length) {
    const points = Math.min(45, 25 + (audienceHits.length - 1) * 7);
    score += points;
    reasons.push({ label: "Campaign fit", detail: `Matches ${audienceHits.slice(0, 3).join(", ")}`, points });
  }
  const authorityText = `${contact.title || ""} ${contact.seniority || ""}`.toLowerCase();
  const highAuthority = /\b(owner|founder|co-founder|chief|ceo|cfo|coo|cto|president|partner|principal|vp|vice president|head|director)\b/.test(authorityText);
  const midAuthority = /\b(manager|lead|senior|broker|investor|operator|developer)\b/.test(authorityText);
  if (highAuthority) { score += 20; reasons.push({ label: "Decision authority", detail: contact.title || contact.seniority || "Senior decision-maker", points: 20 }); }
  else if (midAuthority) { score += 12; reasons.push({ label: "Role relevance", detail: contact.title || contact.seniority || "Relevant role", points: 12 }); }
  if (contact.emailStatus === "verified" && contact.email) { score += 9; reasons.push({ label: "Reachable", detail: "Verified email available", points: 9 }); }
  else if (contact.email) { score += 4; reasons.push({ label: "Contact method", detail: "Email available but needs review", points: 4 }); }
  if (contact.linkedin) { score += 8; reasons.push({ label: "Warm channel", detail: "LinkedIn profile available", points: 8 }); }
  const contextFields = [contact.company, contact.title, contact.industry, contact.seniority].filter(Boolean).length;
  const contextPoints = Math.min(10, contextFields * 2.5);
  if (contextPoints) { score += contextPoints; reasons.push({ label: "Profile confidence", detail: `${contextFields} useful profile fields`, points: contextPoints }); }
  const connectedOn = contact.additionalFields?.["Connected On"] || contact.additionalFields?.connectedOn;
  if (connectedOn) { score += 5; reasons.push({ label: "Relationship context", detail: `Connected ${connectedOn}`, points: 5 }); }
  if (contact.replied || contact.lastContacted) { score += 5; reasons.push({ label: "Prior engagement", detail: contact.replied ? "Previously replied" : "Prior contact recorded", points: 5 }); }
  score = Math.min(100, Math.round(score));
  const priority = score >= 75 ? "high" : score >= 50 ? "medium" : "low";
  const recommendedChannel = contact.emailStatus === "verified" && contact.email && contact.linkedin ? "Email, then LinkedIn" : contact.linkedin ? "LinkedIn" : contact.emailStatus === "verified" && contact.email ? "Email" : "Research contact method";
  const nextAction = !audienceHits.length ? "Review campaign fit" : recommendedChannel === "LinkedIn" ? "Generate a LinkedIn reconnect draft" : recommendedChannel === "Email, then LinkedIn" ? "Start with a personal email and use LinkedIn for follow-up" : recommendedChannel === "Email" ? "Prepare a personal campaign email" : "Find or confirm a safe contact method";
  return { score, priority, reasons, recommendedChannel, nextAction };
}

async function getConnectionPriorities(campaignId) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error("Campaign not found");
  const contacts = await Contact.find({ status: { $nin: ["archived", "unsubscribed", "invalid", "rejected"] } }).lean();
  const ranked = contacts.map((contact) => ({ contact, ...connectionPriority(contact, campaign) })).sort((a, b) => b.score - a.score || String(a.contact.name).localeCompare(String(b.contact.name)));
  return { campaign, ranked, counts: { total: ranked.length, high: ranked.filter((item) => item.priority === "high").length, medium: ranked.filter((item) => item.priority === "medium").length, low: ranked.filter((item) => item.priority === "low").length } };
}

async function getCampaignMatches(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error("Campaign not found");

  const base = {
    status: { $nin: ["archived", "unsubscribed", "invalid", "rejected"] },
    researchStatus: "qualified",
    qualifyContact: true,
    emailStatus: "verified",
    email: { $exists: true, $nin: ["", null] },
  };
  const eligible = await Contact.find(base).select("name email company title industry tags keywords lists notes seniority audienceProfiles campaignIds campaignTemplateOverrides").lean();
  const audienceTemplateDefinitions = Object.entries(campaign.emailAudienceTemplates || {})
    .filter(([, template]) => template?.status === "approved" && template?.currentVersion && template?.audienceLabel)
    .map(([key, template]) => ({ key, label: template.audienceLabel }));
  const matches = eligible.map((contact) => {
    const reasons = matchReasons(contact, campaign.audience);
    const rankedTemplates = rankAutomaticAudienceTemplates(contact, audienceTemplateDefinitions);
    const overrideKey = String(contact.campaignTemplateOverrides?.[String(campaign._id)] || "auto");
    const override = audienceTemplateDefinitions.find((template) => template.key === overrideKey);
    const selected = overrideKey === "general" ? null : override || rankedTemplates[0] || null;
    const ambiguous = overrideKey === "auto" && rankedTemplates.length > 1 && rankedTemplates[0].routingScore === rankedTemplates[1].routingScore;
    return {
      contact,
      reasons,
      routing: {
        templateKey: overrideKey === "general" ? "general" : selected?.key || "general",
        templateLabel: overrideKey === "general" ? "Main template" : selected?.label || "Main template",
        mode: overrideKey !== "auto" ? "manual" : selected ? "automatic" : "fallback",
        ambiguous,
        alternatives: rankedTemplates.slice(1, 3).map((template) => template.label),
      },
    };
  }).filter((item) => item.reasons.length);

  const [needsResearch, readyForReview, unverified] = await Promise.all([
    Contact.countDocuments({ status: { $ne: "archived" }, researchStatus: "needs_research" }),
    Contact.countDocuments({ status: { $ne: "archived" }, researchStatus: "ready_for_review" }),
    Contact.countDocuments({ status: { $ne: "archived" }, qualifyContact: true, emailStatus: { $ne: "verified" } }),
  ]);

  return {
    campaign,
    matches,
    counts: {
      matched: matches.length,
      alreadyAssigned: matches.filter(({ contact }) => contact.campaignIds?.some((id) => String(id) === String(campaign._id))).length,
      eligible: eligible.length,
      needsResearch,
      readyForReview,
      qualifiedButUnverified: unverified,
      routedToMain: matches.filter((item) => item.routing.mode === "fallback").length,
      ambiguousRouting: matches.filter((item) => item.routing.ambiguous).length,
    },
  };
}

async function assignCampaignMatches(campaignId) {
  const preview = await getCampaignMatches(campaignId);
  const ids = preview.matches.map(({ contact }) => contact._id);
  if (ids.length) {
    await Contact.updateMany({ _id: { $in: ids } }, { $addToSet: { campaignIds: preview.campaign._id } });
  }
  preview.campaign.audienceMatch = {
    matchedCount: ids.length,
    lastMatchedAt: new Date(),
    routingApprovedAt: null,
    routingApprovedByUserId: null,
  };
  await preview.campaign.save();
  return {
    ...preview.counts,
    assigned: ids.length,
    contacts: preview.matches.map(({ contact, reasons, routing }) => ({
      _id: contact._id,
      name: contact.name,
      email: contact.email,
      company: contact.company,
      reasons,
      routing,
    })),
  };
}

module.exports = {
  AUDIENCE_TERMS,
  assignCampaignMatches,
  getCampaignMatches,
  matchReasons,
  selectAutomaticAudienceTemplate,
  rankAutomaticAudienceTemplates,
  searchableText,
  connectionPriority,
  getConnectionPriorities,
};
