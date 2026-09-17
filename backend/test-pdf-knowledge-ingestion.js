// Regression coverage for the new "link a PDF to a program, then apply its
// AI-drafted ideal customer profile straight into Internal Summary" flow in
// services/pdfKnowledgeIngestionService.js and services/jarvisMemoryService.js.
//
// Fully mocked — NO real or test database connection is made anywhere in
// this file. Every model is a plain injected fake, per this session's
// standing "no live providers, no production writes" constraint. auditService
// is left un-mocked deliberately: it fails safe (catches and logs) when
// AuditLog.create has no real connection, exactly as in production.
require("dotenv").config();
const assert = require("node:assert/strict");
const { ingestPdf } = require("./services/pdfKnowledgeIngestionService");
const jarvisMemoryService = require("./services/jarvisMemoryService");

const WORKSPACE_ID = "workspace-1";
const OTHER_WORKSPACE_ID = "workspace-2";
const PROGRAM_ID = "program-1";

function fakeNoteModel(store) {
  return {
    findOne: () => ({
      select: () => ({ lean: async () => null }),
    }),
    create: async (doc) => {
      const note = { ...doc, _id: `note-${store.length + 1}` };
      store.push(note);
      return note;
    },
  };
}

function fakeProgramModel(programs) {
  return {
    findOne: ({ _id, workspaceId }) => ({
      select: () => ({
        lean: async () => programs.find((p) => p._id === _id && p.workspaceId === workspaceId) || null,
      }),
    }),
  };
}

const fakeMonitorModel = { create: async () => ({ _id: "monitor-1" }) };

const okAnalysis = {
  programSummary: "A 6-week beginner multifamily course.",
  idealCustomerProfile: "W-2 professionals with a stuck 401k who want to learn to invest it themselves; also house flippers looking to scale into multifamily.",
  qualificationCriteria: ["Has $25k+ investable", "Currently W-2 employed"],
  suggestedMonitors: [],
};

async function testStoresStructuredAiAnalysisOnTheNote() {
  const notes = [];
  const outcome = await ingestPdf(
    { workspaceId: WORKSPACE_ID, userId: "user-1", auth: {}, category: "offers-programs", originalFilename: "beginner.pdf", buffer: Buffer.from("x") },
    {
      JarvisMemoryNote: fakeNoteModel(notes),
      ResearchMonitor: fakeMonitorModel,
      CoachingProgram: fakeProgramModel([]),
      pdfParse: async () => ({ text: "Some real extracted program text." }),
      runAgent: async () => ({ output: okAnalysis }),
    },
  );
  assert.equal(outcome.aiAnalysisSucceeded, true);
  assert.equal(notes[0].aiAnalysis.idealCustomerProfile, okAnalysis.idealCustomerProfile);
  assert.equal(notes[0].aiAnalysis.programSummary, okAnalysis.programSummary);
  assert.deepEqual(notes[0].aiAnalysis.qualificationCriteria, okAnalysis.qualificationCriteria);
  console.log("PASS testStoresStructuredAiAnalysisOnTheNote");
}

async function testLinksToAValidProgramInTheSameWorkspace() {
  const notes = [];
  const outcome = await ingestPdf(
    { workspaceId: WORKSPACE_ID, userId: "user-1", auth: {}, category: "offers-programs", originalFilename: "beginner.pdf", buffer: Buffer.from("x"), coachingProgramId: PROGRAM_ID },
    {
      JarvisMemoryNote: fakeNoteModel(notes),
      ResearchMonitor: fakeMonitorModel,
      CoachingProgram: fakeProgramModel([{ _id: PROGRAM_ID, workspaceId: WORKSPACE_ID }]),
      pdfParse: async () => ({ text: "Some real extracted program text." }),
      runAgent: async () => ({ output: okAnalysis }),
    },
  );
  assert.equal(outcome.note.linkedCoachingProgramId, PROGRAM_ID);
  console.log("PASS testLinksToAValidProgramInTheSameWorkspace");
}

async function testDropsAProgramIdFromAnotherWorkspaceInsteadOfThrowing() {
  const notes = [];
  const outcome = await ingestPdf(
    { workspaceId: WORKSPACE_ID, userId: "user-1", auth: {}, category: "offers-programs", originalFilename: "beginner.pdf", buffer: Buffer.from("x"), coachingProgramId: PROGRAM_ID },
    {
      JarvisMemoryNote: fakeNoteModel(notes),
      ResearchMonitor: fakeMonitorModel,
      // Program exists, but under a different workspace — must not link.
      CoachingProgram: fakeProgramModel([{ _id: PROGRAM_ID, workspaceId: OTHER_WORKSPACE_ID }]),
      pdfParse: async () => ({ text: "Some real extracted program text." }),
      runAgent: async () => ({ output: okAnalysis }),
    },
  );
  assert.equal(outcome.note.linkedCoachingProgramId, null);
  console.log("PASS testDropsAProgramIdFromAnotherWorkspaceInsteadOfThrowing");
}

async function testNeverInventsAiAnalysisWhenAnalysisFails() {
  const notes = [];
  const outcome = await ingestPdf(
    { workspaceId: WORKSPACE_ID, userId: "user-1", auth: {}, category: "offers-programs", originalFilename: "beginner.pdf", buffer: Buffer.from("x") },
    {
      JarvisMemoryNote: fakeNoteModel(notes),
      ResearchMonitor: fakeMonitorModel,
      CoachingProgram: fakeProgramModel([]),
      pdfParse: async () => ({ text: "Some real extracted program text." }),
      runAgent: async () => { throw new Error("model unavailable"); },
    },
  );
  assert.equal(outcome.aiAnalysisSucceeded, false);
  assert.equal(notes[0].aiAnalysis, undefined);
  console.log("PASS testNeverInventsAiAnalysisWhenAnalysisFails");
}

async function testListNotesFiltersByLinkedCoachingProgramId() {
  const allNotes = [
    { _id: "n1", workspaceId: WORKSPACE_ID, category: "offers-programs", status: "approved", linkedCoachingProgramId: PROGRAM_ID },
    { _id: "n2", workspaceId: WORKSPACE_ID, category: "offers-programs", status: "approved", linkedCoachingProgramId: "program-2" },
    { _id: "n3", workspaceId: WORKSPACE_ID, category: "offers-programs", status: "draft", linkedCoachingProgramId: PROGRAM_ID },
  ];
  const Model = {
    find: (filter) => ({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: async () => allNotes.filter((note) =>
              note.workspaceId === filter.workspaceId
              && (!filter.category || note.category === filter.category)
              && (!filter.linkedCoachingProgramId || note.linkedCoachingProgramId === filter.linkedCoachingProgramId)
              && (!filter.status || note.status === filter.status)),
          }),
        }),
      }),
    }),
  };
  const results = await jarvisMemoryService.listNotes({ workspaceId: WORKSPACE_ID, category: "offers-programs", coachingProgramId: PROGRAM_ID, includeArchived: true }, Model);
  assert.equal(results.length, 2);
  assert.ok(results.every((note) => note.linkedCoachingProgramId === PROGRAM_ID));
  console.log("PASS testListNotesFiltersByLinkedCoachingProgramId");
}

(async () => {
  await testStoresStructuredAiAnalysisOnTheNote();
  await testLinksToAValidProgramInTheSameWorkspace();
  await testDropsAProgramIdFromAnotherWorkspaceInsteadOfThrowing();
  await testNeverInventsAiAnalysisWhenAnalysisFails();
  await testListNotesFiltersByLinkedCoachingProgramId();
  console.log("\nAll PDF-to-Internal-Summary linking tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
