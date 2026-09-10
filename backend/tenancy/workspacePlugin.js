const mongoose = require("mongoose");
const { currentWorkspaceId } = require("./workspaceContext");

const QUERY_OPERATIONS = ["countDocuments", "deleteMany", "deleteOne", "distinct", "find", "findOne", "findOneAndDelete", "findOneAndReplace", "findOneAndUpdate", "replaceOne", "updateMany", "updateOne"];

function enforcementEnabled() {
  return String(process.env.TENANT_QUERY_ENFORCEMENT || "enabled").toLowerCase() !== "disabled";
}

/** The database name MONGO_URI (production) resolves to, or null if unparseable/unset. */
function productionDbName() {
  if (!process.env.MONGO_URI) return null;
  try {
    const normalized = process.env.MONGO_URI.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://");
    return new URL(normalized).pathname.replace(/^\//, "").split("?")[0] || null;
  } catch {
    return null;
  }
}

function scopeWorkspaceUpdate(update, workspaceId) {
  if (!update) return update;
  if (update.$set) {
    // MongoDB rejects the same path in $set and $setOnInsert. Upserts commonly
    // place immutable ownership in $setOnInsert, so normalize it there rather
    // than creating a conflicting $set.workspaceId path.
    if (update.$setOnInsert && Object.prototype.hasOwnProperty.call(update.$setOnInsert, "workspaceId")) update.$setOnInsert.workspaceId = workspaceId;
    else update.$set.workspaceId = workspaceId;
  } else if (update.$setOnInsert) update.$setOnInsert.workspaceId = workspaceId;
  else if (!Object.keys(update).some((key) => key.startsWith("$"))) update.workspaceId = workspaceId;
  return update;
}

function workspacePlugin(schema) {
  if (!schema.path("workspaceId")) {
    schema.add({
      workspaceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Workspace",
        default: null,
        index: true,
      },
    });
  }

  schema.pre(QUERY_OPERATIONS, function scopeWorkspaceQuery() {
    const workspaceId = currentWorkspaceId();
    if (!workspaceId || !enforcementEnabled()) return;
    this.where({ workspaceId });
    const update = this.getUpdate?.();
    if (!update) return;
    this.setUpdate(scopeWorkspaceUpdate(update, workspaceId));
  });

  // On 2026-09-10, test-jarvis.js/test-jarvis-actions.js ran
  // Contact/Organization/OrganizationRelationship/Audience/
  // MarketingCampaign.deleteMany({}) with no filter at all, outside any
  // request context, against the production database — wiping every
  // workspace's data in those collections at once. This refuses that exact
  // pattern against production specifically: an empty-filter bulk write
  // with no workspace context is almost never legitimate application
  // behavior (real code always scopes by workspace, by ID, or runs inside
  // runWithWorkspace()). A connection that's positively confirmed to be a
  // DIFFERENT database than MONGO_URI (e.g. a real, separate test database)
  // is exempt — wiping its own collections for test hygiene is legitimate
  // there. Any case where that can't be positively confirmed fails closed
  // (refuses), rather than assuming safety.
  schema.pre(["deleteMany", "updateMany"], function refuseUnscopedBulkWrite() {
    const workspaceId = currentWorkspaceId();
    const conditions = this.getQuery();
    const hasAnyCondition = conditions && Object.keys(conditions).length > 0;
    if (workspaceId || hasAnyCondition || !enforcementEnabled()) return;

    const activeDbName = this.model.db?.name || this.model.db?.databaseName || "";
    const prodDbName = productionDbName();
    const confirmedDifferentDatabase = Boolean(prodDbName) && Boolean(activeDbName) && activeDbName !== prodDbName;
    if (confirmedDifferentDatabase) return;

    throw new Error(
      `Refusing to run ${this.op}({}) with no filter and no workspace context on ${this.model.modelName} ` +
      `(database "${activeDbName || "unknown"}"). This is almost always a bug (e.g. unscoped test cleanup) ` +
      "that would wipe every workspace's data at once. Pass an explicit filter, wrap the call in " +
      "runWithWorkspace(), or connect to a database other than MONGO_URI's for tests.",
    );
  });

  schema.pre("aggregate", function scopeWorkspaceAggregate() {
    const workspaceId = currentWorkspaceId();
    if (!workspaceId || !enforcementEnabled()) return;
    const match = { workspaceId: new mongoose.Types.ObjectId(workspaceId) };
    this.pipeline().splice(this.pipeline()[0]?.$geoNear ? 1 : 0, 0, { $match: match });
  });

  schema.pre("validate", function assignWorkspaceToDocument() {
    const workspaceId = currentWorkspaceId();
    if (workspaceId) this.workspaceId = workspaceId;
  });

  schema.pre("insertMany", function assignWorkspaceToMany(documents) {
    const workspaceId = currentWorkspaceId();
    if (workspaceId) {
      for (const document of documents || []) document.workspaceId = workspaceId;
    }
  });
}

module.exports = workspacePlugin;
module.exports.scopeWorkspaceUpdate = scopeWorkspaceUpdate;
