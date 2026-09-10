/**
 * Owner-only multi-PDF upload for the Knowledge Center: extracts text from
 * each PDF, uses the app's existing (OpenAI-backed) agent system to produce
 * a structured program summary, ideal-customer profile, qualification
 * criteria, and suggested discovery-monitor searches, and creates ONE
 * DRAFT JarvisMemoryNote per PDF — never auto-approved, exactly like every
 * other Knowledge Center draft. An approved note syncs to Agent Search
 * automatically through the SAME hook every other approval already uses
 * (jarvisMemoryService.approveNote() -> discoveryEngineSyncService) — no
 * new sync path was added here.
 *
 * Suggested monitors are created as real ResearchMonitor documents so they
 * are genuinely editable through the existing Discovery > Intent Monitoring
 * UI, but ALWAYS with enabled: false — both the automatic scheduler
 * (services/researchMonitorService.js's due-monitor query) and the manual
 * "Run now" action require enabled: true, so a suggested monitor cannot run
 * in any way until a human explicitly turns it on.
 *
 * If AI analysis fails for any reason, the draft note is still created
 * (with the raw extracted text and an honest note that analysis failed)
 * rather than silently discarding the upload — never invents the missing
 * analysis.
 */
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const ResearchMonitor = require("../models/ResearchMonitor");
const agentExecutionService = require("./agentExecutionService");
const auditService = require("./auditService");
const { CATEGORY_FOLDERS, isSafeNotePath } = require("./jarvisMemoryService");

const MAX_EXTRACTED_TEXT = 100000;
const MAX_AI_INPUT_TEXT = 18000;
const MAX_SUGGESTED_MONITORS = 5;
const MONITOR_TYPES = ["buyer_intent", "community_partner", "investor_profile"];

const clean = (value, max) => String(value || "").replaceAll("\u0000", "").trim().slice(0, max);
const slug = (value) => clean(value, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "document";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    programSummary: { type: "string" },
    idealCustomerProfile: { type: "string" },
    qualificationCriteria: { type: "array", items: { type: "string" } },
    suggestedMonitors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          monitorType: { type: "string", enum: MONITOR_TYPES },
          query: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: ["name", "monitorType", "query", "keywords", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["programSummary", "idealCustomerProfile", "qualificationCriteria", "suggestedMonitors"],
  additionalProperties: false,
};

async function analyzeWithAgent({ workspaceId, userId, auth, originalFilename, extractedText, correlationId }, dependencies = {}) {
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  try {
    const result = await runAgent({
      workspaceId,
      userId,
      auth,
      agent: "research",
      task: "analyze_program_pdf",
      correlationId,
      operationalContext: `You are analyzing a real coaching-program document the business owner just uploaded, extracted from a PDF named "${originalFilename}". Base every claim strictly on the text below — never invent prices, outcomes, dates, or claims not present in it. If the text does not support a field, say so plainly instead of guessing.\n\nExtracted document text:\n${extractedText.slice(0, MAX_AI_INPUT_TEXT)}`,
      input: { originalFilename },
      options: { responseSchema: RESPONSE_SCHEMA, schemaName: "pdf_program_analysis" },
    });
    return { ok: true, analysis: result.output };
  } catch (error) {
    return { ok: false, reason: clean(error.message || "AI analysis failed", 500) };
  }
}

function composeContent({ originalFilename, extractedText, analysisResult }) {
  const sections = [];
  if (analysisResult.ok) {
    const a = analysisResult.analysis;
    sections.push(`## AI-Generated Program Summary\n\n${a.programSummary}`);
    sections.push(`## Ideal Customer Profile\n\n${a.idealCustomerProfile}`);
    sections.push(`## Qualification Criteria\n\n${(a.qualificationCriteria || []).map((row) => `- ${row}`).join("\n")}`);
    sections.push(`## Suggested Discovery-Monitor Searches\n\nCreated as DISABLED drafts below — review, edit, and enable each individually under Discovery > Intent Monitoring. None run automatically.\n\n${(a.suggestedMonitors || []).map((row) => `- **${row.name}** (${row.monitorType}): "${row.query}" — ${row.rationale}`).join("\n")}`);
  } else {
    sections.push(`## AI-Generated Analysis Unavailable\n\n${analysisResult.reason}. Review the extracted text below manually; nothing was invented in its place.`);
  }
  sections.push(`## Extracted Source Text (from ${originalFilename})\n\n${extractedText.slice(0, MAX_EXTRACTED_TEXT)}`);
  return sections.join("\n\n");
}

/**
 * Extracts, analyzes, and stages ONE PDF as a draft Knowledge Center note
 * (+ up to MAX_SUGGESTED_MONITORS disabled draft monitors). Never approves
 * the note and never enables a monitor.
 */
async function ingestPdf({ workspaceId, userId, auth, category, originalFilename, buffer, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const MonitorModel = dependencies.ResearchMonitor || ResearchMonitor;
  if (!CATEGORY_FOLDERS[category]) { const error = new Error("Select an approved knowledge category"); error.code = "MEMORY_CATEGORY_INVALID"; throw error; }
  if (!Buffer.isBuffer(buffer) || !buffer.length) { const error = new Error(`"${originalFilename}" is empty or unreadable`); error.code = "PDF_EMPTY_FILE"; throw error; }

  let extractedText;
  try {
    const parse = dependencies.pdfParse || pdfParse;
    const parsed = await parse(buffer);
    extractedText = String(parsed?.text || "").trim();
  } catch (error) {
    const wrapped = new Error(`Could not extract text from "${originalFilename}": ${error.message}`);
    wrapped.code = "PDF_EXTRACTION_FAILED";
    throw wrapped;
  }
  if (!extractedText) { const error = new Error(`"${originalFilename}" has no extractable text — it may be a scanned image with no text layer.`); error.code = "PDF_EMPTY_TEXT"; throw error; }
  extractedText = extractedText.slice(0, MAX_EXTRACTED_TEXT);

  const analysisResult = await analyzeWithAgent({ workspaceId, userId, auth, originalFilename, extractedText, correlationId }, dependencies);
  const title = clean(String(originalFilename || "").replace(/\.pdf$/i, ""), 200) || "Uploaded PDF";
  const content = composeContent({ originalFilename, extractedText, analysisResult });
  const path = `${CATEGORY_FOLDERS[category]}/PDF Uploads/${slug(title)}-${crypto.randomBytes(4).toString("hex")}.md`;
  if (!isSafeNotePath(path)) { const error = new Error("Generated note path was rejected as unsafe"); error.code = "PDF_PATH_UNSAFE"; throw error; }
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");

  const note = await Model.create({
    workspaceId, source: "pdf_upload", category, path, title, content, contentHash,
    originalFilename: clean(originalFilename, 300), createdByUserId: userId,
    status: "draft", version: 1, versions: [],
  });

  const monitorDrafts = [];
  if (analysisResult.ok) {
    for (const suggestion of (analysisResult.analysis.suggestedMonitors || []).slice(0, MAX_SUGGESTED_MONITORS)) {
      if (!MONITOR_TYPES.includes(suggestion.monitorType)) continue;
      const query = clean(suggestion.query, 1200);
      if (!query) continue;
      // eslint-disable-next-line no-await-in-loop
      const monitor = await MonitorModel.create({
        workspaceId, userId,
        name: clean(suggestion.name, 160) || `Suggested from ${title}`,
        monitorType: suggestion.monitorType,
        query,
        keywords: (suggestion.keywords || []).slice(0, 20).map((row) => clean(row, 80)).filter(Boolean),
        enabled: false,
        sourceNoteId: note._id,
      });
      monitorDrafts.push(monitor);
    }
  }

  await auditService.record({
    workspaceId, actorUserId: userId, action: "knowledge.note.created", targetType: "JarvisMemoryNote", targetId: note._id,
    after: { source: "pdf_upload", originalFilename: note.originalFilename, aiAnalysisSucceeded: analysisResult.ok, monitorDraftsCreated: monitorDrafts.length },
    success: true,
  });

  return { note, monitorDrafts, aiAnalysisSucceeded: analysisResult.ok, aiAnalysisReason: analysisResult.ok ? "" : analysisResult.reason };
}

module.exports = { ingestPdf, RESPONSE_SCHEMA, MAX_SUGGESTED_MONITORS };
