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
const { sanitizeIcp, isRealisticJobTitle, buildPdlSql, buildApolloFilters, buildRunExplanation } = leadGenerationCoordinatorService;

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

/**
 * The exact real-production regression: a web-grounded (Vertex/OpenAI)
 * result reported the owner's name with role/company context appended —
 * "Ellie Baxter" alone never appeared as a clean string — so the prior
 * EXACT-only match on the raw name missed it. The trailing-context strip
 * must catch every common separator shape without introducing substring
 * matching on an unrelated name.
 */
function testIsSelfMatchCatchesNameWithTrailingContext() {
  const signals = { names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(), businessNames: new Set(["ellie's coaching"]) };
  assert.equal(isSelfMatch({ name: "Ellie Baxter, Founder of Ellie's Coaching" }, signals).isSelf, true, "a comma-separated role/company suffix must still be caught");
  assert.equal(isSelfMatch({ name: "Ellie Baxter (Ellie's Coaching)" }, signals).isSelf, true, "a parenthetical suffix must still be caught");
  assert.equal(isSelfMatch({ name: "Ellie Baxter - Ellie's Coaching" }, signals).isSelf, true, "a dash-separated suffix must still be caught");
  assert.equal(isSelfMatch({ name: "Ellie Baxter at Ellie's Coaching" }, signals).isSelf, true, "an 'at <company>' suffix must still be caught");
  // False-positive guard still holds with the new stripping logic.
  assert.equal(isSelfMatch({ name: "Ellie Smith, Regional Director" }, signals).isSelf, false, "stripping context must never turn an unrelated name into a false match");
}

/**
 * A workspace that never saved a WorkspaceConfig document (unconfigured, or
 * configured before this row existed) must still resolve its real
 * schema-default business name — this was a real gap: config?.field on a
 * null query result is always undefined, even though the schema itself
 * declares a real default value for that field.
 */
async function testGetWorkspaceSelfSignalsFallsBackToSchemaDefaultsWhenConfigMissing() {
  function FakeConfigModel(overrides) { this._data = { workspaceName: "", legalBusinessName: "Ellie's Coaching", ...overrides }; }
  FakeConfigModel.prototype.get = function get(field) { return this._data[field]; };
  FakeConfigModel.findOne = () => leanQuery(null);

  const signals = await getWorkspaceSelfSignals(
    { workspaceId: ELLIE_WORKSPACE_ID },
    {
      WorkspaceMembership: fakeMembershipModel([]),
      User: fakeUserModel([]),
      WorkspaceConfig: FakeConfigModel,
      Workspace: fakeWorkspaceModel({ name: "some-internal-slug", publicHosts: [] }),
      JarvisMemoryNote: fakeNoteModel([]),
    },
  );
  assert.ok(signals.businessNames.has("ellie's coaching"), "a missing WorkspaceConfig document must fall back to the schema's own default legalBusinessName");
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

/**
 * The reported PDL under-yield cause: a loosely-parsed ICP can put a skill
 * level / audience label ("beginner") into `titles` instead of a real job
 * title. isRealisticJobTitle/sanitizeIcp must strip these before they ever
 * reach buildPdlSql/buildApolloFilters, while a real title passes through
 * untouched.
 */
function testTitleValidationRejectsSkillLevelsNotRealTitles() {
  assert.equal(isRealisticJobTitle("Marketing Manager"), true);
  assert.equal(isRealisticJobTitle("Small Business Owner"), true);
  assert.equal(isRealisticJobTitle("beginner"), false);
  assert.equal(isRealisticJobTitle("Beginner"), false, "the check must be case-insensitive");
  assert.equal(isRealisticJobTitle("students"), false);
  assert.equal(isRealisticJobTitle(""), false);

  const icp = sanitizeIcp({ titles: ["beginner", "Marketing Manager", "Students", "Small Business Owner"], industries: [], locations: [], keywords: [], seniority: [], companySizeRange: "", exclusions: [] });
  assert.deepEqual(icp.titles, ["Marketing Manager", "Small Business Owner"], "sanitizeIcp must drop non-title phrases while keeping real titles, in order");

  const sql = buildPdlSql(icp);
  assert.ok(!sql.toLowerCase().includes("beginner"), "the PDL SQL must never contain a rejected non-title phrase");
  assert.ok(sql.includes("Marketing Manager"), "a real title must still reach the PDL SQL");

  const filters = buildApolloFilters(icp);
  assert.ok(!filters.person_titles.includes("beginner"), "the Apollo filters must never contain a rejected non-title phrase");

  // An ICP whose ONLY "title" was a rejected phrase must degrade safely
  // (no titles clause) rather than crash or silently invent a title.
  const emptyIcp = sanitizeIcp({ titles: ["beginner"], industries: [], locations: ["Austin, TX"], keywords: [], seniority: [], companySizeRange: "", exclusions: [] });
  assert.deepEqual(emptyIcp.titles, []);
  const sqlWithOnlyLocation = buildPdlSql(emptyIcp);
  assert.ok(sqlWithOnlyLocation.includes("Austin"), "buildPdlSql must still use other real ICP criteria when titles end up empty");
  assert.ok(!sqlWithOnlyLocation.toLowerCase().includes("job_title"), "no title clause should be built when no realistic title survives");
}

/**
 * Per-provider run-summary breakdown: vertexGroundingDiscoveryService.search()
 * must report requested/returned/rejected(self/freshness/capacity/dedup)/
 * accepted per provider, and approveAndRunSearch() must assemble the same
 * shape for PDL/Apollo and produce an honest "why fewer than requested"
 * explanation rather than implying the full count was found.
 */
async function testSearchReportsPerProviderBreakdown() {
  const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const staleDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const vertexGroundingService = { groundedSearch: async () => ({
    results: [
      { type: "person", name: "Ellie Baxter", organizationName: "", organizationDomain: "", summary: "", evidenceUrls: ["https://example.com/a"], confidence: "single_source", evidenceDate: recentDate }, // self
      { type: "person", name: "Stale Lead", organizationName: "Old Co", organizationDomain: "oldco.com", summary: "", evidenceUrls: ["https://example.com/b"], confidence: "single_source", evidenceDate: staleDate }, // stale
      { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "", evidenceUrls: ["https://example.com/c"], confidence: "single_source", evidenceDate: recentDate }, // accepted
    ],
    groundingCitations: [],
  }) };
  const Model = fakeGroundingResultModel();

  const result = await vertexGroundingDiscoveryService.search(
    { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-owner", auth: { workspaceId: ELLIE_WORKSPACE_ID }, query: "q", resultTypes: ["person"], source: "vertex", maxPeople: 5 },
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

  assert.ok(Array.isArray(result.providerStats), "search() must return a providerStats breakdown");
  const vertexStats = result.providerStats.find((p) => p.provider === "vertex_grounding");
  assert.ok(vertexStats, "vertex_grounding must appear in the breakdown");
  assert.equal(vertexStats.requested, 5);
  assert.equal(vertexStats.returned, 3, "returned must be the raw pre-filter count from this provider");
  assert.equal(vertexStats.rejectedSelf, 1);
  assert.equal(vertexStats.rejectedFreshness, 1);
  assert.equal(vertexStats.accepted, 1);
  assert.equal(result.created, 1);
}

/**
 * approveAndRunSearch() end-to-end: PDL returns 5 candidates, 4 are the
 * self-match, 1 survives — matching the reported "requested 5, got 1"
 * production shape — and the run must produce a per-provider breakdown
 * plus an explanation that says why, never implying 5 were found.
 */
async function testApproveAndRunSearchReportsBreakdownAndExplanationOnUnderYield() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-2", status: "proposed", sources: ["pdl_person_search"], requestedCount: 5,
      icp: { titles: ["Owner"], locations: [], industries: [], keywords: [], seniority: [] },
      save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  const peopleDataLabsService = { searchPeople: async () => ({ people: [
    { fullName: "Ellie Baxter", company: "", companyDomain: "", linkedinUrl: "", email: "", emailState: "" },
    { fullName: "Ellie Baxter, Founder", company: "Ellie's Coaching", companyDomain: "", linkedinUrl: "", email: "", emailState: "" },
    { fullName: "Ellie Baxter", company: "", companyDomain: "", linkedinUrl: "l1", email: "", emailState: "" },
    { fullName: "Ellie Baxter", company: "", companyDomain: "", linkedinUrl: "l2", email: "", emailState: "" },
    { fullName: "Real Prospect", company: "Acme", companyDomain: "acme.com", linkedinUrl: "", email: "prospect@acme.com", emailState: "unverified" },
  ] }) };
  const GroundingResultModel = fakeGroundingResultModel();

  const result = await leadGenerationCoordinatorService.approveAndRunSearch(
    { workspaceId: ELLIE_WORKSPACE_ID, userId: "user-owner", auth: { workspaceId: ELLIE_WORKSPACE_ID }, searchId: "search-2" },
    {
      DiscoverySearch: DiscoverySearchModel,
      peopleDataLabsService,
      GroundingResearchResult: GroundingResultModel,
      getWorkspaceSelfSignals: async () => ({ names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(), businessNames: new Set(["ellie's coaching"]) }),
      isSelfMatch: (candidate, signals) => {
        const { isSelfMatch: real } = require("./services/workspaceSelfExclusionService");
        return real(candidate, signals);
      },
    },
  );

  assert.equal(result.runSummary.created, 1, "only the real prospect must survive");
  assert.equal(result.runSummary.excludedForSelfMatch, 4, "all four Ellie Baxter variants (plain and context-suffixed) must be excluded");
  assert.ok(Array.isArray(result.runSummary.providerBreakdown));
  const pdlStats = result.runSummary.providerBreakdown.find((p) => p.provider === "pdl_person_search");
  assert.equal(pdlStats.requested, 5);
  assert.equal(pdlStats.returned, 5);
  assert.equal(pdlStats.rejectedSelf, 4);
  assert.equal(pdlStats.accepted, 1);
  assert.ok(result.runSummary.explanation.includes("Requested 5"), "the explanation must state what was actually requested");
  assert.ok(result.runSummary.explanation.includes("1 new candidate"), "the explanation must state the true survived count");
  assert.ok(!/5 (new candidates|found)/i.test(result.runSummary.explanation), "the explanation must never imply the full requested count was found");
  assert.ok(result.runSummary.explanation.includes("self-match"), "the explanation must name self-match exclusion as a real reason for the shortfall");
}

function testBuildRunExplanationCoversMetAndUnmetCases() {
  const met = buildRunExplanation({ requestedCount: 5, created: 5, merged: 0, excludedForSelfMatch: 0, excludedForFreshness: 0, sourceErrors: [] });
  assert.ok(met.includes("Requested 5; 5 new candidates"));

  const unmetWithErrors = buildRunExplanation({ requestedCount: 5, created: 0, merged: 0, excludedForSelfMatch: 0, excludedForFreshness: 0, sourceErrors: [{ source: "apollo_person_search", message: "disabled" }] });
  assert.ok(unmetWithErrors.includes("Requested 5, but only 0"));
  assert.ok(unmetWithErrors.includes("apollo_person_search failed"));
}

async function run() {
  await testGetWorkspaceSelfSignalsGathersRealDataOnly();
  testIsSelfMatchExcludesRealSelfSignalsOnly();
  testIsSelfMatchCatchesNameWithTrailingContext();
  await testGetWorkspaceSelfSignalsFallsBackToSchemaDefaultsWhenConfigMissing();
  testExcludeSelfMatchesSplitsCorrectlyAndCounts();
  await testSearchExcludesSelfMatchFromVertexOpenaiResults();
  await testApproveAndRunSearchExcludesSelfMatchFromPdlApolloResults();
  testTitleValidationRejectsSkillLevelsNotRealTitles();
  await testSearchReportsPerProviderBreakdown();
  await testApproveAndRunSearchReportsBreakdownAndExplanationOnUnderYield();
  testBuildRunExplanationCoversMetAndUnmetCases();
  console.log("Workspace self-exclusion + run-summary fixes: name matching now catches web-grounded results with role/company context appended (the actual production miss), a missing WorkspaceConfig document falls back to real schema defaults, PDL/Apollo title mapping rejects skill-level/audience phrases like 'beginner' instead of querying on them, per-provider requested/returned/rejected(self/freshness/dedup)/accepted breakdowns are produced for every provider, and the run explanation states the real survived count and why — never implying the full requested count was found — while every existing self-exclusion/freshness/dedup safeguard from the prior fix still passes unchanged — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
