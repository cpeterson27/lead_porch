require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const now = Date.now();
  const daysAgo = (days) => new Date(now - days * 86400000);
  const activities = db.collection("monitoractivities");
  const signals = db.collection("intentsignals");
  const monitors = db.collection("researchmonitors");
  const [activityTotal, activity30, activity7, signalTotal, signal30, signal7, enabledMonitors, signalStatuses, signalBuckets, dateRanges, manualSignals, opportunitySignalIds, draftSignalIds] = await Promise.all([
    activities.countDocuments({}), activities.countDocuments({ createdAt: { $lt: daysAgo(30) } }), activities.countDocuments({ createdAt: { $lt: daysAgo(7) } }),
    signals.countDocuments({}), signals.countDocuments({ createdAt: { $lt: daysAgo(30) } }), signals.countDocuments({ createdAt: { $lt: daysAgo(7) } }),
    monitors.countDocuments({ enabled: true }),
    signals.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
    signals.aggregate([{ $group: { _id: "$bucket", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
    Promise.all([
      activities.aggregate([{ $group: { _id: null, oldest: { $min: "$createdAt" }, newest: { $max: "$createdAt" } } }]).toArray(),
      signals.aggregate([{ $group: { _id: null, oldest: { $min: "$createdAt" }, newest: { $max: "$createdAt" } } }]).toArray(),
    ]),
    signals.countDocuments({ manualBucketOverride: { $ne: null } }),
    db.collection("sales_opportunities").distinct("leadQualification.sourceSignalId", { "leadQualification.sourceSignalId": { $ne: null } }),
    db.collection("intentemaildrafts").distinct("signalId", { signalId: { $ne: null } }),
  ]);
  const protectedIds = [...new Set([...opportunitySignalIds, ...draftSignalIds].filter(Boolean).map(String))];
  const disposableRejectedFilter = {
    bucket: "rejected",
    status: { $nin: ["qualified", "converted", "reviewing"] },
    $or: [{ manualBucketOverride: null }, { manualBucketOverride: { $exists: false } }],
    ...(protectedIds.length ? { _id: { $nin: protectedIds.map((id) => new mongoose.Types.ObjectId(id)) } } : {}),
  };
  const disposableRejected = await signals.countDocuments(disposableRejectedFilter);
  console.log(JSON.stringify({
    monitors: { enabled: enabledMonitors },
    monitorActivities: { total: activityTotal, olderThan30Days: activity30, olderThan7Days: activity7, range: dateRanges[0][0] || {} },
    intentSignals: { total: signalTotal, olderThan30Days: signal30, olderThan7Days: signal7, statuses: signalStatuses, buckets: signalBuckets, manuallyReviewed: manualSignals, linkedToOpportunityOrDraft: protectedIds.length, disposableRejected, range: dateRanges[1][0] || {} },
  }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
