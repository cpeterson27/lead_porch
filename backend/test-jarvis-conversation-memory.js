// Regression coverage for the new explicit-save conversation memory:
// jarvisMemoryService.recordConversation() used to be a permanent no-op
// stub ("conversation_history_is_stored_in_growth_operator") — nothing
// said to Jarvis, ever, became durable knowledge. This tests its real
// replacement: an explicit "remember that…" instruction becomes one
// reviewable, already-approved Knowledge Center note; anything else is
// correctly left unrecorded, matching the professional pattern (curated
// notes, never a raw transcript an assistant could free-associate from).
//
// Fully mocked — NO real database connection is made anywhere in this
// file, per this session's standing "no live providers, no production
// writes" constraint.
require("dotenv").config();
const assert = require("node:assert/strict");
const { recordConversation, retrieveCloudNotes } = require("./services/jarvisMemoryService");

function fakeNoteModel(store) {
  return {
    create: async (doc) => {
      const note = { _id: `note-${store.length + 1}`, ...doc };
      store.push(note);
      return note;
    },
  };
}

async function testRemembersAnExplicitInstructionAsAnApprovedNote() {
  const notes = [];
  const result = await recordConversation(
    { workspaceId: "workspace-1", userId: "user-1", userMessage: "remember that Ellie only wants multifamily leads, never single-family" },
    fakeNoteModel(notes),
  );
  assert.equal(result.recorded, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, "conversation_capture");
  assert.equal(notes[0].status, "approved");
  assert.equal(notes[0].category, "decisions");
  assert.ok(notes[0].content.includes("Ellie only wants multifamily leads"));
  console.log("PASS testRemembersAnExplicitInstructionAsAnApprovedNote");
}

async function testRecognizesSeveralNaturalPhrasings() {
  for (const phrase of ["Remember this: she prefers email over text", "please remember: budget is $500/mo max", "Jarvis, remember that the launch date moved to March"]) {
    const notes = [];
    // eslint-disable-next-line no-await-in-loop
    const result = await recordConversation({ workspaceId: "workspace-1", userId: "user-1", userMessage: phrase }, fakeNoteModel(notes));
    assert.equal(result.recorded, true, `expected to recognize: "${phrase}"`);
  }
  console.log("PASS testRecognizesSeveralNaturalPhrasings");
}

async function testDoesNotFireOnOrdinaryMessagesThatMerelyContainTheWordRemember() {
  const notes = [];
  const result = await recordConversation(
    { workspaceId: "workspace-1", userId: "user-1", userMessage: "do you remember what we talked about yesterday?" },
    fakeNoteModel(notes),
  );
  assert.equal(result.recorded, false);
  assert.equal(notes.length, 0);
  console.log("PASS testDoesNotFireOnOrdinaryMessagesThatMerelyContainTheWordRemember");
}

async function testRejectsAnEmptyOrTooShortInstructionWithoutCreatingAJunkNote() {
  const notes = [];
  const result = await recordConversation({ workspaceId: "workspace-1", userId: "user-1", userMessage: "remember that ok" }, fakeNoteModel(notes));
  assert.equal(result.recorded, false);
  assert.equal(notes.length, 0);
  console.log("PASS testRejectsAnEmptyOrTooShortInstructionWithoutCreatingAJunkNote");
}

async function testNeverRecordsWithoutAWorkspaceId() {
  const notes = [];
  const result = await recordConversation({ userMessage: "remember that this should never be saved without a workspace" }, fakeNoteModel(notes));
  assert.equal(result.recorded, false);
  assert.equal(notes.length, 0);
  console.log("PASS testNeverRecordsWithoutAWorkspaceId");
}

async function testTitleIsTruncatedForALongInstructionButFullTextIsKept() {
  const notes = [];
  const longInstruction = "remember that " + "a".repeat(200);
  const result = await recordConversation({ workspaceId: "workspace-1", userId: "user-1", userMessage: longInstruction }, fakeNoteModel(notes));
  assert.equal(result.recorded, true);
  assert.ok(result.title.length <= 80);
  assert.ok(notes[0].content.includes("a".repeat(200)), "the full instruction must still be kept in the note body even though the title is shortened");
  console.log("PASS testTitleIsTruncatedForALongInstructionButFullTextIsKept");
}

// Regression: a note saved via recordConversation() must actually be
// retrievable by Jarvis afterward. The retrieval filter was found to still
// list only the three original source values ("obsidian_bridge",
// "approved_memory", "pdf_upload") — a real bug that would have made every
// "remember that…" note permanently invisible to Jarvis despite the chat
// reply promising "I'll use it in future conversations and searches."
async function testAConversationCapturedNoteIsActuallyRetrievable() {
  const Model = {
    find: (filter) => ({
      select: () => ({
        lean: async () => [{
          path: "08 Decisions/x.md", title: "Ellie only wants multifamily leads", content: "Ellie only wants multifamily leads, never single-family",
          category: "decisions", source: "conversation_capture", approvedAt: new Date(), effectiveDate: null, reviewDate: null,
        }].filter((note) => filter.source.$in.includes(note.source)),
      }),
    }),
  };
  const result = await retrieveCloudNotes("multifamily leads", { workspaceId: "workspace-1" }, Model);
  assert.equal(result.available, true);
  assert.equal(result.citations.length, 1, "a conversation_capture note matching the query must come back from retrieval, not be silently filtered out by source");
  assert.equal(result.citations[0].source, "conversation_capture");
  assert.ok(result.context.includes("Ellie only wants multifamily leads"));
  console.log("PASS testAConversationCapturedNoteIsActuallyRetrievable");
}

(async () => {
  await testRemembersAnExplicitInstructionAsAnApprovedNote();
  await testRecognizesSeveralNaturalPhrasings();
  await testDoesNotFireOnOrdinaryMessagesThatMerelyContainTheWordRemember();
  await testRejectsAnEmptyOrTooShortInstructionWithoutCreatingAJunkNote();
  await testNeverRecordsWithoutAWorkspaceId();
  await testAConversationCapturedNoteIsActuallyRetrievable();
  await testTitleIsTruncatedForALongInstructionButFullTextIsKept();
  console.log("\nAll Jarvis conversation-memory tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
