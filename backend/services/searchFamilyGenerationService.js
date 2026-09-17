/**
 * Generates the EDITABLE draft search families a Public Web Discovery run
 * proposes for one approved program (services/publicWebDiscoveryEngineService.js) —
 * one LLM call via the same agent system every other AI feature in this
 * app uses (services/agentExecutionService.js), zero discovery-provider
 * spend. The owner reviews/edits every generated query before a
 * PublicWebDiscoveryRun is approved and any provider is actually called.
 */
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const CoachingProgram = require("../models/CoachingProgram");
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
// Coaches, course sellers, established syndicators, brokers, lenders,
// vendors, and capital-raising services are professionals, not
// prospective students — a student-focused search asking for "people" or
// "recent problem/intent discussions" must never be told to look for
// these, even implicitly through generic real-estate phrasing.
const STUDENT_EXCLUSION_INSTRUCTION = "For the 'people' and 'intent_discussions' categories specifically: only generate queries aimed at prospective STUDENTS/buyers — never coaches, course sellers, syndicators, brokers, lenders, vendors, or capital-raising services. Those are professionals, not students, and belong in 'communities'/'organizations' instead if relevant at all.";

/**
 * Resolves the real content search-family generation and ICP derivation
 * are grounded in. coachingProgramId (the real CoachingProgram, reading
 * targetAudience with an internalSummary fallback — the same field every
 * other targeting-consuming path in this app already reads) is preferred;
 * programNoteId (a raw Knowledge Center PDF note) is the older path, kept
 * only for the separate "Direct public-web search" advanced tool, which
 * still selects a note directly rather than a program.
 */
async function resolveProgramContent({ workspaceId, programNoteId, coachingProgramId }, dependencies = {}) {
  if (coachingProgramId) {
    const ProgramModel = dependencies.CoachingProgram || CoachingProgram;
    const program = await ProgramModel.findOne({ _id: coachingProgramId, workspaceId, status: "active" }).select("name targetAudience internalSummary").lean();
    if (!program) { const error = new Error("That program was not found among this workspace's active programs"); error.code = "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND"; throw error; }
    const content = program.targetAudience || program.internalSummary || "";
    if (!content.trim()) { const error = new Error(`"${program.name}" has no target audience set yet — add one in Coaching → Programs before searching for it.`); error.code = "DISCOVERY_SEARCH_PROGRAM_NO_TARGETING"; throw error; }
    return { title: program.name, content };
  }
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const note = await NoteModel.findOne({ _id: programNoteId, workspaceId, category: "offers-programs", status: "approved" }).select("title content").lean();
  if (!note) { const error = new Error("That program note was not found among this workspace's approved Offers & Programs"); error.code = "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND"; throw error; }
  return note;
}

async function generateSearchFamilies({ workspaceId, userId, auth, programNoteId, coachingProgramId, locations = [], categories = null, audienceFraming = "", correlationId = "" }, dependencies = {}) {
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  const note = await resolveProgramContent({ workspaceId, programNoteId, coachingProgramId }, dependencies);

  const safeLocations = (Array.isArray(locations) ? locations : []).slice(0, 10).map((v) => clean(v, 120)).filter(Boolean);
  // A preset (e.g. "Find prospective students") can restrict generation to
  // just the categories it needs, rather than paying for an LLM call that
  // drafts queries for categories that preset will never use.
  const activeCategories = (Array.isArray(categories) && categories.length ? categories.filter((c) => JOB_CATEGORIES.includes(c)) : JOB_CATEGORIES);
  const categoryList = activeCategories.map((category) => `- ${category}: ${CATEGORY_DESCRIPTIONS[category]}`).join("\n");
  // Computed from the server's own clock, never a training-data year baked
  // into the model's own assumptions — an event/date query must never
  // silently reference a year that has already passed.
  const currentYear = new Date().getFullYear();

  const result = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "generate_public_web_discovery_search_families", correlationId,
    operationalContext: `Program: ${clean(note.title, 200)}\n${clean(note.content, 4000)}\n\n${safeLocations.length ? `Target locations: ${safeLocations.join(", ")}\n\n` : ""}The current year is ${currentYear}. If a query needs a year (e.g. an upcoming event or "this year"), use ${currentYear} or ${currentYear + 1} — never a year that has already passed. Never hardcode an old year from memory.\n\nGenerate up to ${MAX_QUERIES_PER_CATEGORY} distinct, real public-web search queries for EACH of the following categories, varying phrasing and terminology (never near-duplicate queries) and, when locations are given, spreading queries across them rather than repeating one location on every query:\n${categoryList}\n\n${STUDENT_EXCLUSION_INSTRUCTION}${audienceFraming ? `\n\n${audienceFraming}` : ""}\n\nEvery query must be searchable on the real public web today — never a request to access private, login-only, or members-only content on any platform. Base every query strictly on this program's real audience and terminology — never invent an audience the program doesn't actually serve.`,
    input: { hasLocations: Boolean(safeLocations.length), currentYear },
    options: { responseSchema: FAMILY_RESPONSE_SCHEMA, schemaName: "public_web_discovery_search_families" },
  });

  const families = (result.output.families || [])
    .filter((family) => activeCategories.includes(family.category))
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

module.exports = { generateSearchFamilies, resolveProgramContent, CATEGORY_DESCRIPTIONS, MAX_QUERIES_PER_CATEGORY };
