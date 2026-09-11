/**
 * Generates the EDITABLE draft search families a Public Web Discovery run
 * proposes for one approved program (services/publicWebDiscoveryEngineService.js) —
 * one LLM call via the same agent system every other AI feature in this
 * app uses (services/agentExecutionService.js), zero discovery-provider
 * spend. The owner reviews/edits every generated query before a
 * PublicWebDiscoveryRun is approved and any provider is actually called.
 */
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const agentExecutionService = require("../services/agentExecutionService");
const { JOB_CATEGORIES } = require("../models/PublicWebDiscoveryRun");

const clean = (value, length) => String(value || "").trim().slice(0, length);
const MAX_QUERIES_PER_CATEGORY = 6;

const CATEGORY_DESCRIPTIONS = {
  people: "Individual prospective students/buyers who plausibly fit this program.",
  facebook_groups: "Public Facebook groups where this program's audience gathers (never anything requiring login to view — findable via public web search only).",
  communities: "Other public online communities (subreddits, Discord/Slack communities with a public landing page, niche forums-as-communities) relevant to this audience.",
  organizations: "Companies, associations, or organizations whose members/employees plausibly fit this program.",
  events: "Public conferences, meetups, webinars, or workshops this audience would attend.",
  forums: "Public discussion forums or Q&A sites where this audience asks questions relevant to the program.",
  podcasts: "Podcasts this audience plausibly listens to, covering topics the program addresses.",
  directories: "Public directories or listing sites where this audience or their organizations are listed.",
  intent_discussions: "Recent public posts/threads where someone describes the specific problem this program solves, or asks for recommendations — real buyer-intent language, not generic mentions.",
};

const FAMILY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    families: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: JOB_CATEGORIES },
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                query: { type: "string", description: "A real, specific public-web search query — never a bare keyword list, and never a request to access private/login-only content." },
                locationHint: { type: "string", description: "A specific location this query targets, or empty string for no location constraint." },
                source: { type: "string", enum: ["vertex", "openai_web_search"], description: "Which grounded-search provider best suits this query — vertex for broad Google-grounded queries, openai_web_search for narrower/recent-discussion queries." },
              },
              required: ["query", "locationHint", "source"],
              additionalProperties: false,
            },
          },
        },
        required: ["category", "queries"],
        additionalProperties: false,
      },
    },
  },
  required: ["families"],
  additionalProperties: false,
};

/**
 * Generates up to MAX_QUERIES_PER_CATEGORY editable query drafts per
 * category, varying phrasing/terminology and — when locations are given —
 * spreading across them, so the run isn't relying on one combined query to
 * find everyone. Never calls a discovery provider itself.
 */
async function generateSearchFamilies({ workspaceId, userId, auth, programNoteId, locations = [], correlationId = "" }, dependencies = {}) {
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;

  const note = await NoteModel.findOne({ _id: programNoteId, workspaceId, category: "offers-programs", status: "approved" }).select("title content").lean();
  if (!note) { const error = new Error("That program note was not found among this workspace's approved Offers & Programs"); error.code = "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND"; throw error; }

  const safeLocations = (Array.isArray(locations) ? locations : []).slice(0, 10).map((v) => clean(v, 120)).filter(Boolean);
  const categoryList = JOB_CATEGORIES.map((category) => `- ${category}: ${CATEGORY_DESCRIPTIONS[category]}`).join("\n");

  const result = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "generate_public_web_discovery_search_families", correlationId,
    operationalContext: `Program: ${clean(note.title, 200)}\n${clean(note.content, 4000)}\n\n${safeLocations.length ? `Target locations: ${safeLocations.join(", ")}\n\n` : ""}Generate up to ${MAX_QUERIES_PER_CATEGORY} distinct, real public-web search queries for EACH of the following categories, varying phrasing and terminology (never near-duplicate queries) and, when locations are given, spreading queries across them rather than repeating one location on every query:\n${categoryList}\n\nEvery query must be searchable on the real public web today — never a request to access private, login-only, or members-only content on any platform. Base every query strictly on this program's real audience and terminology — never invent an audience the program doesn't actually serve.`,
    input: { hasLocations: Boolean(safeLocations.length) },
    options: { responseSchema: FAMILY_RESPONSE_SCHEMA, schemaName: "public_web_discovery_search_families" },
  });

  const families = (result.output.families || [])
    .filter((family) => JOB_CATEGORIES.includes(family.category))
    .map((family) => ({
      category: family.category,
      queries: (family.queries || []).slice(0, MAX_QUERIES_PER_CATEGORY).map((q) => ({
        query: clean(q.query, 500),
        locationHint: clean(q.locationHint, 200),
        source: ["vertex", "openai_web_search"].includes(q.source) ? q.source : "vertex",
      })).filter((q) => q.query),
    }))
    .filter((family) => family.queries.length);

  return { programNoteId: String(note._id), programName: clean(note.title, 200), families };
}

module.exports = { generateSearchFamilies, CATEGORY_DESCRIPTIONS, MAX_QUERIES_PER_CATEGORY };
