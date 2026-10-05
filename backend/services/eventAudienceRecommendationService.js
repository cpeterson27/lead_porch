const OpenAI = require("openai");
const { recordOpenAiUsage } = require("./aiUsageTracker");

const PROFILES = [
  {
    label: "Multifamily investors",
    terms: ["multifamily", "multi-family", "apartment", "underwriting", "rent roll", "t-12"],
    reason: "The event teaches multifamily acquisition or underwriting skills.",
  },
  {
    label: "Capital raisers",
    terms: ["raise capital", "capital raising", "investor relations", "syndication"],
    reason: "The event includes capital-raising or investor-relations outcomes.",
  },
  {
    label: "Passive investors",
    terms: ["passive income", "passive investor", "limited partner", "accredited investor"],
    reason: "The event discusses passive investing or alternative income.",
  },
  {
    label: "Real estate professionals",
    terms: ["real estate", "realtor", "broker", "property manager", "acquisition"],
    reason: "The subject matter is directly relevant to real-estate professionals.",
  },
  {
    label: "Entrepreneurs and business owners",
    terms: ["entrepreneur", "business owner", "founder", "scale", "business growth"],
    reason: "The event promises business ownership, growth, or scaling outcomes.",
  },
  {
    label: "Medical professionals",
    terms: ["medical professional", "physician", "doctor", "dentist", "healthcare"],
    reason: "The event explicitly identifies medical or healthcare professionals.",
  },
  {
    label: "W-2 professionals",
    terms: ["w-2", "w2", "career professional", "employee"],
    reason: "The event explicitly serves employed professionals.",
  },
];

function sourceText(input = {}) {
  const planning = input.planning || {};
  return [
    input.name,
    input.summary,
    input.description,
    planning.attendeeOutcomes,
    planning.idealAttendee,
    planning.businessGoal,
    ...(planning.highlights || []),
  ].filter(Boolean).join("\n").toLowerCase();
}

function ruleRecommendations(input = {}) {
  const text = sourceText(input);
  return PROFILES
    .map((profile) => {
      const evidence = profile.terms.filter((term) => text.includes(term));
      return evidence.length
        ? { label: profile.label, reason: profile.reason, evidence: evidence.slice(0, 3) }
        : null;
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function openAiRecommendations(input = {}, { workspaceId, userId } = {}) {
  if (!process.env.OPENAI_API_KEY?.trim() || process.env.JARVIS_OPENAI_ENABLED !== "true") {
    return [];
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
  const model = process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini";
  const started = Date.now();
  let response;
  try {
    response = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are an event marketing strategist. Return JSON with an audiences array of 3-8 objects. Each object must have label, reason, and evidence (an array of short phrases grounded only in the supplied event). Do not invent demographics, income, profession, or intent. Prefer precise market segments over vague groups.",
        },
        {
          role: "user",
          content: JSON.stringify({
            name: input.name || "",
            summary: input.summary || "",
            description: input.description || "",
            attendeeOutcomes: input.planning?.attendeeOutcomes || "",
            idealAttendee: input.planning?.idealAttendee || "",
            businessGoal: input.planning?.businessGoal || "",
            price: input.ticketPrice || 0,
            format: input.locationType || "online",
          }),
        },
      ],
    });
  } catch (error) {
    await recordOpenAiUsage({ workspaceId, userId, agent: "sales", feature: "event_audience_recommendation", model, error, latencyMs: Date.now() - started });
    return [];
  }
  await recordOpenAiUsage({ workspaceId, userId, agent: "sales", feature: "event_audience_recommendation", model, response, latencyMs: Date.now() - started });
  try {
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    return Array.isArray(parsed.audiences)
      ? parsed.audiences.filter((item) => item?.label && item?.reason).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

async function recommendAudiences(input = {}, context = {}) {
  const ai = await openAiRecommendations(input, context);
  if (ai.length) return { source: "openai", recommendations: ai };
  return { source: "rules", recommendations: ruleRecommendations(input) };
}

module.exports = { recommendAudiences, ruleRecommendations, sourceText };
