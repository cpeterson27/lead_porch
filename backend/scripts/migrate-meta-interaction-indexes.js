/* Explicit, opt-in index rollout. No model initialization, data repair or provider calls. */
const mongoose = require("mongoose");
const { isDeepStrictEqual } = require("node:util");

function targets() {
  // SocialConnection's `selectedAssetIds` index is intentionally NOT unique
  // (an Instagram business account may be selected through both Facebook
  // Login and Instagram Login — see "Restore simultaneous Meta and Instagram
  // routing"), and its lifecycle is now self-healing on every connect in
  // config/database.js, so it is not a target of this opt-in migration.
  const definitions = [
    [require("../models/CrmActivity"), { workspaceId: 1, "metadata.socialEventKey": 1 }, "metadata.socialEventKey"],
  ];
  return definitions.map(([model, key, field]) => {
    const definition = model.schema.indexes().find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(key));
    if (!definition?.[1]?.unique || !definition[1].partialFilterExpression) throw new Error("Required schema index definition is unavailable");
    const options = definition[1];
    return { collection: model.collection.name, key, field, options: { name: options.name || Object.entries(key).map(([name, direction]) => `${name}_${direction}`).join("_"), unique: true, partialFilterExpression: options.partialFilterExpression } };
  });
}

function malformedPipeline(target) {
  const field = `$${target.field}`;
  const validValue = target.field === "selectedAssetIds"
    ? { $cond: [{ $isArray: field }, { $allElementsTrue: [{ $map: { input: field, as: "asset", in: { $eq: [{ $type: "$$asset" }, "string"] } } }] }, false] }
    : { $eq: [{ $type: field }, "string"] };
  return [
    { $match: target.options.partialFilterExpression },
    { $match: { $expr: { $not: [{ $and: [{ $eq: [{ $type: "$workspaceId" }, "objectId"] }, validValue] }] } } },
    { $project: { _id: 1 } },
    { $facet: { total: [{ $count: "count" }], sample: [{ $limit: 20 }] } },
  ];
}

function duplicatesPipeline(target) {
  const selected = target.field === "selectedAssetIds";
  return [
    { $match: target.options.partialFilterExpression },
    ...(selected ? [
      { $unwind: "$selectedAssetIds" },
      // A repeated array element in ONE document is not a unique multikey violation.
      { $group: { _id: { workspaceId: "$workspaceId", value: "$selectedAssetIds", recordId: "$_id" } } },
      { $group: { _id: { workspaceId: "$_id.workspaceId", value: "$_id.value" }, count: { $sum: 1 }, firstRecordId: { $first: "$_id.recordId" }, lastRecordId: { $last: "$_id.recordId" } } },
    ] : [
      { $group: { _id: { workspaceId: "$workspaceId", value: "$metadata.socialEventKey" }, count: { $sum: 1 }, firstRecordId: { $first: "$_id" }, lastRecordId: { $last: "$_id" } } },
    ]),
    { $match: { count: { $gt: 1 } } },
    // Never print credentials, activity bodies, or the potentially sensitive event key.
    { $project: { _id: 0, workspaceId: "$_id.workspaceId", count: 1, firstRecordId: 1, lastRecordId: 1 } },
    { $facet: { total: [{ $count: "count" }], sample: [{ $limit: 20 }] } },
  ];
}

async function existingIndexes(collection) {
  try { return await collection.indexes(); }
  catch (error) { if (error.code === 26) return []; throw error; }
}
function indexState(indexes, target) {
  const sameKey = index => JSON.stringify(index.key) === JSON.stringify(target.key);
  const exact = indexes.find(index => sameKey(index) && index.unique === true &&
    isDeepStrictEqual(index.partialFilterExpression, target.options.partialFilterExpression) &&
    !index.sparse && !index.hidden && (!index.collation || index.collation.locale === "simple") &&
    (target.field !== "selectedAssetIds" || index.name === target.options.name));
  if (exact) return { status: "exists", name: exact.name };
  if (indexes.some(index => index.name === target.options.name || sameKey(index))) return { status: "conflict", reason: "An index with this name or key has different options. Manual review required; nothing will be dropped." };
  return { status: "missing" };
}
async function summary(collection, pipeline) {
  const [result] = await collection.aggregate(pipeline, { allowDiskUse: false, maxTimeMS: 60000, collation: { locale: "simple" } }).toArray();
  return { count: result?.total?.[0]?.count || 0, sample: result?.sample || [] };
}
async function migrate(db, { apply = false } = {}) {
  const report = { mode: apply ? "apply" : "preflight", ready: false, indexes: [] };
  const plans = targets();
  // Inspect BOTH collections completely before creating EITHER index.
  for (const target of plans) {
    const collection = db.collection(target.collection);
    let options = {};
    try { options = await collection.options(); } catch (error) { if (error.code !== 26) throw error; }
    const malformed = await summary(collection, malformedPipeline(target));
    const duplicates = malformed.count ? { count: 0, sample: [], skipped: true } : await summary(collection, duplicatesPipeline(target));
    const index = indexState(await existingIndexes(collection), target);
    report.indexes.push({ collection: target.collection, key: target.key, options: target.options, index, malformed, duplicates, ...(options.collation && options.collation.locale !== "simple" ? { blocker: "Non-simple collection collation requires manual review" } : {}) });
  }
  report.ready = report.indexes.every(row => !row.blocker && !row.malformed.count && !row.duplicates.count && row.index.status !== "conflict");
  if (!report.ready || !apply) return report;
  for (const [position, target] of plans.entries()) {
    const row = report.indexes[position], collection = db.collection(target.collection);
    if (row.index.status === "exists") { row.result = "unchanged"; continue; }
    try {
      await collection.createIndex(target.key, target.options);
      if (indexState(await existingIndexes(collection), target).status !== "exists") throw new Error("INDEX_VERIFICATION_FAILED");
      row.result = "created_and_verified";
    } catch (error) {
      row.result = "failed";
      row.error = { code: typeof error.code === "number" ? error.code : "INDEX_CREATION_FAILED", message: "Index creation or verification failed. Data may have changed after preflight. Re-run preflight and inspect indexes; no records were repaired and no indexes were dropped." };
      report.ready = false;
      break;
    }
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--apply", "--preflight"].includes(arg)) || (args.includes("--apply") && args.includes("--preflight"))) throw new Error("Use --preflight (default) OR --apply");
  require("dotenv").config({ quiet: true });
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI must be configured securely");
  // Native driver avoids Mongoose autoCreate/autoIndex and workspace middleware.
  const client = new mongoose.mongo.MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const report = await migrate(client.db(), { apply: args.includes("--apply") });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } finally { await client.close(); }
}
if (require.main === module) main().catch(() => {
  // Driver errors can contain connection strings or duplicate key values.
  console.error("Meta index migration stopped. Verify arguments, secure MONGO_URI, connectivity and database permissions. No automatic repair is performed.");
  process.exitCode = 1;
});
module.exports = { targets, malformedPipeline, duplicatesPipeline, indexState, migrate };
