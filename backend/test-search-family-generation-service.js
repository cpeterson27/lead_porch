// Regression coverage for services/searchFamilyGenerationService.js's
// resolveProgramContent() — the fix for a real, user-caught gap: the
// High-Volume Public Web Discovery engine picked "a program" from approved
// Knowledge Center PDF notes (a completely different collection than the
// real CoachingProgram records, with its own, disconnected count — the
// exact "why does it show 8 when I have 7 programs" bug), and generated
// search queries from that PDF's raw text directly — never reading
// CoachingProgram.targetAudience, the field every other targeting-consuming
// path in this app already reads. resolveProgramContent() is the shared
// fix: coachingProgramId (preferred) resolves against the real
// CoachingProgram and its targetAudience/internalSummary; programNoteId
// (legacy) is kept only for the separate "Direct public-web search"
// advanced tool.
//
// Fully mocked — NO real database connection is made anywhere in this
// file, per this session's standing "no live providers, no production
// writes" constraint.
require("dotenv").config();
const assert = require("node:assert/strict");
const { resolveProgramContent, generateSearchFamilies } = require("./services/searchFamilyGenerationService");

const WORKSPACE_ID = "workspace-1";

function fakeProgramModel(programs) {
  return { findOne: ({ _id, workspaceId, status }) => ({ select: () => ({ lean: async () => programs.find((p) => p._id === _id && p.workspaceId === workspaceId && (!status || p.status === status)) || null }) }) };
}
function fakeNoteModel(notes) {
  return { findOne: ({ _id, workspaceId }) => ({ select: () => ({ lean: async () => notes.find((n) => n._id === _id && n.workspaceId === workspaceId) || null }) }) };
}

async function testResolvesViaCoachingProgramReadingTargetAudience() {
  const CoachingProgram = fakeProgramModel([{ _id: "prog-1", workspaceId: WORKSPACE_ID, status: "active", name: "OPM Bootcamp", targetAudience: "W-2 professionals with a stuck 401k.", internalSummary: "Old duplicate public copy — must never be used when targetAudience is set." }]);
  const result = await resolveProgramContent({ workspaceId: WORKSPACE_ID, coachingProgramId: "prog-1" }, { CoachingProgram });
  assert.equal(result.title, "OPM Bootcamp");
  assert.equal(result.content, "W-2 professionals with a stuck 401k.");
  console.log("PASS testResolvesViaCoachingProgramReadingTargetAudience");
}

async function testFallsBackToInternalSummaryWhenTargetAudienceIsEmpty() {
  const CoachingProgram = fakeProgramModel([{ _id: "prog-1", workspaceId: WORKSPACE_ID, status: "active", name: "OPM Bootcamp", targetAudience: "", internalSummary: "Fallback notes describing the audience." }]);
  const result = await resolveProgramContent({ workspaceId: WORKSPACE_ID, coachingProgramId: "prog-1" }, { CoachingProgram });
  assert.equal(result.content, "Fallback notes describing the audience.");
  console.log("PASS testFallsBackToInternalSummaryWhenTargetAudienceIsEmpty");
}

async function testThrowsAClearErrorWhenAProgramHasNoTargetingAtAll() {
  const CoachingProgram = fakeProgramModel([{ _id: "prog-1", workspaceId: WORKSPACE_ID, status: "active", name: "Untargeted Program", targetAudience: "", internalSummary: "" }]);
  await assert.rejects(
    () => resolveProgramContent({ workspaceId: WORKSPACE_ID, coachingProgramId: "prog-1" }, { CoachingProgram }),
    (error) => error.code === "DISCOVERY_SEARCH_PROGRAM_NO_TARGETING" && error.message.includes("Untargeted Program"),
  );
  console.log("PASS testThrowsAClearErrorWhenAProgramHasNoTargetingAtAll");
}

async function testNeverResolvesAnArchivedOrDraftProgram() {
  const CoachingProgram = fakeProgramModel([{ _id: "prog-1", workspaceId: WORKSPACE_ID, status: "draft", name: "Draft Program", targetAudience: "Should never be searchable." }]);
  await assert.rejects(
    () => resolveProgramContent({ workspaceId: WORKSPACE_ID, coachingProgramId: "prog-1" }, { CoachingProgram }),
    (error) => error.code === "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND",
  );
  console.log("PASS testNeverResolvesAnArchivedOrDraftProgram");
}

async function testLegacyProgramNoteIdPathStillWorksForTheAdvancedTool() {
  const JarvisMemoryNote = fakeNoteModel([{ _id: "note-1", workspaceId: WORKSPACE_ID, title: "Some Uploaded PDF", content: "Raw extracted PDF text." }]);
  const result = await resolveProgramContent({ workspaceId: WORKSPACE_ID, programNoteId: "note-1" }, { JarvisMemoryNote });
  assert.equal(result.title, "Some Uploaded PDF");
  assert.equal(result.content, "Raw extracted PDF text.");
  console.log("PASS testLegacyProgramNoteIdPathStillWorksForTheAdvancedTool");
}

async function testGenerateSearchFamiliesUsesRealTargetAudienceNotRawPdfText() {
  const CoachingProgram = fakeProgramModel([{ _id: "prog-1", workspaceId: WORKSPACE_ID, status: "active", name: "OPM Bootcamp", targetAudience: "W-2 professionals seeking passive income.", internalSummary: "" }]);
  let promptedWith = "";
  const runAgent = async ({ operationalContext }) => { promptedWith = operationalContext; return { output: { families: [] } }; };
  const result = await generateSearchFamilies(
    { workspaceId: WORKSPACE_ID, userId: "u1", coachingProgramId: "prog-1", locations: [] },
    { CoachingProgram, runAgent },
  );
  assert.equal(result.programName, "OPM Bootcamp");
  assert.ok(promptedWith.includes("W-2 professionals seeking passive income."), "the AI prompt must be grounded in the real targetAudience text, not a raw PDF");
  console.log("PASS testGenerateSearchFamiliesUsesRealTargetAudienceNotRawPdfText");
}

(async () => {
  await testResolvesViaCoachingProgramReadingTargetAudience();
  await testFallsBackToInternalSummaryWhenTargetAudienceIsEmpty();
  await testThrowsAClearErrorWhenAProgramHasNoTargetingAtAll();
  await testNeverResolvesAnArchivedOrDraftProgram();
  await testLegacyProgramNoteIdPathStillWorksForTheAdvancedTool();
  await testGenerateSearchFamiliesUsesRealTargetAudienceNotRawPdfText();
  console.log("\nAll search-family-generation resolveProgramContent tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
