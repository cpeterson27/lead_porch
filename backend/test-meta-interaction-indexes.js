const assert = require("node:assert/strict");
const { migrate, targets, duplicatesPipeline, malformedPipeline } = require("./scripts/migrate-meta-interaction-indexes");
const definitions = targets();
function fixture(rows = {}, indexes = {}, failCollection = null) {
  const creates = [], reads = [];
  const stored = Object.fromEntries(definitions.map(target => [target.collection, [...(indexes[target.collection] || [{ name: "_id_", key: { _id: 1 } }, { name: "unrelated", key: { unrelated: 1 } }])]]));
  return {
    creates, stored, reads,
    collection(name) {
      const target = definitions.find(item => item.collection === name);
      return {
        options: async () => ({}),
        indexes: async () => stored[name],
        aggregate(pipeline, options) {
          reads.push(name);
          assert.deepEqual(pipeline[0].$match, target.options.partialFilterExpression);
          assert.equal(options.allowDiskUse, false);
          assert(!pipeline.some(stage => stage.$out || stage.$merge));
          const malformed = Boolean(pipeline[1].$match?.$expr);
          assert.deepEqual(pipeline, malformed ? malformedPipeline(target) : duplicatesPipeline(target));
          const groups = new Map();
          if (!malformed) for (const row of rows[name] || []) {
            const values = typeof row.eventKey === "string" ? [row.eventKey] : [];
            for (const value of values) {
              const key = JSON.stringify([row.workspaceId, value]);
              groups.set(key, [...(groups.get(key) || []), row]);
            }
          }
          const duplicates = [...groups.values()].filter(items => items.length > 1).map(items => ({ workspaceId: items[0].workspaceId, count: items.length, firstRecordId: items[0]._id, lastRecordId: items.at(-1)._id }));
          return { toArray: async () => [{ total: duplicates.length ? [{ count: duplicates.length }] : [], sample: duplicates.slice(0, 20) }] };
        },
        createIndex: async (key, options) => {
          assert.equal(reads.length, 2, "The collection preflight must finish before any create");
          creates.push(name);
          if (name === failCollection) throw Object.assign(Error("Sensitive duplicate key"), { code: 11000 });
          stored[name].push({ key, ...options });
          return options.name;
        },
      };
    },
  };
}
async function run() {
  // SocialConnection's selectedAssetIds index is intentionally non-unique
  // (see "Restore simultaneous Meta and Instagram routing") and self-heals
  // in config/database.js on every connect, so it is no longer a target of
  // this opt-in migration — only CrmActivity's socialEventKey index is.
  assert.equal(definitions.length, 1);
  const [activity] = definitions;
  assert.deepEqual(activity.options.partialFilterExpression, { "metadata.socialEventKey": { $type: "string" } });
  const rows = {
    [activity.collection]: [{ _id: "c", workspaceId: "w", eventKey: "event" }, { _id: "d", workspaceId: "other", eventKey: "event" }],
  };
  let db = fixture(rows);
  assert.equal((await migrate(db)).ready, true); assert.equal(db.creates.length, 0, "Preflight never creates");
  db = fixture(rows);
  let result = await migrate(db, { apply: true });
  assert.equal(result.ready, true); assert.equal(db.creates.length, 1);
  result = await migrate(db, { apply: true });
  assert.equal(result.ready, true); assert.equal(db.creates.length, 1, "Repeated apply makes no changes");
  assert(result.indexes.every(row => row.result === "unchanged"));
  assert(Object.values(db.stored).every(list => list.some(index => index.name === "unrelated")));
  for (const target of definitions) {
    const duplicateRows = structuredClone(rows);
    duplicateRows[target.collection].push({ ...duplicateRows[target.collection][0], _id: "duplicate" });
    db = fixture(duplicateRows);
    result = await migrate(db, { apply: true });
    assert.equal(result.ready, false); assert.equal(db.creates.length, 0);
    assert.equal(result.indexes.find(row => row.collection === target.collection).duplicates.count, 1);
    assert(!JSON.stringify(result).includes('"event"'), "Duplicate event keys are not printed");
  }
  db = fixture({}, Object.fromEntries(definitions.map(target => [target.collection, [{ key: target.key, ...target.options }]])));
  assert.equal((await migrate(db, { apply: true })).ready, true); assert.equal(db.creates.length, 0);
  db = fixture({}, {}, activity.collection);
  result = await migrate(db, { apply: true });
  assert.equal(result.ready, false); assert.equal(result.indexes[0].result, "failed");
  assert(!JSON.stringify(result).includes("Sensitive duplicate key"));
  console.log("Meta index migration tests passed: read-only preflight, duplicate detection, workspace separation, existing indexes, repeated apply, unrelated-index preservation and creation failure.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
