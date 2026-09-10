/**
 * System Agent — Lead Operations Guardian
 *
 * Deterministic, database-only pipeline and system health checks. This
 * service never calls OpenAI and never mutates data — it only reads records
 * already owned by other parts of the app and reports what it finds. Any
 * OpenAI-assisted synthesis on top of this report happens one layer up, in
 * the /system-agent/pipeline-health route, and only when explicitly
 * requested and available.
 */
const Contact = require("../models/Contact");
const SalesOpportunity = require("../models/SalesOpportunity");
const IntentSignal = require("../models/IntentSignal");
const CoachingApplication = require("../models/CoachingApplication");
const Enrollment = require("../models/Enrollment");
const PipelineStage = require("../models/PipelineStage");
const ConversationThread = require("../models/ConversationThread");
const AutomationActionRun = require("../models/AutomationActionRun");
const ResearchMonitor = require("../models/ResearchMonitor");
const IntegrationConnection = require("../models/IntegrationConnection");
const SocialConnection = require("../models/SocialConnection");
const AiUsageRecord = require("../models/AiUsageRecord");

const deps = { Contact, SalesOpportunity, IntentSignal, CoachingApplication, Enrollment, PipelineStage, ConversationThread, AutomationActionRun, ResearchMonitor, IntegrationConnection, SocialConnection, AiUsageRecord };

const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);
const ageDays = (date) => (date ? Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / DAY_MS)) : null);
const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function severityFor(urgencyScore) {
  if (urgencyScore >= 75) return "critical";
  if (urgencyScore >= 50) return "high";
  if (urgencyScore >= 25) return "medium";
  return "low";
}

function finding({ id, category, urgencyScore, title, summary, evidence = [], affectedRecords = [], count = null, oldestAgeDays = null, revenueImpact = null, blocksWorkflow = false, recommendedAction, links = [] }) {
  const effectiveCount = count == null ? affectedRecords.length : count;
  const score = clamp(urgencyScore, 0, 100) * 10
    + Math.min(200, Math.round((revenueImpact || 0) / 100))
    + Math.min(100, effectiveCount * 5)
    + Math.min(120, (oldestAgeDays || 0) * 2)
    + (blocksWorkflow ? 50 : 0);
  return {
    id, category, severity: severityFor(urgencyScore), urgencyScore, score,
    title, summary, evidence: evidence.slice(0, 8), affectedRecords: affectedRecords.slice(0, 10),
    count: effectiveCount, ageDays: oldestAgeDays, revenueImpact: revenueImpact == null ? null : money(revenueImpact),
    blocksWorkflow, recommendedAction, approvalRequired: true, links,
  };
}

const contactLink = (id) => ({ label: "Open contact", url: `/crm/contacts/${id}` });
const opportunitiesLink = () => ({ label: "Open pipeline", url: "/opportunities" });
const socialLink = () => ({ label: "Open Social Inbox", url: "/social" });
const integrationsLink = () => ({ label: "Open Integrations", url: "/integrations" });
const applicationsLink = () => ({ label: "Open Applications", url: "/settings/applications" });
const discoveryLink = () => ({ label: "Open Discovery", url: "/discovery" });
const coachingLink = () => ({ label: "Open Coaching", url: "/coaching" });

// 1. High-intent activity not connected to a contact
async function checkUnlinkedHighIntent(workspaceId, models) {
  const signals = await models.IntentSignal.find({ workspaceId, classification: "buyer_intent", status: { $nin: ["dismissed", "converted"] }, discoveredAt: { $lte: daysAgo(2) } }).select("title organizationName score discoveredAt sourceUrl").sort({ score: -1 }).limit(200).lean();
  if (!signals.length) return null;
  const linkedIds = new Set((await models.SalesOpportunity.find({ workspaceId, "leadAttribution.signalId": { $in: signals.map((s) => s._id) } }).select("leadAttribution.signalId").lean()).map((o) => String(o.leadAttribution.signalId)));
  const orphaned = signals.filter((s) => !linkedIds.has(String(s._id)));
  if (!orphaned.length) return null;
  const oldest = orphaned.reduce((max, s) => Math.max(max, ageDays(s.discoveredAt) || 0), 0);
  return finding({
    id: "high_intent_unlinked", category: "attribution", urgencyScore: clamp(40 + orphaned.length * 2 + (oldest > 7 ? 15 : 0), 0, 95),
    title: "High-intent signals never became a CRM record",
    summary: `${orphaned.length} buyer-intent signal${orphaned.length === 1 ? "" : "s"} from Discovery ${orphaned.length === 1 ? "has" : "have"} not been turned into a contact or opportunity.`,
    evidence: orphaned.slice(0, 5).map((s) => `"${s.title || s.organizationName || "Untitled signal"}" (score ${s.score}, found ${ageDays(s.discoveredAt)}d ago) — ${s.sourceUrl}`),
    affectedRecords: orphaned.slice(0, 10).map((s) => ({ type: "intent_signal", id: String(s._id), label: s.title || s.organizationName || "Untitled signal" })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Review these Discovery signals and either qualify them into an opportunity or dismiss them so they stop aging in the queue.",
    links: [discoveryLink()],
  });
}

// 2. Duplicate contacts (matching phone, or matching name+company)
async function checkDuplicateContacts(workspaceId, models) {
  const groups = await models.Contact.aggregate([
    { $match: { workspaceId, phone: { $type: "string", $ne: "" } } },
    { $group: { _id: "$phone", ids: { $push: "$_id" }, names: { $push: "$name" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 25 },
  ]);
  if (!groups.length) return null;
  const totalDuplicates = groups.reduce((sum, g) => sum + g.count, 0);
  return finding({
    id: "duplicate_contacts", category: "data_quality", urgencyScore: clamp(20 + groups.length * 5, 0, 70),
    title: "Duplicate contacts sharing the same phone number",
    summary: `${groups.length} phone number${groups.length === 1 ? "" : "s"} across ${totalDuplicates} contacts look like duplicate records.`,
    evidence: groups.slice(0, 5).map((g) => `${g._id}: ${g.names.filter(Boolean).join(", ")}`),
    affectedRecords: groups.slice(0, 10).flatMap((g) => g.ids.slice(0, 2)).map((id) => ({ type: "contact", id: String(id), label: "Possible duplicate" })),
    count: totalDuplicates, blocksWorkflow: false,
    recommendedAction: "Review and merge duplicate contacts so follow-ups and attribution aren't split across records.",
    links: [{ label: "Open Contacts", url: "/contacts" }],
  });
}

// 3. Incomplete contacts (no email and no phone)
async function checkIncompleteContacts(workspaceId, models) {
  const filter = { workspaceId, status: { $in: ["active", "prospect"] }, $and: [{ $or: [{ email: { $exists: false } }, { email: "" }] }, { $or: [{ phone: { $exists: false } }, { phone: "" }] }] };
  const count = await models.Contact.countDocuments(filter);
  if (!count) return null;
  const sample = await models.Contact.find(filter).select("name createdAt").sort({ createdAt: -1 }).limit(10).lean();
  return finding({
    id: "incomplete_contacts", category: "data_quality", urgencyScore: clamp(15 + count, 0, 55),
    title: "Contacts with no email and no phone on file",
    summary: `${count} active contact${count === 1 ? "" : "s"} cannot be reached by email or phone.`,
    evidence: sample.slice(0, 5).map((c) => `${c.name} — added ${ageDays(c.createdAt)}d ago`),
    affectedRecords: sample.map((c) => ({ type: "contact", id: String(c._id), label: c.name })),
    count, blocksWorkflow: true,
    recommendedAction: "Enrich or remove these contacts — as-is, no one can follow up with them.",
    links: [{ label: "Open Contacts", url: "/contacts" }],
  });
}

// 4. Qualified leads (researchStatus) without a sales opportunity
async function checkQualifiedWithoutOpportunity(workspaceId, models) {
  const qualified = await models.Contact.find({ workspaceId, researchStatus: "qualified", status: { $in: ["active", "prospect"] } }).select("name updatedAt").lean();
  if (!qualified.length) return null;
  const withOpp = new Set((await models.SalesOpportunity.find({ workspaceId, primaryContactId: { $in: qualified.map((c) => c._id) } }).select("primaryContactId").lean()).map((o) => String(o.primaryContactId)));
  const missing = qualified.filter((c) => !withOpp.has(String(c._id)));
  if (!missing.length) return null;
  const oldest = missing.reduce((max, c) => Math.max(max, ageDays(c.updatedAt) || 0), 0);
  return finding({
    id: "qualified_without_opportunity", category: "pipeline", urgencyScore: clamp(50 + missing.length * 3 + (oldest > 5 ? 15 : 0), 0, 95),
    title: "Qualified leads with no sales opportunity",
    summary: `${missing.length} contact${missing.length === 1 ? " is" : "s are"} marked qualified but ${missing.length === 1 ? "has" : "have"} no opportunity in the pipeline.`,
    evidence: missing.slice(0, 5).map((c) => `${c.name} — qualified ${ageDays(c.updatedAt)}d ago, no opportunity`),
    affectedRecords: missing.slice(0, 10).map((c) => ({ type: "contact", id: String(c._id), label: c.name })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Create a sales opportunity for each qualified lead so it enters the pipeline and gets a follow-up owner.",
    links: [{ label: "Open Contacts", url: "/contacts" }, opportunitiesLink()],
  });
}

// 5/6. Unassigned + missed follow-up + stale opportunities
async function checkOpportunityNeglect(workspaceId, models) {
  const terminalKeys = new Set((await models.PipelineStage.find({ workspaceId, terminal: { $in: ["won", "lost"] } }).select("key").lean()).map((s) => s.key));
  const isTerminal = (stageKey) => terminalKeys.has(stageKey) || ["won", "lost", "closed_won", "closed_lost"].includes(stageKey);
  const open = await models.SalesOpportunity.find({ workspaceId }).select("name ownerId stageKey value nextActionAt updatedAt").lean();
  const active = open.filter((o) => !isTerminal(o.stageKey));
  const unassigned = active.filter((o) => !o.ownerId);
  const missedFollowUp = active.filter((o) => o.nextActionAt && new Date(o.nextActionAt) < new Date());
  const stale = active.filter((o) => ageDays(o.updatedAt) >= 14 && !missedFollowUp.includes(o));
  const findings = [];
  if (unassigned.length) {
    const oldest = unassigned.reduce((max, o) => Math.max(max, ageDays(o.updatedAt) || 0), 0);
    findings.push(finding({
      id: "unassigned_opportunities", category: "pipeline", urgencyScore: clamp(45 + unassigned.length * 3, 0, 90),
      title: "Open opportunities with no owner", summary: `${unassigned.length} open opportunit${unassigned.length === 1 ? "y has" : "ies have"} no assigned owner.`,
      evidence: unassigned.slice(0, 5).map((o) => `${o.name} — $${o.value || 0}, stage ${o.stageKey}`),
      affectedRecords: unassigned.slice(0, 10).map((o) => ({ type: "opportunity", id: String(o._id), label: o.name })),
      oldestAgeDays: oldest, revenueImpact: unassigned.reduce((sum, o) => sum + (o.value || 0), 0), blocksWorkflow: true,
      recommendedAction: "Assign an owner to each unassigned opportunity so it gets worked.", links: [opportunitiesLink()],
    }));
  }
  if (missedFollowUp.length) {
    const oldest = missedFollowUp.reduce((max, o) => Math.max(max, ageDays(o.nextActionAt) || 0), 0);
    findings.push(finding({
      id: "missed_follow_ups", category: "pipeline", urgencyScore: clamp(55 + missedFollowUp.length * 4 + (oldest > 3 ? 15 : 0), 0, 95),
      title: "Missed follow-ups on open opportunities", summary: `${missedFollowUp.length} opportunit${missedFollowUp.length === 1 ? "y has" : "ies have"} a follow-up date that already passed.`,
      evidence: missedFollowUp.slice(0, 5).map((o) => `${o.name} — follow-up was due ${ageDays(o.nextActionAt)}d ago`),
      affectedRecords: missedFollowUp.slice(0, 10).map((o) => ({ type: "opportunity", id: String(o._id), label: o.name })),
      oldestAgeDays: oldest, revenueImpact: missedFollowUp.reduce((sum, o) => sum + (o.value || 0), 0), blocksWorkflow: true,
      recommendedAction: "Reach out and reschedule or complete these overdue follow-ups.", links: [opportunitiesLink()],
    }));
  }
  if (stale.length) {
    const oldest = stale.reduce((max, o) => Math.max(max, ageDays(o.updatedAt) || 0), 0);
    findings.push(finding({
      id: "stale_opportunities", category: "pipeline", urgencyScore: clamp(25 + stale.length * 2 + (oldest > 30 ? 20 : 0), 0, 85),
      title: "Opportunities with no activity in 14+ days", summary: `${stale.length} open opportunit${stale.length === 1 ? "y hasn't" : "ies haven't"} been touched in at least 14 days.`,
      evidence: stale.slice(0, 5).map((o) => `${o.name} — last updated ${ageDays(o.updatedAt)}d ago`),
      affectedRecords: stale.slice(0, 10).map((o) => ({ type: "opportunity", id: String(o._id), label: o.name })),
      oldestAgeDays: oldest, revenueImpact: stale.reduce((sum, o) => sum + (o.value || 0), 0), blocksWorkflow: false,
      recommendedAction: "Review these opportunities and either move them forward or mark them lost so the pipeline reflects reality.", links: [opportunitiesLink()],
    }));
  }
  return findings;
}

// 7/11. Failed replies, publishing, webhooks, automations, and agent-attributed failures
async function checkFailedAutomationRuns(workspaceId, models) {
  const runs = await models.AutomationActionRun.find({ workspaceId, status: { $in: ["failed", "uncertain"] }, createdAt: { $gte: daysAgo(14) } }).select("actionType agent provider status failureCategory createdAt targetType targetId").sort({ createdAt: -1 }).limit(100).lean();
  if (!runs.length) return null;
  const byType = new Map();
  for (const run of runs) { const key = run.actionType || "unknown"; byType.set(key, (byType.get(key) || 0) + 1); }
  const withAgent = runs.filter((r) => r.agent);
  const oldest = runs.reduce((max, r) => Math.max(max, ageDays(r.createdAt) || 0), 0);
  return finding({
    id: "failed_automation_runs", category: "system_health", urgencyScore: clamp(35 + runs.length * 2 + (withAgent.length ? 15 : 0), 0, 90),
    title: "Automated actions are failing", summary: `${runs.length} automation run${runs.length === 1 ? "" : "s"} failed or ended uncertain in the last 14 days${withAgent.length ? `, including ${withAgent.length} initiated by an AI agent` : ""}.`,
    evidence: [...byType.entries()].map(([type, n]) => `${type}: ${n} failure${n === 1 ? "" : "s"}`),
    affectedRecords: runs.slice(0, 10).map((r) => ({ type: "automation_run", id: String(r._id), label: `${r.actionType}${r.agent ? ` (${r.agent})` : ""} — ${r.failureCategory || r.status}` })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Open Social Settings to review failing automations and their failure reason before more attempts queue up.",
    links: [{ label: "Open Social Settings", url: "/social/settings" }],
  });
}

// 8. Failed or blocked Discovery research monitors
async function checkFailedMonitors(workspaceId, models) {
  const monitors = await models.ResearchMonitor.find({ workspaceId, enabled: true, $or: [{ lastRunStatus: "failed" }, { "sourceHealth.state": { $in: ["failed", "blocked"] } }] }).select("name lastRunStatus lastRunMessage lastRunAt sourceHealth").lean();
  if (!monitors.length) return null;
  const oldest = monitors.reduce((max, m) => Math.max(max, ageDays(m.lastRunAt) || 0), 0);
  return finding({
    id: "failed_research_monitors", category: "system_health", urgencyScore: clamp(30 + monitors.length * 8, 0, 80),
    title: "Discovery monitors are failing or blocked", summary: `${monitors.length} enabled Discovery monitor${monitors.length === 1 ? " is" : "s are"} failing or blocked, so new lead signals may be missed.`,
    evidence: monitors.slice(0, 5).map((m) => `${m.name}: ${m.lastRunStatus === "failed" ? m.lastRunMessage || "run failed" : (m.sourceHealth || []).filter((s) => ["failed", "blocked"].includes(s.state)).map((s) => `${s.source} ${s.state}`).join(", ")}`),
    affectedRecords: monitors.slice(0, 10).map((m) => ({ type: "research_monitor", id: String(m._id), label: m.name })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Review and fix or disable the failing monitor sources so Discovery keeps finding real signals.",
    links: [discoveryLink()],
  });
}

// 9. Recently created pipeline value with no attribution
async function checkMissingAttribution(workspaceId, models) {
  const recent = await models.SalesOpportunity.find({ workspaceId, createdAt: { $gte: daysAgo(60) }, value: { $gt: 0 }, "leadAttribution.source": { $in: ["", null] }, campaignId: null, "leadAttribution.socialProvider": { $in: ["", null] } }).select("name value primaryContactId createdAt").lean();
  if (!recent.length) return null;
  const contacts = await models.Contact.find({ _id: { $in: recent.map((o) => o.primaryContactId).filter(Boolean) } }).select("socialAttribution.first.provider sourceProvider").lean();
  const attributedContactIds = new Set(contacts.filter((c) => c.socialAttribution?.first?.provider || c.sourceProvider).map((c) => String(c._id)));
  const unattributed = recent.filter((o) => !o.primaryContactId || !attributedContactIds.has(String(o.primaryContactId)));
  if (!unattributed.length) return null;
  return finding({
    id: "missing_attribution", category: "attribution", urgencyScore: clamp(20 + unattributed.length * 3, 0, 65),
    title: "Recent pipeline value with no attributed source", summary: `${unattributed.length} opportunit${unattributed.length === 1 ? "y" : "ies"} created in the last 60 days can't be traced to a campaign, post, or referral.`,
    evidence: unattributed.slice(0, 5).map((o) => `${o.name} — $${o.value}, created ${ageDays(o.createdAt)}d ago`),
    affectedRecords: unattributed.slice(0, 10).map((o) => ({ type: "opportunity", id: String(o._id), label: o.name })),
    revenueImpact: unattributed.reduce((sum, o) => sum + (o.value || 0), 0), blocksWorkflow: false,
    recommendedAction: "Backfill the source for these deals so ROI reporting stays accurate.", links: [opportunitiesLink()],
  });
}

// 10. Inbound social/email threads sitting unread for 24h+
async function checkUnansweredThreads(workspaceId, models) {
  const threads = await models.ConversationThread.find({ workspaceId, status: "open", unreadCount: { $gt: 0 }, lastInboundAt: { $lte: daysAgo(1) } }).select("subject preview channel unreadCount lastInboundAt").sort({ lastInboundAt: 1 }).limit(50).lean();
  if (!threads.length) return null;
  const oldest = threads.reduce((max, t) => Math.max(max, ageDays(t.lastInboundAt) || 0), 0);
  return finding({
    id: "unanswered_threads", category: "engagement", urgencyScore: clamp(35 + threads.length * 3 + (oldest > 3 ? 20 : 0), 0, 90),
    title: "Inbound messages waiting more than 24 hours", summary: `${threads.length} conversation${threads.length === 1 ? "" : "s"} have an unread inbound message with no reply in over a day.`,
    evidence: threads.slice(0, 5).map((t) => `[${t.channel}] ${t.subject || t.preview || "message"} — waiting ${ageDays(t.lastInboundAt)}d`),
    affectedRecords: threads.slice(0, 10).map((t) => ({ type: "conversation_thread", id: String(t._id), label: t.subject || t.preview || "Conversation" })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Reply to these inbound messages before the prospect goes cold or the messaging window closes.",
    links: [socialLink()],
  });
}

// 11. Unreviewed applications
async function checkUnreviewedApplications(workspaceId, models) {
  const apps = await models.CoachingApplication.find({ workspaceId, status: "submitted", submittedAt: { $lte: daysAgo(3) } }).select("submittedAt").lean();
  if (!apps.length) return null;
  const oldest = apps.reduce((max, a) => Math.max(max, ageDays(a.submittedAt) || 0), 0);
  return finding({
    id: "unreviewed_applications", category: "pipeline", urgencyScore: clamp(45 + apps.length * 5 + (oldest > 7 ? 20 : 0), 0, 95),
    title: "Applications waiting for review", summary: `${apps.length} application${apps.length === 1 ? " has" : "s have"} been sitting unreviewed for 3+ days.`,
    evidence: [`Oldest application submitted ${oldest}d ago`],
    affectedRecords: apps.slice(0, 10).map((a) => ({ type: "coaching_application", id: String(a._id), label: `Submitted ${ageDays(a.submittedAt)}d ago` })),
    oldestAgeDays: oldest, blocksWorkflow: true,
    recommendedAction: "Review and accept or decline these applications so applicants aren't left waiting.",
    links: [applicationsLink()],
  });
}

// 12. Won sales not handed off to coaching
async function checkWonWithoutCoaching(workspaceId, models) {
  const wonKeys = new Set((await models.PipelineStage.find({ workspaceId, terminal: "won" }).select("key").lean()).map((s) => s.key));
  const won = await models.SalesOpportunity.find({ workspaceId, $or: [{ wonAt: { $ne: null } }, { stageKey: { $in: [...wonKeys, "won", "closed_won"] } }] }).select("name value primaryContactId wonAt updatedAt").lean();
  if (!won.length) return null;
  const enrolled = new Set((await models.Enrollment.find({ workspaceId, sourceOpportunityId: { $in: won.map((o) => o._id) } }).select("sourceOpportunityId").lean()).map((e) => String(e.sourceOpportunityId)));
  const missing = won.filter((o) => !enrolled.has(String(o._id)));
  if (!missing.length) return null;
  const oldest = missing.reduce((max, o) => Math.max(max, ageDays(o.wonAt || o.updatedAt) || 0), 0);
  return finding({
    id: "won_without_coaching", category: "handoff", urgencyScore: clamp(60 + missing.length * 5 + (oldest > 3 ? 20 : 0), 0, 98),
    title: "Won deals not yet enrolled in coaching", summary: `${missing.length} won opportunit${missing.length === 1 ? "y has" : "ies have"} no coaching enrollment on record.`,
    evidence: missing.slice(0, 5).map((o) => `${o.name} — won ${ageDays(o.wonAt || o.updatedAt)}d ago, $${o.value || 0}`),
    affectedRecords: missing.slice(0, 10).map((o) => ({ type: "opportunity", id: String(o._id), label: o.name })),
    oldestAgeDays: oldest, revenueImpact: missing.reduce((sum, o) => sum + (o.value || 0), 0), blocksWorkflow: true,
    recommendedAction: "Enroll these paying customers in their coaching program so onboarding doesn't stall right after they pay.",
    links: [coachingLink(), opportunitiesLink()],
  });
}

// 13. Unhealthy integrations: Meta, email, OpenAI
async function checkUnhealthyIntegrations(workspaceId, models) {
  const [integrations, socials, aiFailures] = await Promise.all([
    models.IntegrationConnection.find({ workspaceId, status: { $in: ["failed", "disconnected"] } }).select("provider status lastError").lean(),
    models.SocialConnection.find({ workspaceId, $or: [{ status: { $ne: "connected" } }, { expiresAt: { $lte: new Date() } }] }).select("provider status lastError expiresAt").lean(),
    models.AiUsageRecord.find({ workspaceId, success: false, createdAt: { $gte: daysAgo(2) } }).select("errorCategory errorCode agent createdAt").sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const problems = [
    ...integrations.map((i) => ({ label: `${i.provider}: ${i.status}${i.lastError ? ` — ${i.lastError}` : ""}`, kind: "integration" })),
    ...socials.map((s) => ({ label: `${s.provider} (social): ${s.status === "connected" ? "token expired" : s.status}${s.lastError ? ` — ${s.lastError}` : ""}`, kind: "social" })),
  ];
  if (aiFailures.length) {
    const byCategory = new Map();
    for (const record of aiFailures) { const key = record.errorCategory || record.errorCode || "unknown"; byCategory.set(key, (byCategory.get(key) || 0) + 1); }
    problems.push({ label: `OpenAI: ${aiFailures.length} failed call${aiFailures.length === 1 ? "" : "s"} in the last 48h (${[...byCategory.entries()].map(([k, n]) => `${k}: ${n}`).join(", ")})`, kind: "openai" });
  }
  if (!problems.length) return null;
  return finding({
    id: "unhealthy_integrations", category: "system_health", urgencyScore: clamp(50 + problems.length * 10, 0, 95),
    title: "Integrations are unhealthy", summary: `${problems.length} connected service${problems.length === 1 ? " is" : "s are"} failed, disconnected, expired, or erroring.`,
    evidence: problems.slice(0, 8).map((p) => p.label),
    affectedRecords: [...integrations, ...socials].slice(0, 10).map((c) => ({ type: "integration_connection", id: String(c._id), label: c.provider })),
    count: problems.length, blocksWorkflow: true,
    recommendedAction: "Reconnect or repair the affected integration before it silently blocks replies, publishing, or AI-assisted work.",
    links: [integrationsLink()],
  });
}

// 14. Unusual drop in lead volume
async function checkLeadVolumeDrop(workspaceId, models) {
  const [thisWeek, lastWeek] = await Promise.all([
    models.Contact.countDocuments({ workspaceId, createdAt: { $gte: daysAgo(7) } }),
    models.Contact.countDocuments({ workspaceId, createdAt: { $gte: daysAgo(14), $lt: daysAgo(7) } }),
  ]);
  if (lastWeek < 5) return null;
  const dropRatio = (lastWeek - thisWeek) / lastWeek;
  if (dropRatio < 0.3) return null;
  return finding({
    id: "lead_volume_drop", category: "trend", urgencyScore: clamp(40 + Math.round(dropRatio * 60), 0, 90),
    title: "New lead volume has dropped sharply", summary: `New contacts fell from ${lastWeek} to ${thisWeek} week-over-week, a ${Math.round(dropRatio * 100)}% drop.`,
    evidence: [`Prior 7 days: ${lastWeek} new contacts`, `Last 7 days: ${thisWeek} new contacts`],
    affectedRecords: [], count: 1, blocksWorkflow: false,
    recommendedAction: "Check Discovery monitors, social automations, and campaign delivery for anything that stopped running.",
    links: [discoveryLink(), { label: "Open Analytics", url: "/analytics" }],
  });
}

const CHECKS = [checkUnlinkedHighIntent, checkDuplicateContacts, checkIncompleteContacts, checkQualifiedWithoutOpportunity, checkOpportunityNeglect, checkFailedAutomationRuns, checkFailedMonitors, checkMissingAttribution, checkUnansweredThreads, checkUnreviewedApplications, checkWonWithoutCoaching, checkUnhealthyIntegrations, checkLeadVolumeDrop];

async function getLeadPipelineHealth(workspaceId, models = deps) {
  if (!workspaceId) throw Object.assign(new Error("workspaceId is required"), { code: "SYSTEM_AGENT_WORKSPACE_REQUIRED" });
  const results = await Promise.all(CHECKS.map((check) => check(workspaceId, models).catch((error) => {
    console.error(`[SystemAgent] health check failed: ${check.name}`, error);
    return null;
  })));
  const findings = results.flat().filter(Boolean).sort((a, b) => b.score - a.score);
  const summary = { total: findings.length, critical: findings.filter((f) => f.severity === "critical").length, high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length, blockingCount: findings.filter((f) => f.blocksWorkflow).length, revenueAtRisk: money(findings.reduce((sum, f) => sum + (f.revenueImpact || 0), 0)) };
  return { generatedAt: new Date().toISOString(), summary, findings };
}

module.exports = { getLeadPipelineHealth, _deps: deps };
