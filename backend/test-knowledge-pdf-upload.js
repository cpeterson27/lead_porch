// Targeted regression coverage for the owner-only multi-PDF Knowledge
// Center upload: one draft note per PDF (never auto-approved), AI-derived
// monitor suggestions created only as DISABLED drafts (never auto-enabled),
// an honest fallback when AI analysis fails (never invents missing
// analysis), original filename preserved, workspace scoping, and the
// route's owner-only gate. PDF parsing and the AI agent call are both
// mocked — no real PDF is parsed and no real AI call is made.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { ingestPdf } = require("./services/pdfKnowledgeIngestionService");
const jarvisRouter = require("./routes/jarvis");
const JarvisMemoryNote = require("./models/JarvisMemoryNote");
const ResearchMonitor = require("./models/ResearchMonitor");
const AuditLog = require("./models/AuditLog");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}
async function runRoute(path, method, req) {
  const res = fakeRes();
  for (const layer of jarvisRouter.stack) {
    const handlers = layer.route ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null) : [layer];
    if (!handlers) continue;
    let stopped = false;
    for (const routeLayer of handlers) {
      let calledNext = false, nextError = null;
      // eslint-disable-next-line no-await-in-loop
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

const fakePdfParse = async () => ({ text: "Program overview: a 6-week multifamily investing course for owners with 5+ years experience. Price: $2,997. Includes weekly live calls and a private community." });

const fakeAnalysis = {
  programSummary: "A 6-week multifamily investing course for experienced owners, priced at $2,997, with weekly live calls and a private community.",
  idealCustomerProfile: "Real estate owners with 5+ years of experience seeking to scale into multifamily.",
  qualificationCriteria: ["5+ years of real estate ownership experience", "Active interest in multifamily acquisition"],
  suggestedMonitors: [
    { name: "Multifamily-curious experienced owners", monitorType: "buyer_intent", query: "experienced real estate owner exploring multifamily", keywords: ["multifamily", "scale", "5 years"], rationale: "Matches the program's stated audience directly." },
  ],
};

async function testSuccessfulIngestionCreatesDraftNoteAndDisabledMonitor(models) {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const auth = { workspaceId: String(workspaceId) };
  const runAgent = async () => ({ output: fakeAnalysis });

  const result = await ingestPdf(
    { workspaceId, userId, auth, category: "offers-programs", originalFilename: "Ellie 6 Week Program.pdf", buffer: Buffer.from("fake pdf bytes") },
    { pdfParse: fakePdfParse, runAgent },
  );

  assert.equal(result.aiAnalysisSucceeded, true);
  const note = await models.JarvisMemoryNote.findById(result.note._id).lean();
  assert.equal(note.status, "draft", "a PDF-derived note must never be auto-approved");
  assert.equal(note.source, "pdf_upload");
  assert.equal(note.originalFilename, "Ellie 6 Week Program.pdf");
  assert.ok(note.fileHash, "the exact PDF bytes must be fingerprinted before analysis so duplicate uploads can be blocked");
  assert.equal(String(note.workspaceId), String(workspaceId));
  assert.ok(note.content.includes("AI-Generated Program Summary"));
  assert.ok(note.content.includes(fakeAnalysis.programSummary));
  assert.ok(note.content.includes("Program overview: a 6-week multifamily"), "the raw extracted text must be preserved alongside the AI analysis, not replaced by it");

  assert.equal(result.monitorDrafts.length, 1);
  const monitor = await models.ResearchMonitor.findById(result.monitorDrafts[0]._id).lean();
  assert.equal(monitor.enabled, false, "a suggested monitor must never be created enabled");
  assert.equal(String(monitor.sourceNoteId), String(note._id));
  assert.equal(String(monitor.workspaceId), String(workspaceId));
  assert.equal(monitor.monitorType, "buyer_intent");

  const audits = await models.AuditLog.find({ workspaceId, action: "knowledge.note.created", targetId: note._id }).lean();
  assert.equal(audits.length, 1);

  await models.JarvisMemoryNote.deleteMany({ workspaceId });
  await models.ResearchMonitor.deleteMany({ workspaceId });
  await models.AuditLog.deleteMany({ workspaceId });
}

async function testDuplicatePdfIsBlockedBeforeAiSpend(models) {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let aiCalls = 0;
  const dependencies = { pdfParse: fakePdfParse, runAgent: async () => { aiCalls += 1; return { output: fakeAnalysis }; } };
  try {
    await ingestPdf({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, category: "offers-programs", originalFilename: "Program.pdf", buffer: Buffer.from("same-pdf") }, dependencies);
    await assert.rejects(
      () => ingestPdf({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, category: "offers-programs", originalFilename: "Renamed copy.pdf", buffer: Buffer.from("same-pdf") }, dependencies),
      (error) => error.code === "PDF_DUPLICATE" && Boolean(error.existingNoteId),
    );
    assert.equal(aiCalls, 1, "the duplicate must be rejected before a second AI call");
  } finally {
    await models.JarvisMemoryNote.deleteMany({ workspaceId });
    await models.ResearchMonitor.deleteMany({ workspaceId });
    await models.AuditLog.deleteMany({ workspaceId });
  }
}

async function testAiFailureStillCreatesDraftWithHonestFallbackAndNoMonitors(models) {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const auth = { workspaceId: String(workspaceId) };
  const runAgent = async () => { throw new Error("OpenAI credits are empty"); };

  const result = await ingestPdf(
    { workspaceId, userId, auth, category: "offers-programs", originalFilename: "Program.pdf", buffer: Buffer.from("fake pdf bytes") },
    { pdfParse: fakePdfParse, runAgent },
  );

  assert.equal(result.aiAnalysisSucceeded, false);
  assert.equal(result.monitorDrafts.length, 0, "no monitor may be invented when AI analysis fails");
  const note = await models.JarvisMemoryNote.findById(result.note._id).lean();
  assert.equal(note.status, "draft");
  assert.ok(note.content.includes("AI-Generated Analysis Unavailable"));
  assert.ok(note.content.includes("OpenAI credits are empty"), "the real reason must be shown, not a generic message");
  assert.ok(note.content.includes("Program overview: a 6-week multifamily"), "raw extracted text must still be saved even when AI analysis fails");
  assert.ok(!note.content.includes("undefined"), "must never fabricate placeholder analysis content");

  const monitorCount = await models.ResearchMonitor.countDocuments({ workspaceId });
  assert.equal(monitorCount, 0);

  await models.JarvisMemoryNote.deleteMany({ workspaceId });
  await models.AuditLog.deleteMany({ workspaceId });
}

async function testEmptyPdfTextIsRejectedNotSilentlySaved() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const auth = { workspaceId: String(workspaceId) };
  await assert.rejects(
    () => ingestPdf(
      { workspaceId, userId, auth, category: "offers-programs", originalFilename: "Scanned.pdf", buffer: Buffer.from("fake") },
      { pdfParse: async () => ({ text: "   " }), runAgent: async () => ({ output: fakeAnalysis }) },
    ),
    (error) => error.code === "PDF_EMPTY_TEXT",
  );
}

async function testRouteRejectsNonOwnerBeforeTouchingAnyFile() {
  const admin = { workspaceId: String(new mongoose.Types.ObjectId()), roles: ["admin"], user: { _id: "u1" } };
  const res = await runRoute("/memory/notes/upload-pdfs", "post", { auth: admin, files: [], body: {} });
  assert.equal(res.statusCode, 403, "this upload route is owner-only — admin must be rejected, unlike the other Knowledge Center routes");
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const models = { JarvisMemoryNote, ResearchMonitor, AuditLog };
  try {
    await testSuccessfulIngestionCreatesDraftNoteAndDisabledMonitor(models);
    await testDuplicatePdfIsBlockedBeforeAiSpend(models);
    await testAiFailureStillCreatesDraftWithHonestFallbackAndNoMonitors(models);
    await testEmptyPdfTextIsRejectedNotSilentlySaved();
    await testRouteRejectsNonOwnerBeforeTouchingAnyFile();
    console.log("Knowledge Center PDF upload: draft-only notes (never auto-approved), disabled-only suggested monitors (never auto-enabled), honest AI-failure fallback with preserved raw text, empty-text rejection, filename/workspace preservation, and the owner-only route gate all passed.");
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
