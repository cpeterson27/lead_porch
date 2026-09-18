const mongoose = require("mongoose");
const MonitorActivity = require("../models/MonitorActivity");
const IntentSignal = require("../models/IntentSignal");
const SalesOpportunity = require("../models/SalesOpportunity");
const IntentEmailDraft = require("../models/IntentEmailDraft");
const InAppNotification = require("../models/InAppNotification");

const ACTIVITY_DAYS = Math.max(7, Number(process.env.MONITOR_ACTIVITY_RETENTION_DAYS) || 30);
const ACTIVITY_MAX = Math.max(1000, Number(process.env.MONITOR_ACTIVITY_MAX_PER_WORKSPACE) || 5000);
const REJECTED_DAYS = Math.max(1, Number(process.env.REJECTED_SIGNAL_RETENTION_DAYS) || 7);
const REJECTED_MAX = Math.max(1000, Number(process.env.REJECTED_SIGNAL_MAX_PER_WORKSPACE) || 5000);
const CONFIRMATION = "DELETE DISPOSABLE MONITOR HISTORY";
let timer = null;

function laterDate(a, b) { return a > b ? a : b; }

async function capBoundary(Model, filter, maxRows, dateField) {
  const row = await Model.findOne(filter).sort({ [dateField]: -1, _id: -1 }).skip(maxRows - 1).select(`${dateField} _id`).lean();
  return row?.[dateField] ? new Date(row[dateField]) : null;
}

async function protectedSignalIds(workspaceId, models) {
  const [opportunityPrimary, opportunityAttribution, drafts, notifications] = await Promise.all([
    models.SalesOpportunity.distinct("leadQualification.sourceSignalId", { workspaceId, "leadQualification.sourceSignalId": { $ne: null } }),
    models.SalesOpportunity.distinct("leadAttribution.signalId", { workspaceId, "leadAttribution.signalId": { $ne: null } }),
    models.IntentEmailDraft.distinct("signalId", { workspaceId, signalId: { $ne: null } }),
    models.InAppNotification.distinct("signalId", { workspaceId, signalId: { $ne: null } }),
  ]);
  return [...new Set([...opportunityPrimary, ...opportunityAttribution, ...drafts, ...notifications].filter(Boolean).map(String))]
    .filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
}

async function plan({ workspaceId, now = new Date() }, customModels = {}) {
  const models = { MonitorActivity, IntentSignal, SalesOpportunity, IntentEmailDraft, InAppNotification, ...customModels };
  const activityAgeBoundary = new Date(now.getTime() - ACTIVITY_DAYS * 86400000);
  const activityCapBoundary = await capBoundary(models.MonitorActivity, { workspaceId }, ACTIVITY_MAX, "createdAt");
  const activityBoundary = activityCapBoundary ? laterDate(activityAgeBoundary, activityCapBoundary) : activityAgeBoundary;
  const activityFilter = { workspaceId, createdAt: { $lt: activityBoundary } };

  const protectedIds = await protectedSignalIds(workspaceId, models);
  const signalBaseFilter = {
    workspaceId,
    $or: [{ bucket: "rejected" }, { status: "dismissed" }],
    status: { $nin: ["qualified", "converted", "reviewing"] },
    $and: [{ $or: [{ manualBucketOverride: null }, { manualBucketOverride: { $exists: false } }] }],
    ...(protectedIds.length ? { _id: { $nin: protectedIds } } : {}),
  };
  const signalAgeBoundary = new Date(now.getTime() - REJECTED_DAYS * 86400000);
  const signalCapBoundary = await capBoundary(models.IntentSignal, signalBaseFilter, REJECTED_MAX, "createdAt");
  const signalBoundary = signalCapBoundary ? laterDate(signalAgeBoundary, signalCapBoundary) : signalAgeBoundary;
  const signalFilter = { ...signalBaseFilter, createdAt: { $lt: signalBoundary } };

  const [activityTotal, activityDelete, signalTotal, signalDelete, protectedQualified, protectedManual] = await Promise.all([
    models.MonitorActivity.countDocuments({ workspaceId }), models.MonitorActivity.countDocuments(activityFilter),
    models.IntentSignal.countDocuments({ workspaceId }), models.IntentSignal.countDocuments(signalFilter),
    models.IntentSignal.countDocuments({ workspaceId, status: { $in: ["qualified", "converted", "reviewing"] } }),
    models.IntentSignal.countDocuments({ workspaceId, manualBucketOverride: { $ne: null } }),
  ]);
  return {
    policy: { activityRetentionDays: ACTIVITY_DAYS, activityMaximum: ACTIVITY_MAX, rejectedSignalRetentionDays: REJECTED_DAYS, rejectedSignalMaximum: REJECTED_MAX },
    monitorActivities: { total: activityTotal, eligibleForDeletion: activityDelete, retained: activityTotal - activityDelete },
    intentSignals: { total: signalTotal, eligibleForDeletion: signalDelete, retained: signalTotal - signalDelete, protectedQualified, protectedManual, protectedLinked: protectedIds.length },
    contactsAffected: 0,
    filters: { activityFilter, signalFilter },
  };
}

async function execute({ workspaceId, confirmation, now = new Date() }, customModels = {}) {
  if (confirmation !== CONFIRMATION) throw new Error(`Type ${CONFIRMATION} to confirm cleanup`);
  const models = { MonitorActivity, IntentSignal, SalesOpportunity, IntentEmailDraft, InAppNotification, ...customModels };
  const preview = await plan({ workspaceId, now }, models);
  const [activities, signals] = await Promise.all([
    models.MonitorActivity.deleteMany(preview.filters.activityFilter),
    models.IntentSignal.deleteMany(preview.filters.signalFilter),
  ]);
  return { preview: { ...preview, filters: undefined }, deleted: { monitorActivities: activities.deletedCount || 0, intentSignals: signals.deletedCount || 0, contacts: 0 } };
}

async function runAllWorkspaces() {
  const workspaceIds = [...new Set([...(await MonitorActivity.distinct("workspaceId")), ...(await IntentSignal.distinct("workspaceId"))].filter(Boolean).map(String))];
  const results = [];
  for (const workspaceId of workspaceIds) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await execute({ workspaceId, confirmation: CONFIRMATION }));
  }
  return results;
}

function startMonitorRetentionRunner() {
  if (timer || process.env.MONITOR_RETENTION_ENABLED === "false") return timer;
  const run = () => runAllWorkspaces().then((results) => {
    const deleted = results.reduce((sum, item) => sum + item.deleted.monitorActivities + item.deleted.intentSignals, 0);
    if (deleted) console.log(`Monitor retention removed ${deleted} disposable record(s).`);
  }).catch((error) => console.error("Monitor retention failed:", error.message));
  const initial = setTimeout(run, 60000); initial.unref?.();
  timer = setInterval(run, 24 * 60 * 60 * 1000); timer.unref?.();
  return timer;
}

module.exports = { ACTIVITY_DAYS, ACTIVITY_MAX, REJECTED_DAYS, REJECTED_MAX, CONFIRMATION, plan, execute, runAllWorkspaces, startMonitorRetentionRunner };
