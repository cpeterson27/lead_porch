/**
 * App-wide, workspace-scoped, append-only audit log — the single source of
 * truth for "who did what to what, when, and how," distinct from
 * CrmActivity (a contact-centric CRM timeline) and the provider-specific
 * ledgers (AiUsageRecord, ProviderApiUsage). Never updated in place; a
 * correction is always a NEW row referencing the original.
 *
 * Never store secrets/tokens, full private message bodies, or raw
 * sensitive personal data here — only safe, minimal before/after diffs and
 * sanitized diagnostic metadata (see services/auditService.js's redaction).
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const ACTIONS = [
  "knowledge.note.created", "knowledge.note.approved", "knowledge.note.rejected", "knowledge.note.archived", "knowledge.note.version_restored",
  "obsidian.sync.completed", "obsidian.sync.failed", "obsidian.credential.created", "obsidian.credential.revoked",
  "resource.file.uploaded", "resource.file.versioned", "resource.file.archived", "resource.file.viewed", "resource.file.downloaded", "resource.file.acknowledged", "resource.jarvis_approval.changed",
  "invitation.sent", "invitation.accepted", "invitation.revoked",
  "permission.changed", "role.changed",
  "referral.submitted", "referral.attributed", "referral.corrected", "referral.dispute_filed", "referral.dispute_resolved",
  "commission.created", "commission.status_changed",
  "provider.request", "ai.generation",
  "import.completed", "outreach.sent", "automation.executed",
  "publishing.published", "publishing.deleted", "comment.created", "comment.deleted", "like.created",
  "deletion", "integration.connected", "integration.disconnected", "settings.changed",
  "vertex.agent_search.indexed", "vertex.agent_search.removed", "vertex.agent_search.workspace_purged",
];

const schema = new mongoose.Schema({
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  actorRole: { type: String, default: "", maxlength: 40 },
  origin: { type: String, enum: ["human", "ai", "system"], default: "human", index: true },
  action: { type: String, enum: ACTIONS, required: true, index: true },
  targetType: { type: String, required: true, maxlength: 80, index: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // Minimal, safe field-level diff only — never a full document dump, never
  // a secret/token/credential value or private message body.
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  approvalId: { type: mongoose.Schema.Types.ObjectId, default: null },
  provider: { type: String, default: "", maxlength: 60 },
  externalId: { type: String, default: "", maxlength: 200 },
  costCredits: { type: Number, default: null },
  success: { type: Boolean, required: true, index: true },
  requestId: { type: String, default: "", maxlength: 200, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: "occurredAt", updatedAt: false }, collection: "audit_logs" });

schema.index({ workspaceId: 1, occurredAt: -1 });
schema.index({ workspaceId: 1, action: 1, occurredAt: -1 });
schema.index({ workspaceId: 1, targetType: 1, targetId: 1, occurredAt: -1 });
schema.plugin(workspacePlugin);

module.exports = mongoose.model("AuditLog", schema);
module.exports.ACTIONS = ACTIONS;
