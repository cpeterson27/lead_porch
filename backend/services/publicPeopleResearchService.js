const crypto = require("crypto");
const OpenAI = require("openai");

const PeopleResearchPreview = require("../models/PeopleResearchPreview");
const { previewContactIngestion } = require("./contactIngestionService");
const { recordOpenAiUsage } = require("./aiUsageTracker");

function normalizePublicPeople(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error("Provide between 1 and 100 researched people.");
  return rows.map((row, index) => {
    const firstName = String(row.firstName || "").trim().slice(0, 100);
    const lastName = String(row.lastName || "").trim().slice(0, 100);
    const company = String(row.company || "").trim().slice(0, 200);
    const evidenceUrl = String(row.evidenceUrl || "").trim().slice(0, 1000);
    let evidence;
    try { evidence = new URL(evidenceUrl); } catch { throw new Error(`Person ${index + 1} needs a valid evidence URL.`); }
    if (evidence.protocol !== "https:") throw new Error(`Person ${index + 1} evidence must use HTTPS.`);
    if (/(^|\.)linkedin\.com$/i.test(evidence.hostname)) throw new Error(`Person ${index + 1} must use a public company, association, registry, or news source as evidence—not scraped LinkedIn data.`);
    if ((!firstName && !lastName) || !company) throw new Error(`Person ${index + 1} needs a name and company.`);
    const email = String(row.email || "").trim().toLowerCase().slice(0, 320);
    return {
      "First Name": firstName,
      "Last Name": lastName,
      "Company Name": company,
      "Title": String(row.title || "").trim().slice(0, 200),
      "Website": String(row.companyWebsite || "").trim().slice(0, 1000),
      "Email": email,
      "Email Status": email ? "published_unverified" : "missing",
      "Primary Email Source": email ? evidenceUrl : "",
      "Email Confidence": email ? "published_unverified" : "missing",
      "Evidence URL": evidenceUrl,
      "Evidence Summary": String(row.evidenceSummary || "").trim().slice(0, 1000),
      "Evidence Observed At": new Date().toISOString(),
      "Tags": ["public-web-research", "needs-review"],
    };
  });
}

function publicPeopleFingerprint(people) {
  const stableRows = people.map((person) => [
    person["First Name"],
    person["Last Name"],
    person["Company Name"],
    person.Email,
    person["Evidence URL"],
  ].map((value) => String(value || "").trim().toLowerCase()).join("|"));
  return crypto.createHash("sha256").update(stableRows.sort().join("\n")).digest("hex");
}

function publicPeoplePreviewName(people) {
  const companies = [...new Set(people.map((person) => person["Company Name"]).filter(Boolean))];
  const companyLabel = companies.length > 1 ? `${companies[0]} + ${companies.length - 1} more` : companies[0] || "Public-web research";
  return `${people.length} decision-makers · ${companyLabel}`.slice(0, 180);
}

async function savePublicPeoplePreview({ workspaceId, userId, people, preview, status = "staged", source = "jarvis_public_web" }) {
  const rowsByIndex = new Map((preview.rows || []).map((row) => [row.index, row]));
  const previewPeople = people.map((person, index) => {
    const row = rowsByIndex.get(index) || {};
    return {
      firstName: person["First Name"],
      lastName: person["Last Name"],
      title: person.Title,
      company: person["Company Name"],
      companyWebsite: person.Website,
      email: person.Email,
      emailStatus: person["Email Status"],
      evidenceUrl: person["Evidence URL"],
      evidenceSummary: person["Evidence Summary"],
      evidenceObservedAt: person["Evidence Observed At"],
      reviewStatus: row.status || "new",
      matchReason: row.matchReason || "",
      existingContactId: row.existingContact?.id || null,
    };
  });
  const fingerprint = publicPeopleFingerprint(people);
  const existing = await PeopleResearchPreview.findOne({ workspaceId, fingerprint });
  if (existing?.status === "imported") return existing;
  return PeopleResearchPreview.findOneAndUpdate(
    { workspaceId, fingerprint },
    {
      $set: {
        userId,
        name: publicPeoplePreviewName(people),
        source,
        status,
        people: previewPeople,
        summary: {
          total: preview.total,
          newContacts: preview.newContacts,
          existingContacts: preview.existingContacts,
          duplicatesInFile: preview.duplicatesInFile,
          publishedEmails: people.filter((person) => Boolean(person.Email)).length,
        },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

function isJarvisWebResearchEnabled() {
  return process.env.JARVIS_OPENAI_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

function researchModel() {
  return process.env.JARVIS_RESEARCH_OPENAI_MODEL || "gpt-5.6-terra";
}

const personSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
    title: { type: "string" },
    company: { type: "string" },
    companyWebsite: { type: "string" },
    email: { type: "string" },
    evidenceUrl: { type: "string" },
    evidenceSummary: { type: "string" },
  },
  required: ["firstName", "lastName", "title", "company", "companyWebsite", "email", "evidenceUrl", "evidenceSummary"],
};

async function researchAndStagePublicPeople({ question, maxResults = 20, workspaceId, userId }) {
  if (!isJarvisWebResearchEnabled()) {
    const error = new Error("Jarvis live web research is not enabled. Add OpenAI API billing, then set JARVIS_OPENAI_ENABLED=true.");
    error.code = "JARVIS_WEB_RESEARCH_NOT_ENABLED";
    throw error;
  }
  const limit = Math.min(50, Math.max(1, Number(maxResults) || 20));
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
  const model = researchModel();
  const started = Date.now();
  let response;
  try {
    response = await client.responses.create({
      model,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search" }],
      input: [
        {
          role: "developer",
          content: `Role: You are Jarvis, the public-web lead researcher inside Growth Operator.\n\nGoal: Find up to ${limit} real decision-makers matching the user's request and return a reviewable evidence-backed list.\n\nSuccess criteria:\n- use public web search and identify named owners, founders, principals, managing partners, presidents, CEOs, or similarly relevant decision-makers\n- cite an HTTPS official company, leadership, association, government registry, or credible news page for every person\n- include an email only when that exact email is visibly published on the cited page; otherwise return an empty email\n- return an empty list when reliable evidence is insufficient\n\nConstraints:\n- never use LinkedIn as the evidence URL and do not claim to scrape LinkedIn\n- never guess or infer email addresses\n- do not create contacts, send outreach, or claim that an email is verified\n- exclude a person when their role or company cannot be supported by the cited source\n\nStop after ${limit} supported people or when further searching is unlikely to produce reliable results.`,
        },
        { role: "user", content: question },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "jarvis_public_people_research",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              people: { type: "array", items: personSchema },
            },
            required: ["people"],
          },
        },
      },
      max_output_tokens: 12000,
    });
  } catch (error) {
    await recordOpenAiUsage({ workspaceId, userId, agent: "research", feature: "public_people_research", model, endpoint: "responses", error, latencyMs: Date.now() - started });
    throw error;
  }
  await recordOpenAiUsage({ workspaceId, userId, agent: "research", feature: "public_people_research", model, endpoint: "responses", response, latencyMs: Date.now() - started });
  if (response.status !== "completed") throw new Error("Jarvis web research did not complete. Try a narrower market or fewer results.");
  const parsed = JSON.parse(response.output_text || "{}");
  const validRows = [];
  for (const row of (Array.isArray(parsed.people) ? parsed.people : []).slice(0, limit)) {
    try { validRows.push(normalizePublicPeople([row])[0]); } catch { /* Invalid or unsupported evidence is excluded. */ }
  }
  if (!validRows.length) throw new Error("Jarvis could not find evidence-backed people for this request. Try narrowing the market, location, or role.");
  const preview = await previewContactIngestion({ contacts: validRows, source: "public_web_research" });
  const savedPreview = await savePublicPeoplePreview({ workspaceId, userId, people: validRows, preview, source: "jarvis_public_web" });
  return { people: validRows, preview, savedPreview, model: response.model || researchModel() };
}

module.exports = {
  isJarvisWebResearchEnabled,
  normalizePublicPeople,
  researchAndStagePublicPeople,
  researchModel,
  savePublicPeoplePreview,
};
