const OpenAI = require("openai");

const clean = (value) => String(value || "").trim().replace(/\s+/g, " ");
const titleCase = (value) => clean(value).replace(/\b\w/g, (letter) => letter.toUpperCase());

function parseNumber(value) {
  const normalized = String(value || "").toLowerCase().replace(/,/g, "").trim();
  const multiplier = normalized.endsWith("k") ? 1000 : normalized.endsWith("m") ? 1000000 : 1;
  const number = Number.parseFloat(normalized.replace(/[km]$/, ""));
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function compileWithRules(question) {
  const prompt = clean(question);
  if (prompt.length < 8) throw new Error("Describe the businesses and market you want Lead Porch to research.");
  const normalized = prompt.replace(/[?.!]+$/, "");
  const subjectMatch = normalized.match(/^(?:find|show me|research|build (?:a )?list of|identify)\s+(.+?)(?=\s+(?:in|near|across|within|with|that|having)\s+|$)/i);
  const locationMatch = normalized.match(/\s+(?:in|near|across|within)\s+(.+?)(?=\s+(?:with|that|having|who|where)\s+|$)/i);
  const employeeRange = normalized.match(/(?:with|having)\s+(\d[\d,.]*[km]?)\s*(?:-|–|to)\s*(\d[\d,.]*[km]?)\s+employees?/i);
  const employeeMinimum = normalized.match(/(?:with|having)\s+(?:at least|over|more than)\s+(\d[\d,.]*[km]?)\s+employees?/i);
  const employeeMaximum = normalized.match(/(?:with|having)\s+(?:under|fewer than|no more than|up to)\s+(\d[\d,.]*[km]?)\s+employees?/i);
  const locationCount = normalized.match(/(?:with|having)\s+(\d+)\+?\s+locations?/i);
  const rating = normalized.match(/(?:rated|rating of)\s+(\d(?:\.\d)?)\+?/i);
  const subject = clean(subjectMatch?.[1] || normalized);
  const location = clean(locationMatch?.[1] || "");
  const signals = [];
  if (locationCount) signals.push(`${locationCount[1]}+ locations`);
  if (rating) signals.push(`${rating[1]}+ rating`);
  const employeeMin = employeeRange ? parseNumber(employeeRange[1]) : employeeMinimum ? parseNumber(employeeMinimum[1]) : null;
  const employeeMax = employeeRange ? parseNumber(employeeRange[2]) : employeeMaximum ? parseNumber(employeeMaximum[1]) : null;
  return {
    name: [titleCase(subject), location ? `in ${titleCase(location)}` : ""].filter(Boolean).join(" ").slice(0, 120),
    summary: `Research ${subject}${location ? ` in ${location}` : ""} and rank each organization using traceable business signals.`,
    criteria: {
      industries: [titleCase(subject)],
      keywords: [subject, ...signals],
      locations: location ? [titleCase(location)] : [],
      employeeRange: { min: employeeMin, max: employeeMax },
      minimumLocations: locationCount ? Number(locationCount[1]) : null,
      minimumRating: rating ? Number(rating[1]) : null,
    },
    rankingDimensions: ["ICP fit", "revenue potential", "intent signals", "technology readiness"],
    assumptions: location ? [] : ["No geography was specified; add a city, state, or country before running a broad search."],
    unresolved: ["A connected Apollo account is required to discover organizations not already in your CRM."],
    compiler: "rules",
  };
}

async function compileWithOpenAI(question) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || process.env.MARKET_RESEARCH_AI_ENABLED === "false") return null;
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: process.env.MARKET_RESEARCH_OPENAI_MODEL || process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: "Convert a natural-language B2B/local-business research request into strict JSON. Never invent companies, counts, contacts, or search results. Return: name, summary, criteria {industries:string[], keywords:string[], locations:string[], employeeRange:{min:number|null,max:number|null}, minimumLocations:number|null, minimumRating:number|null}, rankingDimensions:string[], assumptions:string[], unresolved:string[]. Keep explicit user constraints. Use null for unknown numeric constraints." },
      { role: "user", content: clean(question) },
    ],
  });
  const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
  if (!parsed.name || !parsed.criteria) throw new Error("The AI research plan was incomplete.");
  return { ...parsed, compiler: "openai" };
}

async function compileMarketQuestion(question) {
  const fallback = compileWithRules(question);
  try {
    const aiPlan = await compileWithOpenAI(question);
    return aiPlan || fallback;
  } catch (error) {
    return { ...fallback, compilerWarning: "Lead Porch used its built-in parser because the AI planner was unavailable." };
  }
}

module.exports = { compileMarketQuestion, compileWithRules, parseNumber };
