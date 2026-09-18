const assert = require("assert");
const mongoose = require("mongoose");
const retention = require("./services/monitorRetentionService");

function queryResult(value) {
  const query = { sort: () => query, skip: () => query, select: () => query, lean: async () => value };
  return query;
}

function fakeModels() {
  const deleted = {};
  const linkedId = new mongoose.Types.ObjectId();
  return {
    deleted,
    linkedId,
    MonitorActivity: {
      findOne: () => queryResult(null),
      countDocuments: async (filter) => (filter.createdAt ? 90 : 100),
      deleteMany: async (filter) => { deleted.activities = filter; return { deletedCount: 90 }; },
    },
    IntentSignal: {
      findOne: () => queryResult(null),
      countDocuments: async (filter) => {
        if (filter.createdAt) return 70;
        if (filter.status?.$in) return 4;
        if (filter.manualBucketOverride) return 3;
        return 80;
      },
      deleteMany: async (filter) => { deleted.signals = filter; return { deletedCount: 70 }; },
    },
    SalesOpportunity: { distinct: async (path) => (path === "leadQualification.sourceSignalId" ? [linkedId] : []) },
    IntentEmailDraft: { distinct: async () => [] },
    InAppNotification: { distinct: async () => [] },
  };
}

(async () => {
  const workspaceId = new mongoose.Types.ObjectId();
  const models = fakeModels();
  const preview = await retention.plan({ workspaceId, now: new Date("2026-09-17T12:00:00Z") }, models);
  assert.strictEqual(preview.contactsAffected, 0);
  assert.strictEqual(preview.monitorActivities.eligibleForDeletion, 90);
  assert.strictEqual(preview.intentSignals.eligibleForDeletion, 70);
  assert(preview.filters.signalFilter._id.$nin.some((id) => String(id) === String(models.linkedId)));
  assert.deepStrictEqual(preview.filters.signalFilter.status.$nin, ["qualified", "converted", "reviewing"]);
  assert(preview.filters.signalFilter.$and);
  await assert.rejects(retention.execute({ workspaceId, confirmation: "yes" }, models), /DELETE DISPOSABLE MONITOR HISTORY/);
  assert.strictEqual(models.deleted.activities, undefined);
  const result = await retention.execute({ workspaceId, confirmation: retention.CONFIRMATION }, models);
  assert.deepStrictEqual(result.deleted, { monitorActivities: 90, intentSignals: 70, contacts: 0 });
  assert(models.deleted.activities.createdAt.$lt instanceof Date);
  assert(models.deleted.signals.createdAt.$lt instanceof Date);
  console.log("Monitor retention safety tests passed.");
})().catch((error) => { console.error(error); process.exit(1); });
