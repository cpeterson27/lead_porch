const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const { configuredCredentials } = require("./jarvisVaultSyncAuthService");
const auditService = require("./auditService");

const KNOWLEDGE_FOLDERS = [
  "00 Dashboard",
  "02 Campaigns",
  "03 Contacts & ICP",
  "04 Partners & Affiliates",
  "05 Offers & Programs",
  "06 Marketing Channels",
  "07 SOPs",
  "08 Decisions",
];
const CATEGORY_FOLDERS = Object.freeze({
  "dashboard/context": "00 Dashboard", campaigns: "02 Campaigns", "contacts-icp": "03 Contacts & ICP",
  "partners-affiliates": "04 Partners & Affiliates", "offers-programs": "05 Offers & Programs",
  "marketing-channels": "06 Marketing Channels", sops: "07 SOPs", decisions: "08 Decisions",
});
const FOLDER_CATEGORIES = Object.fromEntries(Object.entries(CATEGORY_FOLDERS).map(([category, folder]) => [folder, category]));

function enabled() {
  return process.env.JARVIS_OBSIDIAN_MEMORY_ENABLED === "true" && (memorySource() === "cloud" || Boolean(process.env.OBSIDIAN_VAULT_PATH?.trim()));
}

function memorySource() {
  return process.env.JARVIS_MEMORY_SOURCE === "cloud" ? "cloud" : "local";
}

function vaultPath() {
  return path.resolve(process.env.OBSIDIAN_VAULT_PATH.trim());
}

function escapeMarkdown(value) {
  return String(value || "").replaceAll("\r", "").trim();
}

function localWorkspaceAllowed(workspaceId) {
  const configured = String(process.env.OBSIDIAN_WORKSPACE_ID || process.env.JARVIS_MEMORY_SYNC_WORKSPACE_ID || "").trim();
  return Boolean(workspaceId && configured && String(workspaceId) === configured);
}

async function getStatus(workspaceId) {
  if (memorySource() === "cloud") {
    const configured = process.env.JARVIS_OBSIDIAN_MEMORY_ENABLED === "true" && configuredCredentials().some((item) => String(item.workspaceId) === String(workspaceId));
    const noteCount = configured && workspaceId ? await JarvisMemoryNote.countDocuments({ workspaceId, source: { $in: ["obsidian_bridge", "approved_memory", "pdf_upload"] } }) : 0;
    return { configured, enabled: configured, writable: configured, source: "cloud", noteCount };
  }

  const configured = Boolean(process.env.OBSIDIAN_VAULT_PATH?.trim()) && localWorkspaceAllowed(workspaceId);
  if (!configured) return { configured: false, enabled: false, writable: false, source: "local", noteCount: 0 };

  try {
    await fs.access(vaultPath());
    return { configured: true, enabled: enabled(), writable: true, source: "local" };
  } catch {
    return { configured: true, enabled: enabled(), writable: false, source: "local" };
  }
}

async function recordConversation() {
  return { recorded: false, reason: "conversation_history_is_stored_in_growth_operator" };
}

function scoreNote(fileName, content, terms) {
  const searchable = `${fileName} ${content}`.toLowerCase();
  return terms.reduce((score, term) => score + (searchable.includes(term) ? 1 : 0), 0);
}

async function findMarkdownFiles(directory, root, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(directory, entry.name);
    if (!entryPath.startsWith(`${root}${path.sep}`)) continue;
    if (entry.isDirectory()) await findMarkdownFiles(entryPath, root, files);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(entryPath);
    if (files.length >= 80) return files;
  }
  return files;
}

async function retrieveRelevantNotes(query, { workspaceId, categories, limit = 4 } = {}) {
  if (!enabled()) return { available: false, sources: [], context: "" };

  if (memorySource() === "cloud") return retrieveCloudNotes(query, { workspaceId, categories, limit });
  if (!localWorkspaceAllowed(workspaceId)) return { available: false, sources: [], context: "" };

  const root = vaultPath();
  const terms = String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const files = [];
  const requestedFolders = Array.isArray(categories) && categories.length
    ? categories.map((category) => CATEGORY_FOLDERS[category]).filter(Boolean)
    : KNOWLEDGE_FOLDERS;
  for (const folder of requestedFolders) {
    const folderPath = path.join(root, folder);
    try { await findMarkdownFiles(folderPath, root, files); } catch { /* Optional vault folder. */ }
  }

  const notes = await Promise.all(files.map(async (filePath) => {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return { file: path.relative(root, filePath), content: content.slice(0, 6000) };
    } catch { return null; }
  }));

  const ranked = notes.filter(Boolean)
    .map((note) => ({ ...note, score: scoreNote(note.file, note.content, terms) }))
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(10, Math.max(1, Number(limit) || 4)));

  return {
    available: true,
    sources: ranked.map((note) => note.file),
    context: ranked.map((note) => `Source: ${note.file}\n${note.content.slice(0, 1800)}`).join("\n\n").slice(0, 6500),
  };
}

function noteTitle(notePath) {
  return path.basename(notePath, path.extname(notePath)).replace(/[-_]/g, " ") || "Untitled note";
}

function isSafeNotePath(notePath) {
  return typeof notePath === "string" && notePath.endsWith(".md") && !notePath.startsWith("/") && !notePath.includes("..") && KNOWLEDGE_FOLDERS.some((folder) => notePath === folder || notePath.startsWith(`${folder}/`));
}

function categoryForPath(notePath) {
  const folder = KNOWLEDGE_FOLDERS.find((candidate) => notePath === candidate || notePath.startsWith(`${candidate}/`));
  return folder ? FOLDER_CATEGORIES[folder] : null;
}

function safeSourceDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function safeFileName(value) {
  return String(value || "memory").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "memory";
}

async function saveApprovedMemory({ workspaceId, userId, approvalId, category, title, content }, dependencies = {}) {
  if (!CATEGORY_FOLDERS[category]) { const error = new Error("Select an approved memory category"); error.code = "MEMORY_CATEGORY_INVALID"; throw error; }
  const normalizedTitle = String(title || "").trim().slice(0, 200);
  const normalizedContent = String(content || "").trim().slice(0, 120000);
  if (!normalizedTitle || !normalizedContent) { const error = new Error("Memory title and content are required"); error.code = "MEMORY_CONTENT_INVALID"; throw error; }
  const relativePath = `${CATEGORY_FOLDERS[category]}/Growth Operator/${safeFileName(normalizedTitle)}-${String(approvalId).slice(-8)}.md`;
  const body = `# ${escapeMarkdown(normalizedTitle)}\n\n${escapeMarkdown(normalizedContent)}\n`;
  if (memorySource() === "local") {
    if (!enabled() || !localWorkspaceAllowed(workspaceId)) { const error = new Error("The local Obsidian vault is not available for this workspace"); error.code = "LOCAL_VAULT_UNAVAILABLE"; throw error; }
    const root = vaultPath(), filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`) || !isSafeNotePath(relativePath)) throw new Error("Approved memory path is outside the configured vault");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body, { encoding: "utf8", flag: "wx" });
    return { stored: true, source: "local_obsidian", path: relativePath, synchronizedToObsidian: true };
  }
  const Model = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const contentHash = crypto.createHash("sha256").update(body).digest("hex");
  // Reaching this point already required the caller to type the exact
  // confirmation phrase (see jarvisMemoryCaptureService.confirm) — that IS
  // the human approval step for knowledge authored directly in the app, so
  // it is approved immediately, unlike an Obsidian-synced note.
  await Model.create({ workspaceId, source: "approved_memory", category, path: relativePath, title: normalizedTitle, content: body, contentHash, sourceUpdatedAt: new Date(), createdByUserId: userId, approvedByUserId: userId, status: "approved", approvedAt: new Date(), effectiveDate: new Date(), version: 1, versions: [{ version: 1, title: normalizedTitle, content: body, contentHash, changeSource: "approved_memory", savedByUserId: userId }] });
  return { stored: true, source: "growth_operator_cloud_memory", path: relativePath, synchronizedToObsidian: false };
}

async function syncCloudNotes(workspaceId, notes, dependencies = {}) {
  const Model = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  if (!workspaceId) { const error = new Error("Vault bridge workspace is required"); error.statusCode = 401; throw error; }
  if (!Array.isArray(notes) || notes.length > 200) {
    const error = new Error("A sync must contain between 0 and 200 approved Markdown notes");
    error.statusCode = 400;
    throw error;
  }

  const normalized = [], seenPaths = new Set();
  for (const note of notes) {
    const notePath = String(note?.path || "").replaceAll("\\", "/").trim();
    const content = typeof note?.content === "string" ? note.content : "";
    if (!isSafeNotePath(notePath) || content.length > 120000) {
      const error = new Error("The sync contains an invalid approved note");
      error.statusCode = 400;
      throw error;
    }
    if (seenPaths.has(notePath)) { const error = new Error("The sync contains a duplicate note path"); error.statusCode = 400; throw error; }
    seenPaths.add(notePath);
    normalized.push({
      path: notePath,
      title: noteTitle(notePath),
      content,
      contentHash: crypto.createHash("sha256").update(content).digest("hex"),
      sourceUpdatedAt: safeSourceDate(note.updatedAt),
      category: categoryForPath(notePath),
    });
  }

  const paths = normalized.map((note) => note.path);
  const existing = await Model.find({ workspaceId, source: "obsidian_bridge", ...(paths.length ? { path: { $in: paths } } : {}) }).select("path contentHash sourceUpdatedAt category status version versions title content").lean();
  const byPath = new Map(existing.map((note) => [note.path, note]));
  const changed = normalized.filter((note) => byPath.get(note.path)?.contentHash !== note.contentHash || byPath.get(note.path)?.category !== note.category || String(byPath.get(note.path)?.sourceUpdatedAt || "") !== String(note.sourceUpdatedAt || ""));
  let draftsAwaitingReviewCount = 0;
  const droppedFromIndex = [];
  if (changed.length) {
    await Model.bulkWrite(changed.map((note) => {
      const previous = byPath.get(note.path);
      // A real content change from Obsidian is always a reviewable draft —
      // it never silently becomes (or stays) approved knowledge on its own.
      // An already-draft/rejected note simply gets updated content, still
      // awaiting its first review.
      const wasApproved = previous?.status === "approved";
      if (wasApproved) droppedFromIndex.push({ _id: previous._id, workspaceId });
      if (!previous || previous.contentHash !== note.contentHash) draftsAwaitingReviewCount += 1;
      const nextVersion = (previous?.version || 0) + 1;
      const versionSnapshot = previous
        ? [{ version: previous.version || 1, title: previous.title, content: previous.content, contentHash: previous.contentHash, changeSource: "obsidian_bridge", savedAt: new Date() }]
        : [];
      return {
        updateOne: {
          filter: { workspaceId, source: "obsidian_bridge", path: note.path },
          update: {
            $set: { ...note, workspaceId, source: "obsidian_bridge", status: "draft", pendingRemoval: false, version: nextVersion, ...(wasApproved ? { rejectedAt: null, rejectionReason: "" } : {}) },
            ...(versionSnapshot.length ? { $push: { versions: { $each: versionSnapshot, $slice: -20 } } } : {}),
          },
          upsert: true,
        },
      };
    }));
    // A previously-approved note whose content just changed drops out of
    // "approved" above — it must also come out of the Agent Search index
    // until it is re-approved (best-effort, never blocks the sync itself).
    const sync = dependencies.discoveryEngineSyncService || require("./discoveryEngineSyncService");
    for (const note of droppedFromIndex) await sync.removeNote(note);
  }
  // A path no longer present in this sync is flagged for human review, never
  // silently deleted — an approved note stays approved and retrievable until
  // someone explicitly archives it (or it reappears in a later sync, which
  // clears the flag naturally via the upsert above).
  const flagged = await Model.updateMany(
    { workspaceId, source: "obsidian_bridge", pendingRemoval: false, ...(paths.length ? { path: { $nin: paths } } : {}) },
    { $set: { pendingRemoval: true } },
  );
  return { syncedCount: normalized.length, createdOrUpdatedCount: changed.length, unchangedCount: normalized.length - changed.length, draftsAwaitingReviewCount, flaggedForRemovalCount: flagged.modifiedCount || 0 };
}

async function retrieveCloudNotes(query, { workspaceId, categories, limit = 4 } = {}, Model = JarvisMemoryNote) {
  if (!workspaceId) return { available: false, sources: [], citations: [], context: "" };
  const terms = String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  // Only ever serve approved knowledge to agents — a draft (including one
  // synced but not yet reviewed) or rejected/archived note is never used,
  // no matter how well it matches the query.
  const filter = { workspaceId, source: { $in: ["obsidian_bridge", "approved_memory", "pdf_upload"] }, status: "approved" };
  if (Array.isArray(categories) && categories.length) filter.category = { $in: categories.filter((category) => CATEGORY_FOLDERS[category]) };
  const notes = await Model.find(filter).select("path title content category source approvedAt effectiveDate reviewDate").lean();
  const now = Date.now();
  const ranked = notes
    .map((note) => ({ ...note, score: scoreNote(note.path, note.content, terms), stale: Boolean(note.reviewDate && new Date(note.reviewDate).getTime() < now) }))
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(10, Math.max(1, Number(limit) || 4)));
  return {
    available: true,
    sources: ranked.map((note) => note.path),
    citations: ranked.map((note) => ({ path: note.path, title: note.title || noteTitle(note.path), category: note.category, source: note.source, approvedAt: note.approvedAt || null, stale: note.stale })),
    context: ranked.map((note) => `Source: ${note.path}${note.stale ? " (past its review date — verify before relying on this)" : ""}\n${note.content.slice(0, 1800)}`).join("\n\n").slice(0, 6500),
  };
}

/** List notes for the Knowledge Center UI, with optional status/category/search filters. */
async function listNotes({ workspaceId, status, category, search, includeArchived = false } = {}, Model = JarvisMemoryNote) {
  if (!workspaceId) { const error = new Error("Workspace context is required"); error.code = "WORKSPACE_REQUIRED"; throw error; }
  const filter = { workspaceId };
  if (status) filter.status = status;
  else if (!includeArchived) filter.status = { $ne: "archived" };
  if (category) filter.category = category;
  const notes = await Model.find(filter).select("-versions").sort({ updatedAt: -1 }).limit(500).lean();
  const term = String(search || "").trim().toLowerCase();
  return term ? notes.filter((note) => `${note.title} ${note.content}`.toLowerCase().includes(term)) : notes;
}

async function getNote({ workspaceId, noteId } = {}, Model = JarvisMemoryNote) {
  if (!workspaceId || !noteId) { const error = new Error("A note ID is required"); error.code = "MEMORY_NOTE_REQUIRED"; throw error; }
  const note = await Model.findOne({ _id: noteId, workspaceId }).lean();
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  return note;
}

async function approveNote({ workspaceId, noteId, userId, effectiveDate, reviewDate, ownerLabel } = {}, Model = JarvisMemoryNote) {
  const note = await Model.findOneAndUpdate(
    { _id: noteId, workspaceId },
    { $set: { status: "approved", approvedByUserId: userId, approvedAt: new Date(), rejectedByUserId: null, rejectedAt: null, rejectionReason: "", ...(effectiveDate !== undefined ? { effectiveDate: effectiveDate ? new Date(effectiveDate) : null } : {}), ...(reviewDate !== undefined ? { reviewDate: reviewDate ? new Date(reviewDate) : null } : {}), ...(ownerLabel !== undefined ? { ownerLabel: String(ownerLabel || "").trim().slice(0, 120) } : {}) } },
    { new: true },
  );
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  await auditService.record({ workspaceId, actorUserId: userId, action: "knowledge.note.approved", targetType: "JarvisMemoryNote", targetId: note._id, after: { status: "approved", ownerLabel: note.ownerLabel }, success: true });
  await require("./discoveryEngineSyncService").indexApprovedNote(note);
  return note;
}

async function rejectNote({ workspaceId, noteId, userId, reason = "" } = {}, Model = JarvisMemoryNote) {
  const note = await Model.findOneAndUpdate(
    { _id: noteId, workspaceId },
    { $set: { status: "rejected", rejectedByUserId: userId, rejectedAt: new Date(), rejectionReason: String(reason || "").trim().slice(0, 2000) } },
    { new: true },
  );
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  await auditService.record({ workspaceId, actorUserId: userId, action: "knowledge.note.rejected", targetType: "JarvisMemoryNote", targetId: note._id, after: { status: "rejected", reason: note.rejectionReason }, success: true });
  await require("./discoveryEngineSyncService").removeNote(note);
  return note;
}

async function archiveNote({ workspaceId, noteId, userId } = {}, Model = JarvisMemoryNote) {
  const note = await Model.findOneAndUpdate(
    { _id: noteId, workspaceId },
    { $set: { status: "archived", archivedByUserId: userId, archivedAt: new Date() } },
    { new: true },
  );
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  await auditService.record({ workspaceId, actorUserId: userId, action: "knowledge.note.archived", targetType: "JarvisMemoryNote", targetId: note._id, success: true });
  await require("./discoveryEngineSyncService").removeNote(note);
  return note;
}

async function deleteNote({ workspaceId, noteId, userId } = {}, Model = JarvisMemoryNote) {
  const note = await Model.findOne({ _id: noteId, workspaceId });
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  await require("./discoveryEngineSyncService").removeNote(note);
  await Model.deleteOne({ _id: note._id, workspaceId });
  await auditService.record({ workspaceId, actorUserId: userId, action: "knowledge.note.deleted", targetType: "JarvisMemoryNote", targetId: note._id, before: { title: note.title, source: note.source, status: note.status }, success: true });
  return { id: note._id, deleted: true };
}

/** Restores a prior version's content as a new draft revision, awaiting its own approval — never restores directly into "approved". */
async function restoreVersion({ workspaceId, noteId, userId, version } = {}, Model = JarvisMemoryNote) {
  const note = await Model.findOne({ _id: noteId, workspaceId });
  if (!note) { const error = new Error("Knowledge note not found"); error.code = "MEMORY_NOTE_NOT_FOUND"; throw error; }
  const target = (note.versions || []).find((row) => row.version === Number(version));
  if (!target) { const error = new Error("That version was not found for this note"); error.code = "MEMORY_VERSION_NOT_FOUND"; throw error; }
  const previousVersion = note.version;
  note.versions.push({ version: note.version, title: note.title, content: note.content, contentHash: note.contentHash, changeSource: "restore", savedByUserId: userId });
  note.version += 1;
  note.title = target.title;
  note.content = target.content;
  note.contentHash = target.contentHash;
  note.status = "draft";
  await note.save();
  await auditService.record({ workspaceId, actorUserId: userId, action: "knowledge.note.version_restored", targetType: "JarvisMemoryNote", targetId: note._id, before: { version: previousVersion }, after: { version: note.version, restoredFromVersion: Number(version) }, success: true });
  // A restored version always lands as "draft" (see above) — if the note had
  // been indexed for Agent Search while it was approved, it must come out of
  // the index until it is re-approved.
  await require("./discoveryEngineSyncService").removeNote(note);
  return note;
}

module.exports = { CATEGORY_FOLDERS, KNOWLEDGE_FOLDERS, approveNote, archiveNote, categoryForPath, deleteNote, getNote, getStatus, isSafeNotePath, listNotes, localWorkspaceAllowed, memorySource, recordConversation, rejectNote, restoreVersion, retrieveCloudNotes, retrieveRelevantNotes, saveApprovedMemory, syncCloudNotes };
