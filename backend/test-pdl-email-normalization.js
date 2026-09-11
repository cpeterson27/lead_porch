// Targeted regression coverage for the PDL candidate-normalization crash:
// a real production run had PDL return 5 candidates, but processing threw
// "candidate.email.toLowerCase is not a function" partway through, leaving
// 0 accepted even though PDL itself succeeded. Root cause: PDL's `work_email`
// field is documented as a plain string but a real response returned it as
// an object/array shape for at least one candidate, and
// peopleDataLabsService.js's normalizePerson() passed that value straight
// through — then leadGenerationCoordinatorService.js's identityKey() and
// mergeIcpMatchCandidate() called .toLowerCase() on it directly.
//
// Fully mocked — NO real or test database connection is made anywhere in
// this file (every model is a plain in-memory fake object). TEST_MONGO_URI
// is still not configured in this environment (confirmed before writing
// this file), so — consistent with every other test file in this
// session — verification stays mocked-only rather than risk an
// unconfigured/misdirected real connection. No live PDL call is made
// anywhere here.
require("dotenv").config();
const assert = require("node:assert/strict");
const peopleDataLabsService = require("./services/peopleDataLabsService");
const leadGenerationCoordinatorService = require("./services/leadGenerationCoordinatorService");

const { extractEmailString, classifyWorkEmail, normalizePerson } = peopleDataLabsService;

function leanQuery(result) {
  const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => result };
  return chain;
}

function fakeGroundingResultModel() {
  const rows = [];
  return {
    rows,
    find: () => leanQuery([]),
    findOne: async () => null,
    create: async (doc) => { const row = { _id: `fake-${rows.length}`, conflicts: [], providers: [], ...doc }; rows.push(row); return row; },
  };
}

function testExtractEmailStringHandlesEveryRealShapeSafely() {
  assert.equal(extractEmailString("person@example.com"), "person@example.com", "a plain string email must pass through");
  assert.equal(extractEmailString("  Person@Example.com  "), "Person@Example.com", "must trim but never lowercase — casing is preserved for the caller to normalize");
  assert.equal(extractEmailString("not-an-email"), "", "a string that isn't a real email address must be rejected, not passed through");
  assert.equal(extractEmailString(""), "");
  assert.equal(extractEmailString(null), "");
  assert.equal(extractEmailString(undefined), "");

  // The actual anomalous shapes PDL has been observed returning for
  // `work_email` instead of a bare string.
  assert.equal(extractEmailString({ address: "person@example.com", first_seen: "2020-01-01" }), "person@example.com", "an object with an address field must be extracted");
  assert.equal(extractEmailString({ email: "person@example.com" }), "person@example.com", "an object with an email field must be extracted");
  assert.equal(extractEmailString([{ address: "person@example.com" }]), "person@example.com", "an array of email objects must use the first valid entry");
  assert.equal(extractEmailString(["person@example.com"]), "person@example.com", "an array of plain strings must use the first valid entry");
  assert.equal(extractEmailString([{ address: "not-an-email" }, { address: "person@example.com" }]), "person@example.com", "an invalid first entry must not block a valid later one");

  // Never fabricate an email by stringifying garbage.
  assert.equal(extractEmailString({ foo: "bar" }), "", "an object with no recognizable email field must resolve to empty, never '[object Object]'");
  assert.equal(extractEmailString([{ foo: "bar" }]), "");
  assert.equal(extractEmailString(42), "", "a non-string, non-object, non-array value must resolve to empty");
}

function testClassifyWorkEmailNeverThrowsOnAnomalousShapes() {
  assert.deepEqual(classifyWorkEmail("person@example.com"), { email: "person@example.com", state: "provider_validated" });
  assert.deepEqual(classifyWorkEmail({ address: "person@example.com" }), { email: "person@example.com", state: "provider_validated" }, "an object work_email must still classify as provider_validated once extracted");
  assert.deepEqual(classifyWorkEmail({ foo: "bar" }), { email: "", state: "unavailable" }, "an unextractable object must classify as unavailable, never crash or fabricate");
  assert.deepEqual(classifyWorkEmail(null), { email: "", state: "unavailable" });
}

function testNormalizePersonNeverProducesANonStringEmail() {
  // This is the literal raw PDL /person/search shape that reportedly
  // caused the crash: work_email came back as an object for one result.
  const raw = { id: "p1", full_name: "Real Prospect", job_title: "Owner", work_email: { address: "prospect@acme.com", first_seen: "2021-05-01" } };
  const normalized = normalizePerson(raw);
  assert.equal(typeof normalized.email, "string", "normalizePerson must always yield a string email, regardless of the raw shape");
  assert.equal(normalized.email, "prospect@acme.com");
  assert.equal(normalized.emailState, "provider_validated");

  const rawGarbage = { id: "p2", full_name: "Another Prospect", work_email: { unexpected_field: 123 } };
  const normalizedGarbage = normalizePerson(rawGarbage);
  assert.equal(normalizedGarbage.email, "", "an unrecognizable work_email shape must resolve to an empty string, never an object or '[object Object]'");
  assert.equal(normalizedGarbage.emailState, "unavailable");
}

/**
 * End-to-end reproduction: approveAndRunSearch() processes 5 PDL
 * candidates where ONE has the anomalous object-shaped email that
 * previously crashed mid-loop (losing every candidate after it, including
 * ones with perfectly good data). After the fix, all 5 must be evaluated
 * without throwing, the anomalous one must be accepted with its real
 * extracted email (never fabricated, never dropped), and a candidate with
 * a truly unextractable email must still be accepted with email cleared
 * rather than crashing the whole run.
 */
async function testApproveAndRunSearchProcessesAllFivePdlCandidatesWithoutCrashing() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-3", status: "proposed", sources: ["pdl_person_search"], requestedCount: 5,
      icp: { titles: ["Owner"], locations: [], industries: [], keywords: [], seniority: [] },
      save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  // Mirrors what peopleDataLabsService.searchPeople() actually returns —
  // already run through normalizePerson() — including the exact anomalous
  // shape that reportedly crashed the real run.
  const peopleDataLabsServiceMock = { searchPeople: async () => ({ people: [
    normalizePerson({ id: "1", full_name: "Prospect One", job_company_name: "Acme", work_email: "one@acme.com" }),
    normalizePerson({ id: "2", full_name: "Prospect Two", job_company_name: "Beta Co", work_email: { address: "two@betaco.com", first_seen: "2020-01-01" } }), // the anomalous shape
    normalizePerson({ id: "3", full_name: "Prospect Three", job_company_name: "Gamma LLC", work_email: { unexpected_field: 999 } }), // unextractable
    normalizePerson({ id: "4", full_name: "Prospect Four", job_company_name: "Delta Inc", work_email: null }),
    normalizePerson({ id: "5", full_name: "Prospect Five", job_company_name: "Epsilon", work_email: [{ address: "five@epsilon.com" }] }),
  ] }) };
  const GroundingResultModel = fakeGroundingResultModel();

  const result = await leadGenerationCoordinatorService.approveAndRunSearch(
    { workspaceId: "workspace-1", userId: "user-1", auth: { workspaceId: "workspace-1" }, searchId: "search-3" },
    {
      DiscoverySearch: DiscoverySearchModel,
      peopleDataLabsService: peopleDataLabsServiceMock,
      GroundingResearchResult: GroundingResultModel,
      getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }),
      isSelfMatch: () => ({ isSelf: false, reasons: [] }),
    },
  );

  assert.equal(result.runSummary.sourceErrors.length, 0, "no source error should be recorded — all 5 candidates must process without throwing");
  assert.equal(result.runSummary.created, 5, "all 5 candidates must be accepted, including the ones with anomalous/missing email shapes");
  assert.equal(GroundingResultModel.rows.length, 5);

  const two = GroundingResultModel.rows.find((r) => r.name === "Prospect Two");
  assert.equal(two.email, "two@betaco.com", "the object-shaped email must be extracted to a real string, never fabricated as '[object Object]'");

  const three = GroundingResultModel.rows.find((r) => r.name === "Prospect Three");
  assert.equal(three.email, "", "an unextractable email must be stored empty, never a stringified object");
  assert.equal(three.emailState, "", "emailState must be cleared to match the empty email, never falsely claim a validated address");

  const five = GroundingResultModel.rows.find((r) => r.name === "Prospect Five");
  assert.equal(five.email, "five@epsilon.com", "an array-of-objects email shape must be extracted correctly");
}

/**
 * Two candidates that resolve to the SAME real email via different raw
 * shapes (a plain string vs. an object) must still dedupe to one row —
 * the fix must not accidentally treat them as different identities just
 * because their raw shapes differed before normalization.
 */
async function testDedupStillWorksAcrossDifferentRawEmailShapes() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-4", status: "proposed", sources: ["pdl_person_search"], requestedCount: 5,
      icp: { titles: ["Owner"], locations: [], industries: [], keywords: [], seniority: [] },
      save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  const peopleDataLabsServiceMock = { searchPeople: async () => ({ people: [
    normalizePerson({ id: "1", full_name: "Same Person", job_company_name: "Acme", work_email: "same@acme.com" }),
    normalizePerson({ id: "1b", full_name: "Same Person", job_company_name: "Acme", work_email: { address: "same@acme.com" } }),
  ] }) };
  // A GroundingResearchResult fake whose findOne actually honors the $or
  // email match, so the second candidate is recognized as the same person.
  const rows = [];
  const GroundingResultModel = {
    rows,
    find: () => leanQuery([]),
    findOne: async (filter) => rows.find((r) => (filter.$or || []).some((clause) => clause.email && r.email && clause.email === r.email.toLowerCase())) || null,
    create: async (doc) => { const row = { _id: `fake-${rows.length}`, conflicts: [], providers: [], save: async function save() { return this; }, ...doc }; rows.push(row); return row; },
  };

  const result = await leadGenerationCoordinatorService.approveAndRunSearch(
    { workspaceId: "workspace-1", userId: "user-1", auth: { workspaceId: "workspace-1" }, searchId: "search-4" },
    {
      DiscoverySearch: DiscoverySearchModel,
      peopleDataLabsService: peopleDataLabsServiceMock,
      GroundingResearchResult: GroundingResultModel,
      getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }),
      isSelfMatch: () => ({ isSelf: false, reasons: [] }),
    },
  );

  assert.equal(result.runSummary.created, 1, "the first candidate creates one row");
  assert.equal(result.runSummary.merged, 1, "the second, differently-shaped-but-same-email candidate must merge into it, not create a duplicate");
  assert.equal(rows.length, 1);
}

async function run() {
  testExtractEmailStringHandlesEveryRealShapeSafely();
  testClassifyWorkEmailNeverThrowsOnAnomalousShapes();
  testNormalizePersonNeverProducesANonStringEmail();
  await testApproveAndRunSearchProcessesAllFivePdlCandidatesWithoutCrashing();
  await testDedupStillWorksAcrossDifferentRawEmailShapes();
  console.log("PDL email normalization: extractEmailString/classifyWorkEmail/normalizePerson safely resolve string, object, and array email shapes to a real address or empty string (never a stringified object, never a crash), leadGenerationCoordinatorService's identityKey()/mergeIcpMatchCandidate() no longer throw 'candidate.email.toLowerCase is not a function' on an anomalous PDL response, all 5 candidates in a reproduced 5-candidate PDL batch (including the anomalous and unextractable shapes) are now accepted instead of the whole provider call failing, verification status is cleared to match an empty email rather than fabricated, and dedup still merges the same real person across differently-shaped raw emails — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
