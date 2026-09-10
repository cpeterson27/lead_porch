/**
 * Jarvis Assistant Routes
 * AI control layer for Growth Operator systems
 */

const express = require("express");
const OpenAI = require("openai");
const Contact = require("../models/Contact");
const GrowthActionApproval = require("../models/GrowthActionApproval");
const PeopleResearchPreview = require("../models/PeopleResearchPreview");
const ContactFieldUpdateAudit = require("../models/ContactFieldUpdateAudit");
const jarvisService = require("../services/jarvisService");
const llmService = require("../services/llmService");
const jarvisMemoryService = require("../services/jarvisMemoryService");
const jarvisConversationService = require("../services/jarvisConversationService");
const jarvisMemoryCaptureService = require("../services/jarvisMemoryCaptureService");
const jarvisVaultSyncAuthService = require("../services/jarvisVaultSyncAuthService");
const vaultCredentialService = require("../services/vaultCredentialService");
const jarvisProfileService = require("../services/jarvisProfileService");
const developmentRequestService = require("../services/developmentRequestService");
const { compileMarketQuestion } = require("../services/marketResearchService");
const { ingestContacts } = require("../services/contactIngestionService");
const { isJarvisWebResearchEnabled, normalizePublicPeople, researchAndStagePublicPeople } = require("../services/publicPeopleResearchService");
const { applyContactFieldUpdate, availableContactFields, buildContactFieldUpdatePreview } = require("../services/contactFieldUpdateService");
const { collectMonitorSignals } = require("../services/intentSourceService");
const { requireCapability, requireRole } = require("../middleware/auth");
const multer = require("multer");
const { ingestPdf } = require("../services/pdfKnowledgeIngestionService");

const router = express.Router();
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

// Public only to the vault bridge: the bearer credential itself resolves the
// workspace. A workspaceId supplied in the JSON body is never trusted.
router.post("/memory/sync", async (req, res) => {
  const bearer = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  // Legacy env-based credentials keep working; a database-backed, owner-created
  // credential (see /memory/vault-credentials below) is tried second.
  let bridge = jarvisVaultSyncAuthService.resolveWorkspace({ authorization: req.get("authorization") });
  if (!bridge) bridge = await vaultCredentialService.resolveWorkspaceFromSecret(bearer).catch(() => null);
  if (!bridge) return res.status(401).json({ success: false, error: "Unauthorized vault bridge" });
  try {
    const result = await jarvisMemoryService.syncCloudNotes(bridge.workspaceId, req.body?.notes);
    if (bridge.credentialId) await vaultCredentialService.recordSyncResult({ workspaceId: bridge.workspaceId, credentialId: bridge.credentialId, success: true, message: "Sync completed", stats: result });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (bridge.credentialId) await vaultCredentialService.recordSyncResult({ workspaceId: bridge.workspaceId, credentialId: bridge.credentialId, success: false, message: error.message || "Vault sync failed" });
    return res.status(error.statusCode || 500).json({ success: false, error: error.statusCode ? error.message : "Vault sync failed" });
  }
});

/**
 * Owner-facing, self-service Obsidian vault-bridge credentials. Clients
 * never need to touch server environment variables — create/revoke a
 * credential here, then paste the shown secret into the vault bridge's own
 * .env once. The plaintext secret is only ever shown at creation time.
 */
router.get("/memory/vault-credentials", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await vaultCredentialService.listCredentials({ workspaceId: req.auth.workspaceId }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Vault credentials could not be loaded" });
  }
});
router.post("/memory/vault-credentials", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await vaultCredentialService.createCredential({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, label: req.body?.label }) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Vault credential could not be created", code: error.code });
  }
});
router.delete("/memory/vault-credentials/:id", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await vaultCredentialService.revokeCredential({ workspaceId: req.auth.workspaceId, credentialId: req.params.id, userId: req.auth.user?._id }) });
  } catch (error) {
    return res.status(error.code === "VAULT_CREDENTIAL_NOT_FOUND" ? 404 : 500).json({ success: false, error: error.message || "Vault credential could not be revoked" });
  }
});

router.use(requireCapability("jarvis.manage"));
const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]);

function requireJarvisOperator(req, res) {
  if (["owner", "admin"].includes(req.auth?.role)) return true;
  res.status(403).json({ success: false, error: "A Growth Operator owner or admin must approve CRM imports." });
  return false;
}

function previewPeopleAsImportRows(preview, selectedIndexes) {
  const people = preview.people || [];
  const indexes = Array.isArray(selectedIndexes)
    ? [...new Set(selectedIndexes.map(Number))].filter((index) => Number.isInteger(index) && index >= 0 && index < people.length)
    : [];
  if (!indexes.length) throw new Error("Select at least one person to import.");
  return normalizePublicPeople(indexes.map((index) => people[index]).map((person) => ({
    firstName: person.firstName,
    lastName: person.lastName,
    title: person.title,
    company: person.company,
    companyWebsite: person.companyWebsite,
    email: person.email,
    evidenceUrl: person.evidenceUrl,
    evidenceSummary: person.evidenceSummary,
  })));
}

async function fallbackPublicAccountResearch(message) {
  const username = String(message).match(/(?:reddit\.com\/user\/|\bu\/)([A-Za-z0-9_-]+)/i)?.[1];
  if (!username) return null;
  const collected = await collectMonitorSignals({
    query: username,
    keywords: [`"${username}"`],
    locations: [],
    sources: [...(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID ? ["google_web"] : []), "bing_web", "bluesky", "hacker_news", "stack_exchange", "reddit_rss", "duckduckgo"],
    maxResultsPerSource: 10,
  });
  const mentions = collected.groups.flatMap((group) => group.signals || [])
    .filter((item) => item?.sourceUrl)
    .filter((item, index, rows) => rows.findIndex((other) => other.sourceUrl === item.sourceUrl) === index)
    .slice(0, 20)
    .map((item) => ({ source: item.source, title: item.title || item.sourceUrl, excerpt: item.excerpt || "", url: item.sourceUrl, authorName: item.authorName || "" }));
  return { username, mentions, sourceErrors: collected.errors || [] };
}

/**
 * POST /api/jarvis/chat
 * Process natural language query and return insights
 * Request: { message }
 * Response: { answer, data, actionsAvailable }
 */
router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        error: "Message is required and must be a string",
      });
    }

    const leadResearchRequest = /\b(find|discover|research|search for|build)\b/i.test(message)
      && /\b(leads?|prospects?|business(?:es)?|compan(?:y|ies)|owners?|founders?|decision[- ]makers?|principals?|presidents?|ceos?|attendees?|contacts?)\b/i.test(message);
    if (leadResearchRequest) {
      const plan = await compileMarketQuestion(message);
      if (isJarvisWebResearchEnabled()) {
        try {
          const requestedCount = [...message.matchAll(/\b(\d{1,2})\b/g)]
            .map((match) => Number(match[1]))
            .find((value) => value >= 1 && value <= 50) || 20;
          const result = await researchAndStagePublicPeople({
            question: message,
            maxResults: requestedCount,
            workspaceId: req.auth.workspaceId,
            userId: req.auth.user?._id || null,
          });
          const summary = result.savedPreview.summary;
          const answer = `I searched public sources and saved a staged preview of ${summary.total} evidence-backed decision-maker${summary.total === 1 ? "" : "s"}. ${summary.publishedEmails} visibly published email${summary.publishedEmails === 1 ? " was" : "s were"} found; those emails remain unverified. ${summary.existingContacts} existing CRM match${summary.existingContacts === 1 ? " was" : "es were"} detected. Nothing was imported and no outreach was sent. Open Jarvis Research Previews to review every person and source.`;
          const memory = await jarvisMemoryService.recordConversation({ userMessage: message, assistantMessage: answer }).catch(() => ({ recorded: false }));
          return res.json({
            success: true,
            data: {
              answer,
              data: {
                researchQuestion: message,
                previewId: result.savedPreview._id,
                preview: summary,
                people: result.savedPreview.people,
                model: result.model,
              },
              actionsAvailable: [],
              activity: [
                { status: "complete", label: "Searched public web sources" },
                { status: "complete", label: `Validated evidence for ${summary.total} people` },
                { status: "complete", label: "Saved a staged review preview without importing contacts" },
              ],
              memory,
              memorySources: [],
            },
          });
        } catch (error) {
          const fallback = await fallbackPublicAccountResearch(message).catch(() => null);
          if (fallback) {
            const answer = fallback.mentions.length
              ? `OpenAI identity research was unavailable, so I completed a no-credit public-source fallback search for u/${fallback.username}. I found ${fallback.mentions.length} public mention${fallback.mentions.length === 1 ? "" : "s"} to review below. These links may provide context or another public profile, but none is treated as the same real person without direct supporting evidence. No contact was added and no outreach was sent.`
              : `I completed a no-credit public-source fallback search for u/${fallback.username}, but found no additional indexed account or business evidence. I cannot safely connect this username to a real person. The available contact option is the original Reddit account or post.`;
            const memory = await jarvisMemoryService.recordConversation({ userMessage: message, assistantMessage: answer }).catch(() => ({ recorded: false }));
            return res.json({ success: true, data: { answer, data: { researchQuestion: message, fallbackResearch: true, publicAccount: `u/${fallback.username}`, mentions: fallback.mentions, sourceErrors: fallback.sourceErrors }, actionsAvailable: [], activity: [{ status: "warning", label: "OpenAI research unavailable—used public-source fallback" }, { status: "complete", label: `Checked public web and social indexes for u/${fallback.username}` }, { status: "complete", label: `Returned ${fallback.mentions.length} evidence link${fallback.mentions.length === 1 ? "" : "s"} without inferring identity` }], memory, memorySources: [] } });
          }
          return res.status(503).json({
            success: false,
            error: error.message || "Jarvis could not complete public-web lead research.",
            data: { researchQuestion: message, plan },
          });
        }
      }
      const fallback = await fallbackPublicAccountResearch(message).catch(() => null);
      if (fallback) {
        const answer = fallback.mentions.length
          ? `OpenAI research is not available, so I used Growth Operator's no-credit public-source search for u/${fallback.username}. I found ${fallback.mentions.length} public mention${fallback.mentions.length === 1 ? "" : "s"} below. Review the links for direct identity evidence; I did not assume that matching usernames belong to the same person.`
          : `I checked no-credit public web and social indexes for u/${fallback.username}, but found no additional supported identity evidence. Use the original Reddit post or account if you choose to contact them.`;
        const memory = await jarvisMemoryService.recordConversation({ userMessage: message, assistantMessage: answer }).catch(() => ({ recorded: false }));
        return res.json({ success: true, data: { answer, data: { researchQuestion: message, fallbackResearch: true, publicAccount: `u/${fallback.username}`, mentions: fallback.mentions, sourceErrors: fallback.sourceErrors }, actionsAvailable: [], activity: [{ status: "complete", label: "Ran no-credit public web and social-index search" }, { status: "complete", label: `Returned ${fallback.mentions.length} reviewable evidence link${fallback.mentions.length === 1 ? "" : "s"}` }], memory, memorySources: [] } });
      }
      return res.json({
        success: true,
        data: {
          answer: `I built a lead-research plan for “${plan.name},” but live Jarvis web research is not enabled yet. Add OpenAI API billing and set JARVIS_OPENAI_ENABLED=true in the Render backend. I will not add contacts or send outreach without your approval.`,
          data: { researchQuestion: message, plan },
          actionsAvailable: ["open_lead_discovery"],
          activity: [
            { status: "complete", label: "Converted your request into a reviewable lead-search plan" },
            { status: "warning", label: "Live web research is waiting for OpenAI API billing and enablement" },
          ],
          memorySources: [],
        },
      });
    }

    if (developmentRequestService.isDevelopmentRequest(message)) {
      const request = await developmentRequestService.createFromJarvis(message);
      return res.json({
        success: true,
        data: {
          answer: `I drafted development request "${request.title}" for developer review. I cannot change code or deploy it myself. The request must be approved in Development Requests before it can be handed to Codex.`,
          data: { developmentRequestId: request._id, status: request.status },
          actionsAvailable: ["view_development_requests"],
          activity: [
            { status: "complete", label: "Captured the requested software change" },
            { status: "complete", label: "Placed it in the developer approval queue" },
          ],
          memorySources: [],
        },
      });
    }

    const result = await jarvisService.processQuery(message, { workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, conversationId: req.body?.conversationId || null, correlationId: req.get("x-request-id") || "" });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("POST /jarvis/chat error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to process query",
    });
  }
});

router.post("/research-previews/:previewId/prepare-import", async (req, res) => {
  if (!requireJarvisOperator(req, res)) return;
  try {
    const preview = await PeopleResearchPreview.findOne({ _id: req.params.previewId, workspaceId: req.auth.workspaceId });
    if (!preview) return res.status(404).json({ success: false, error: "Research preview not found." });
    if (preview.status === "imported") return res.status(409).json({ success: false, error: "This research preview has already been imported." });
    const selectedIndexes = Array.isArray(req.body?.selectedIndexes)
      ? [...new Set(req.body.selectedIndexes.map(Number))].filter((index) => Number.isInteger(index) && index >= 0 && index < preview.people.length)
      : [];
    const people = previewPeopleAsImportRows(preview, selectedIndexes);
    const phrase = `IMPORT ${people.length} PUBLIC-WEB PROSPECTS`;
    const selectedSummary = {
      total: people.length,
      newContacts: selectedIndexes.filter((index) => preview.people[index]?.reviewStatus === "new").length,
      existingContacts: selectedIndexes.filter((index) => preview.people[index]?.reviewStatus === "existing").length,
      duplicatesInFile: selectedIndexes.filter((index) => preview.people[index]?.reviewStatus === "file_duplicate").length,
      publishedEmails: people.filter((person) => Boolean(person.Email)).length,
    };
    const approval = await GrowthActionApproval.create({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      action: "import_public_people",
      payload: { people, previewId: preview._id },
      summary: selectedSummary,
      confirmationPhrase: phrase,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    preview.status = "approval_pending";
    preview.approvalId = approval._id;
    await preview.save();
    return res.json({
      success: true,
      data: {
        approvalId: approval._id,
        confirmationPhrase: phrase,
        expiresAt: approval.expiresAt,
        preview: selectedSummary,
        warning: "This adds the staged people as needs-review CRM prospects. It does not permit or send outreach.",
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to prepare this import." });
  }
});

router.post("/research-previews/:previewId/confirm-import", async (req, res) => {
  if (!requireJarvisOperator(req, res)) return;
  try {
    const approval = await GrowthActionApproval.findOne({
      _id: req.body?.approvalId,
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      action: "import_public_people",
      usedAt: null,
      expiresAt: { $gt: new Date() },
      "payload.previewId": req.params.previewId,
    });
    if (!approval) return res.status(400).json({ success: false, error: "This approval is missing, expired, already used, or belongs to another workspace." });
    if (String(req.body?.confirmation || "") !== approval.confirmationPhrase) {
      return res.status(400).json({ success: false, error: `Confirmation must exactly match: ${approval.confirmationPhrase}` });
    }
    const batchId = `jarvis-public-web-${approval._id}`;
    const result = await ingestContacts({
      contacts: approval.payload.people,
      source: "public_web_research",
      marketingPermission: false,
      importBatchId: batchId,
      importFileName: "Jarvis public-web people research",
    });
    await Contact.updateMany(
      { lastImportBatchId: batchId },
      { $set: { status: "prospect" }, $addToSet: { tags: { $each: ["public-web-research", "needs-review"] } } },
    );
    approval.usedAt = new Date();
    await approval.save();
    await PeopleResearchPreview.updateOne(
      { _id: req.params.previewId, workspaceId: req.auth.workspaceId },
      { $set: { status: "imported", importedAt: new Date(), importResult: result } },
    );
    return res.json({
      success: true,
      data: {
        ...result,
        previewId: req.params.previewId,
        marketingPermission: false,
        nextStep: "Review and qualify these prospects before verifying emails or approving outreach.",
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to import this research preview." });
  }
});

router.get("/contact-field-updates/fields", async (_req, res) => {
  try {
    return res.json({ success: true, data: await availableContactFields() });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to load editable CRM fields." });
  }
});

router.post("/contact-field-updates/prepare", async (req, res) => {
  if (!requireJarvisOperator(req, res)) return;
  try {
    const preview = await buildContactFieldUpdatePreview({
      contactIds: req.body?.contactIds,
      fieldKey: req.body?.fieldKey,
      value: req.body?.value,
    });
    if (!preview.changedCount) return res.status(400).json({ success: false, error: "The selected contacts already have that value." });
    const phrase = `UPDATE ${preview.changedCount} CONTACT${preview.changedCount === 1 ? "" : "S"}: ${preview.field.label.toUpperCase()}`;
    const approval = await GrowthActionApproval.create({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      action: "update_contact_field",
      payload: {
        fieldKey: preview.field.key,
        value: preview.value,
        changes: preview.changes.filter((item) => item.changed).map(({ contactId, before }) => ({ contactId, before })),
      },
      summary: {
        fieldKey: preview.field.key,
        fieldLabel: preview.field.label,
        selectedCount: preview.selectedCount,
        changedCount: preview.changedCount,
        unchangedCount: preview.unchangedCount,
        missingCount: preview.missingCount,
        displayChanges: preview.displayChanges,
      },
      confirmationPhrase: phrase,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    return res.json({
      success: true,
      data: {
        approvalId: approval._id,
        confirmationPhrase: phrase,
        expiresAt: approval.expiresAt,
        preview: approval.summary,
        warning: "Only the displayed field will change. Records changed after this preview will be skipped as conflicts.",
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to prepare this CRM update." });
  }
});

router.post("/contact-field-updates/confirm", async (req, res) => {
  if (!requireJarvisOperator(req, res)) return;
  try {
    const approval = await GrowthActionApproval.findOne({
      _id: req.body?.approvalId,
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      action: "update_contact_field",
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!approval) return res.status(400).json({ success: false, error: "This approval is missing, expired, already used, or belongs to another workspace." });
    if (String(req.body?.confirmation || "") !== approval.confirmationPhrase) {
      return res.status(400).json({ success: false, error: `Confirmation must exactly match: ${approval.confirmationPhrase}` });
    }
    const result = await applyContactFieldUpdate(approval.payload);
    if (result.changes.length) {
      await ContactFieldUpdateAudit.insertMany(result.changes.map((change) => ({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.user._id,
        approvalId: approval._id,
        source: "jarvis",
        ...change,
      })));
    }
    approval.usedAt = new Date();
    await approval.save();
    return res.json({
      success: true,
      data: {
        updated: result.updated,
        unchanged: result.unchanged,
        conflicts: result.conflicts,
        missing: result.missing,
        field: { key: result.field.key, label: result.field.label },
        auditRecorded: result.changes.length,
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to apply this CRM update." });
  }
});

router.post("/voice/speech", async (req, res) => {
  try {
    if (!isJarvisWebResearchEnabled()) return res.status(503).json({ success: false, error: "OpenAI voice is not enabled yet." });
    const input = String(req.body?.text || "").trim().slice(0, 4000);
    const voice = OPENAI_VOICES.has(req.body?.voice) ? req.body.voice : "marin";
    if (!input) return res.status(400).json({ success: false, error: "Text is required for voice playback." });
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
    const speech = await client.audio.speech.create({
      model: process.env.JARVIS_TTS_MODEL || "gpt-4o-mini-tts",
      voice,
      input,
      instructions: "Speak as a polished, warm, confident business assistant. Use natural pacing and clear pronunciation.",
      response_format: "mp3",
    });
    const audio = Buffer.from(await speech.arrayBuffer());
    res.set({ "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
    return res.send(audio);
  } catch (error) {
    return res.status(502).json({ success: false, error: error.message || "Jarvis could not generate voice audio." });
  }
});

// Configuration-only status. This intentionally exposes no vault path or credentials.
router.get("/status", async (req, res) => {
  try {
    const memory = await jarvisMemoryService.getStatus(req.auth.workspaceId);
    res.json({
      success: true,
      data: {
        openai: llmService.getStatus(),
        obsidian: memory,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to retrieve Jarvis configuration status" });
  }
});

router.get("/profile", async (req, res) => {
  try {
    res.json({ success: true, data: await jarvisProfileService.getProfile() });
  } catch {
    res.status(500).json({ success: false, error: "Failed to retrieve Jarvis profile" });
  }
});

router.put("/profile", async (req, res) => {
  try {
    res.json({ success: true, data: await jarvisProfileService.updateProfile(req.body) });
  } catch (error) {
    res.status(400).json({ success: false, error: "Jarvis profile settings are invalid" });
  }
});

router.get("/conversations", async (req, res) => res.json({ success: true, data: await jarvisConversationService.list({ workspaceId: req.auth.workspaceId, userId: req.auth.userId }) }));
router.post("/conversations", async (req, res) => res.status(201).json({ success: true, data: await jarvisConversationService.create({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, title: req.body?.title }) }));
router.get("/conversations/:id", async (req, res) => {
  const conversation = await jarvisConversationService.get({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, conversationId: req.params.id });
  return conversation ? res.json({ success: true, data: conversation }) : res.status(404).json({ error: "Jarvis conversation not found" });
});
router.patch("/conversations/:id/archive", async (req, res) => {
  const conversation = await jarvisConversationService.archive({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, conversationId: req.params.id });
  return conversation ? res.json({ success: true, data: conversation }) : res.status(404).json({ error: "Jarvis conversation not found" });
});
router.post("/memory/prepare", requireRole("owner", "admin"), async (req, res) => {
  try { return res.status(201).json({ success: true, data: await jarvisMemoryCaptureService.prepare({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, title: req.body?.title, content: req.body?.content, category: req.body?.category }) }); }
  catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
});
router.post("/memory/:id/confirm", requireRole("owner", "admin"), async (req, res) => {
  try { return res.json({ success: true, data: await jarvisMemoryCaptureService.confirm({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, approvalId: req.params.id, confirmationPhrase: req.body?.confirmationPhrase }) }); }
  catch (error) { return res.status(error.code === "MEMORY_APPROVAL_NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code }); }
});

/**
 * Knowledge Center: browse, review, and version-manage every knowledge note
 * for this workspace (both Obsidian-synced drafts and notes authored
 * directly in the app). Never exposes another workspace's notes.
 */
router.get("/memory/notes", requireRole("owner", "admin"), async (req, res) => {
  try {
    const notes = await jarvisMemoryService.listNotes({ workspaceId: req.auth.workspaceId, status: req.query.status, category: req.query.category, search: req.query.search, includeArchived: req.query.includeArchived === "true" });
    return res.json({ success: true, data: notes });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Knowledge notes could not be loaded" });
  }
});
router.get("/memory/notes/:id", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await jarvisMemoryService.getNote({ workspaceId: req.auth.workspaceId, noteId: req.params.id }) });
  } catch (error) {
    return res.status(error.code === "MEMORY_NOTE_NOT_FOUND" ? 404 : 500).json({ success: false, error: error.message });
  }
});
router.post("/memory/notes/:id/approve", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await jarvisMemoryService.approveNote({ workspaceId: req.auth.workspaceId, noteId: req.params.id, userId: req.auth.userId, effectiveDate: req.body?.effectiveDate, reviewDate: req.body?.reviewDate, ownerLabel: req.body?.ownerLabel }) });
  } catch (error) {
    return res.status(error.code === "MEMORY_NOTE_NOT_FOUND" ? 404 : 400).json({ success: false, error: error.message, code: error.code });
  }
});
router.post("/memory/notes/:id/reject", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await jarvisMemoryService.rejectNote({ workspaceId: req.auth.workspaceId, noteId: req.params.id, userId: req.auth.userId, reason: req.body?.reason }) });
  } catch (error) {
    return res.status(error.code === "MEMORY_NOTE_NOT_FOUND" ? 404 : 400).json({ success: false, error: error.message, code: error.code });
  }
});
router.post("/memory/notes/:id/archive", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await jarvisMemoryService.archiveNote({ workspaceId: req.auth.workspaceId, noteId: req.params.id, userId: req.auth.userId }) });
  } catch (error) {
    return res.status(error.code === "MEMORY_NOTE_NOT_FOUND" ? 404 : 400).json({ success: false, error: error.message, code: error.code });
  }
});
router.post("/memory/notes/:id/restore-version", requireRole("owner", "admin"), async (req, res) => {
  try {
    return res.json({ success: true, data: await jarvisMemoryService.restoreVersion({ workspaceId: req.auth.workspaceId, noteId: req.params.id, userId: req.auth.userId, version: req.body?.version }) });
  } catch (error) {
    return res.status(["MEMORY_NOTE_NOT_FOUND", "MEMORY_VERSION_NOT_FOUND"].includes(error.code) ? 404 : 400).json({ success: false, error: error.message, code: error.code });
  }
});

/**
 * Owner-only multi-PDF upload. Deliberately narrower than every other
 * Knowledge Center route above (owner/admin) — this both spends AI budget
 * and creates draft monitors, so it stays owner-only. Every PDF becomes one
 * draft note (never auto-approved) plus, when AI analysis succeeds, up to a
 * few DISABLED draft monitors (never auto-enabled) — see
 * services/pdfKnowledgeIngestionService.js for the full safety reasoning.
 * A partial failure (one bad PDF among several) never discards the ones
 * that succeeded.
 */
router.post("/memory/notes/upload-pdfs", requireRole("owner"), (req, res, next) => {
  pdfUpload.array("files", 10)(req, res, (error) => {
    if (error) return res.status(400).json({ success: false, error: error.message || "Upload failed", code: "PDF_UPLOAD_REJECTED" });
    next();
  });
}, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ success: false, error: "Choose at least one PDF file", code: "PDF_FILES_REQUIRED" });
  const category = req.body?.category;
  const results = [];
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await ingestPdf({
        workspaceId: req.auth.workspaceId, userId: req.auth.userId, auth: req.auth, category,
        originalFilename: file.originalname, buffer: file.buffer,
        correlationId: req.headers["x-request-id"] || "",
      });
      results.push({ filename: file.originalname, success: true, noteId: outcome.note._id, monitorDraftsCreated: outcome.monitorDrafts.length, aiAnalysisSucceeded: outcome.aiAnalysisSucceeded, aiAnalysisReason: outcome.aiAnalysisReason });
    } catch (error) {
      results.push({ filename: file.originalname, success: false, error: error.message, code: error.code || "PDF_INGEST_FAILED" });
    }
  }
  return res.json({ success: true, data: { results } });
});

/**
 * GET /api/jarvis/summary
 * Get system summary without natural language processing
 */
router.get("/summary", async (req, res) => {
  try {
    const [
      prioritySummary,
      topOrganizations,
      contactStats,
      campaignStatus,
      growthOpportunities,
    ] = await Promise.all([
      jarvisService.getPrioritySummary(),
      jarvisService.getTopOrganizations(),
      jarvisService.getContactStats(),
      jarvisService.getCampaignStatus(),
      jarvisService.getGrowthOpportunities(),
    ]);

    res.json({
      success: true,
      data: {
        priority: prioritySummary,
        topOrganizations,
        contacts: contactStats,
        campaigns: campaignStatus,
        growthOpportunities,
      },
    });
  } catch (error) {
    console.error("GET /jarvis/summary error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve summary",
    });
  }
});

/**
 * GET /api/jarvis/organizations
 * Get organization insights
 */
router.get("/organizations", async (req, res) => {
  try {
    const [topOrgs, stats] = await Promise.all([
      jarvisService.getTopOrganizations(),
      jarvisService.getOrganizationStats(),
    ]);

    res.json({
      success: true,
      data: {
        topOrganizations: topOrgs,
        stats,
      },
    });
  } catch (error) {
    console.error("GET /jarvis/organizations error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve organization insights",
    });
  }
});

/**
 * GET /api/jarvis/contacts
 * Get contact insights
 */
router.get("/contacts", async (req, res) => {
  try {
    const contactStats = await jarvisService.getContactStats();

    res.json({
      success: true,
      data: contactStats,
    });
  } catch (error) {
    console.error("GET /jarvis/contacts error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve contact insights",
    });
  }
});

/**
 * GET /api/jarvis/campaigns
 * Get campaign insights
 */
router.get("/campaigns", async (req, res) => {
  try {
    const campaignStatus = await jarvisService.getCampaignStatus();

    res.json({
      success: true,
      data: campaignStatus,
    });
  } catch (error) {
    console.error("GET /jarvis/campaigns error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve campaign insights",
    });
  }
});

/**
 * GET /api/jarvis/opportunities
 * Get growth opportunities
 */
router.get("/opportunities", async (req, res) => {
  try {
    const opportunities = await jarvisService.getGrowthOpportunities();

    res.json({
      success: true,
      data: opportunities,
    });
  } catch (error) {
    console.error("GET /jarvis/opportunities error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve growth opportunities",
    });
  }
});

// =========================================================================
// ACTION LAYER - Campaign Recommendations & Execution
// =========================================================================

/**
 * POST /api/jarvis/actions/recommend-campaign
 * Recommend and create a bootcamp campaign draft
 * Request: { audienceId?, organizationId?, templateType? }
 * Response: { campaign, message }
 */
router.post("/actions/recommend-campaign", async (req, res) => {
  try {
    const { audienceId, organizationId, templateType } = req.body;

    const result = await jarvisService.recommendCampaignDraft({
      audienceId,
      organizationId,
      templateType,
    });

    if (result.success) {
      res.json({
        success: true,
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("POST /jarvis/actions/recommend-campaign error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to recommend campaign",
    });
  }
});

/**
 * POST /api/jarvis/actions/prepare-recipients
 * Generate campaign recipient summary
 * Request: { campaignId, source?, tags?, limit? }
 * Response: { recipientCount, bySource, recipients[], message }
 */
router.post("/actions/prepare-recipients", async (req, res) => {
  try {
    const { campaignId, source, tags, limit } = req.body;

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: "Campaign ID is required",
      });
    }

    const result = await jarvisService.prepareRecipients(campaignId, {
      source,
      tags,
      limit,
    });

    if (result.success) {
      res.json({
        success: true,
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("POST /jarvis/actions/prepare-recipients error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to prepare recipients",
    });
  }
});

/**
 * POST /api/jarvis/actions/send-test-email
 * Prepare email campaign and send test
 * Request: { campaignId, testEmail }
 * Response: { messageId, status, sentAt }
 */
router.post("/actions/send-test-email", async (req, res) => {
  try {
    const { campaignId, testEmail } = req.body;

    if (!campaignId || !testEmail) {
      return res.status(400).json({
        success: false,
        error: "Campaign ID and test email are required",
      });
    }

    const result = await jarvisService.executeTestEmail(campaignId, testEmail);

    if (result.success) {
      res.json({
        success: true,
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("POST /jarvis/actions/send-test-email error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to send test email",
    });
  }
});

/**
 * GET /api/jarvis/actions/campaign-status/:campaignId
 * Return campaign status and metrics
 * Response: { campaign, metrics, recipients, timeline }
 */
router.get("/actions/campaign-status/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;

    const result = await jarvisService.getCampaignExecutionStatus(campaignId);

    if (result.success) {
      res.json({
        success: true,
        data: result,
      });
    } else {
      res.status(404).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("GET /jarvis/actions/campaign-status error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve campaign status",
    });
  }
});

/**
 * POST /api/jarvis/voice
 * Voice interface: transcribe audio and process with Jarvis
 * Request: { audio: <base64 audio data> }
 * Response: { transcript, response }
 */
router.post("/voice", async (req, res) => {
  try {
    const speechService = require("../services/speechService");
    const { audio } = req.body;

    if (!audio) {
      return res.status(400).json({
        success: false,
        error: "Audio data is required",
      });
    }

    // Transcribe audio to text
    const transcript = await speechService.transcribeAudio(audio);

    if (!transcript || typeof transcript !== "string") {
      return res.status(400).json({
        success: false,
        error: "Failed to transcribe audio",
      });
    }

    // Process transcript with Jarvis chat logic
    const jarvisResponse = await jarvisService.processQuery(transcript, { workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, correlationId: req.get("x-request-id") || "" });

    res.json({
      success: true,
      data: {
        transcript,
        response: jarvisResponse,
      },
    });
  } catch (error) {
    console.error("POST /jarvis/voice error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to process voice input",
    });
  }
});

module.exports = router;
