// Targeted regression coverage for services/workspaceSelfExclusionService.js
// and its wiring into vertexGroundingDiscoveryService.js's search() (Vertex/
// OpenAI) and leadGenerationCoordinatorService.js's approveAndRunSearch()
// (PDL/Apollo): the workspace owner, active team members, the workspace's
// own business, and its own domain must never be saved to the review queue
// as a "prospect", regardless of which provider reported them — and a
// legitimate prospect who merely shares a first name, or works at a
// similarly-but-not-identically-named company, must never be wrongly
// excluded (matching is exact, never fuzzy/substring).
//
// Fully mocked — NO real or test database connection is made anywhere in
// this file (every model is a plain in-memory fake object), per instruction:
// no production writes, mocked targeted checks and syntax checks only.
require("dotenv").config();
const assert = require("node:assert/strict");
const { getWorkspaceSelfSignals, isSelfMatch, excludeSelfMatches } = require("./services/workspaceSelfExclusionService");
const vertexGroundingDiscoveryService = require("./services/vertexGroundingDiscoveryService");
const leadGenerationCoordinatorService = require("./services/leadGenerationCoordinatorService");

// ---- tiny in-memory fakes, no mongoose/mongodb involved at all ----
function leanQuery(result) {
  const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => result };
  return chain;
}
function fakeMembershipModel(rows) {
  return { find: (filter) => leanQuery(rows.filter((r) => String(r.workspaceId) === String(filter.workspaceId) && r.status === filter.status)) };
}
function fakeUserModel(rows) {
  return { find: (filter) => leanQuery(rows.filter((r) => (filter._id.$in || []).map(String).includes(String(r._id)))) };
}
function fakeConfigModel(doc) {
  return { findOne: () => leanQuery(doc) };
}
function fakeWorkspaceModel(doc) {
  return { findById: () => leanQuery(doc) };
}
function fakeNoteModel(rows) {
  return { find: (filter) => leanQuery(rows.filter((r) => String(r.workspaceId) === String(filter.workspaceId) && r.category === filter.category && r.status === filter.status)) };
}
/**
 * A minimal fake GroundingResearchResult sufficient for search()'s
 * create-only path (find().select().lean()) and for
 * mergeIcpMatchCandidate()'s plain findOne()/create() calls — both used
 * with no pre-existing rows to merge into, matching a fresh search.
 */
function fakeGroundingResultModel() {
  const rows = [];
  return {
    rows,
    find: () => leanQuery([]),
    findOne: async () => null,
    create: async (doc) => { const row = { _id: `fake-${rows.length}`, conflicts: [], providers: [], ...doc }; rows.push(row); return row; },
  };
}

const ELLIE_WORKSPACE_ID = "6a69491ceb8b0a51048bd0cd";
const ellieMemberships = [
  { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-owner", status: "active" },
  { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-coach", status: "active" },
  { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-invited-not-active", status: "invited" },
];
const ellieUsers = [
  { _id: "user-owner", name: "Ellie Baxter", email: "ellie@elliescoaching.com" },
  { _id: "user-coach", name: "Sam Coach", email: "sam@elliescoaching.com" },
  { _id: "user-invited-not-active", name: "Not Yet Joined", email: "notyet@elliescoaching.com" },
];
const ellieConfig = { workspaceName: "Ellie's Coaching", legalBusinessName: "Ellie's Coaching", websiteUrl: "https://elliescoaching.com" };
const ellieWorkspaceDoc = { name: "Ellie's Coaching", publicHosts: [] };
const ellieProgramNotes = [{ workspaceId: ELLIE_WORKSPACE_ID, category: "offers-programs", status: "approved", title: "Multifamily Bootcamp" }];

async function testGetWorkspaceSelfSignalsGathersRealDataOnly() {
  const signals = await getWorkspaceSelfSignals(
    { workspaceId: ELLIE_WORKSPACE_ID },
    {
      WorkspaceMembership: fakeMembershipModel(ellieMemberships),
      User: fakeUserModel(ellieUsers),
      WorkspaceConfig: fakeConfigModel(ellieConfig),
      Workspace: fakeWorkspaceModel(ellieWorkspaceDoc),
      JarvisMemoryNote: fakeNoteModel(ellieProgramNotes),
    },
  );

  assert.ok(signals.names.has("ellie baxter"), "the active owner's real name must be included");
  assert.ok(signals.names.has("sam coach"), "an active team member's name must be included");
  assert.ok(!signals.names.has("not yet joined"), "an INVITED (not yet active) member must not be treated as a current team member");
  assert.ok(signals.emails.has("ellie@elliescoaching.com"));
  assert.ok(signals.domains.has("elliescoaching.com"), "the domain must be derivable both from the configured website and from team members' own email domains");
  assert.ok(signals.businessNames.has("ellie's coaching"));
  assert.ok(signals.businessNames.has("multifamily bootcamp"), "an approved program's own brand name counts as the workspace's own business too");
}

function testIsSelfMatchExcludesRealSelfSignalsOnly() {
  const signals = { names: new Set(["ellie baxter"]), emails: new Set(["ellie@elliescoaching.com"]), domains: new Set(["elliescoaching.com"]), businessNames: new Set(["ellie's coaching"]) };

  assert.equal(isSelfMatch({ name: "Ellie Baxter" }, signals).isSelf, true, "exact name match must be excluded");
  assert.equal(isSelfMatch({ name: "  ELLIE baxter  " }, signals).isSelf, true, "matching must be case/whitespace-insensitive");
  assert.equal(isSelfMatch({ name: "Someone Else", email: "ellie@elliescoaching.com" }, signals).isSelf, true, "exact email match must be excluded even with a different display name");
  assert.equal(isSelfMatch({ name: "Someone Else", email: "someone@elliescoaching.com" }, signals).isSelf, true, "an email on the workspace's own domain must be excluded");
  assert.equal(isSelfMatch({ name: "Someone Else", organizationDomain: "elliescoaching.com" }, signals).isSelf, true, "an organizationDomain matching the workspace's own domain must be excluded");
  assert.equal(isSelfMatch({ name: "Someone Else", organizationName: "Ellie's Coaching" }, signals).isSelf, true, "an organizationName matching the workspace's own business must be excluded");

  // The critical false-positive guards: legitimate prospects must never be caught.
  assert.equal(isSelfMatch({ name: "Ellie Smith" }, signals).isSelf, false, "sharing only a first name with the owner must NEVER be treated as a self-match");
  assert.equal(isSelfMatch({ name: "Jane Owner", email: "jane@metroreia.org", organizationName: "Metro REIA", organizationDomain: "metroreia.org" }, signals).isSelf, false, "an unrelated real prospect must never be excluded");
  assert.equal(isSelfMatch({ name: "Someone Else", organizationName: "Ellie's Coaching Alumni Network" }, signals).isSelf, false, "matching is EXACT, not substring — a similarly-named but different organization must not be excluded");
}

function testExcludeSelfMatchesSplitsCorrectlyAndCounts() {
  const signals = { names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(["elliescoaching.com"]), businessNames: new Set() };
  const candidates = [
    { name: "Ellie Baxter" },
    { name: "Real Prospect One", email: "one@realprospect.com" },
    { name: "Real Prospect Two", email: "two@elliescoaching.com" }, // self via domain
    { name: "Real Prospect Three", email: "three@realprospect.com" },
  ];
  const { kept, excludedCount } = excludeSelfMatches(candidates, signals);
  assert.equal(excludedCount, 2);
  assert.deepEqual(kept.map((c) => c.name), ["Real Prospect One", "Real Prospect Three"]);
}

/**
 * Integration-style check: vertexGroundingDiscoveryService.search() must
 * exclude a self-match BEFORE the freshness gate/cap and report the count,
 * while a legitimate fresh person passes through untouched.
 */
async function testSearchExcludesSelfMatchFromVertexOpenaiResults() {
  const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const vertexGroundingService = { groundedSearch: async () => ({
    results: [
      { type: "person", name: "Ellie Baxter", organizationName: "", organizationDomain: "", summary: "", evidenceUrls: ["https://example.com/a"], confidence: "single_source", evidenceDate: recentDate },
      { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "", evidenceUrls: ["https://example.com/b"], confidence: "single_source", evidenceDate: recentDate },
    ],
    groundingCitations: [],
  }) };
  const Model = fakeGroundingResultModel();

  const result = await vertexGroundingDiscoveryService.search(
    { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-owner", auth: { workspaceId: ELLIE_WORKSPACE_ID }, query: "q", resultTypes: ["person"], source: "vertex" },
    {
      vertexGroundingService,
      GroundingResearchResult: Model,
      getWorkspaceSelfSignals: async () => ({ names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(), businessNames: new Set() }),
      excludeSelfMatches: (candidates, signals) => {
        const { excludeSelfMatches: real } = require("./services/workspaceSelfExclusionService");
        return real(candidates, signals);
      },
    },
  );

  assert.equal(result.excludedForSelfMatch, 1, "the self-match must be counted as excluded");
  assert.equal(result.created, 1, "only the legitimate prospect may be staged");
  assert.equal(Model.rows.length, 1);
  assert.equal(Model.rows[0].name, "Jane Owner", "the workspace owner must never appear in the review queue");
}

/**
 * Same guarantee for the PDL/Apollo ICP-match path via approveAndRunSearch().
 */
async function testApproveAndRunSearchExcludesSelfMatchFromPdlApolloResults() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-1", status: "proposed", sources: ["pdl_person_search"], requestedCount: 10,
      icp: { titles: ["Owner"], locations: [], industries: [], keywords: [], seniority: [] },
      save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  const peopleDataLabsService = { searchPeople: async () => ({ people: [
    { fullName: "Ellie Baxter", company: "", companyDomain: "", linkedinUrl: "", email: "", emailState: "" },
    { fullName: "Real Prospect", company: "Acme", companyDomain: "acme.com", linkedinUrl: "", email: "prospect@acme.com", emailState: "unverified" },
  ] }) };
  const GroundingResultModel = fakeGroundingResultModel();

  const result = await leadGenerationCoordinatorService.approveAndRunSearch(
    { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-owner", auth: { workspaceId: ELLIE_WORKSPACE_ID }, searchId: "search-1" },
    {
      DiscoverySearch: DiscoverySearchModel,
      peopleDataLabsService,
      GroundingResearchResult: GroundingResultModel,
      getWorkspaceSelfSignals: async () => ({ names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(), businessNames: new Set() }),
      isSelfMatch: (candidate, signals) => {
        const { isSelfMatch: real } = require("./services/workspaceSelfExclusionService");
        return real(candidate, signals);
      },
    },
  );

  assert.equal(result.runSummary.excludedForSelfMatch, 1, "the PDL self-match must be counted as excluded");
  assert.equal(result.runSummary.created, 1, "only the real prospect may be staged");
  assert.equal(GroundingResultModel.rows.length, 1);
  assert.equal(GroundingResultModel.rows[0].name, "Real Prospect");
}

async function run() {
  await testGetWorkspaceSelfSignalsGathersRealDataOnly();
  testIsSelfMatchExcludesRealSelfSignalsOnly();
  testExcludeSelfMatchesSplitsCorrectlyAndCounts();
  await testSearchExcludesSelfMatchFromVertexOpenaiResults();
  await testApproveAndRunSearchExcludesSelfMatchFromPdlApolloResults();
  console.log("Workspace self-exclusion: signals are gathered only from real active-membership/config/workspace/approved-program data (never invited members), isSelfMatch excludes real self-signals with exact (never fuzzy) matching so legitimate prospects are never wrongly caught, excludeSelfMatches counts and splits correctly, and both the Vertex/OpenAI search() path and the PDL/Apollo approveAndRunSearch() path exclude a self-match before it reaches the review queue while a legitimate prospect passes through untouched — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
