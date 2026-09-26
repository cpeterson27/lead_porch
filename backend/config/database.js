const mongoose = require("mongoose");

function connectDatabase(uri) {
  return mongoose.connect(uri).then(async (connection) => {
    const collection = connection.connection.collection("socialconnections");
    const indexes = await collection.indexes().catch((error) => {
      if (error.code === 26) return [];
      throw error;
    });
    const exclusive = indexes.find(
      (index) => index.name === "workspace_selected_social_asset" && index.unique,
    );
    if (exclusive) await collection.dropIndex(exclusive.name);
    const refreshed = exclusive ? await collection.indexes() : indexes;
    if (!refreshed.some((index) => index.name === "workspace_selected_social_asset_routes"))
      await collection.createIndex(
        { workspaceId: 1, selectedAssetIds: 1 },
        {
          name: "workspace_selected_social_asset_routes",
          partialFilterExpression: { "selectedAssetIds.0": { $exists: true } },
        },
      );

    // Keep the outreach dashboard's two hottest queries indexed even when
    // Mongoose auto-index creation is disabled in production. createIndex is
    // idempotent when the same name and definition already exist.
    const outreach = connection.connection.collection("outreaches");
    await outreach.createIndex(
      { workspaceId: 1, campaignId: 1, createdAt: -1 },
      { name: "workspace_campaign_created_at", background: true },
    );
    await outreach.createIndex(
      { workspaceId: 1, retryOf: 1, createdAt: -1 },
      { name: "workspace_retry_created_at", background: true },
    );
    // Required for retry deduplication and automatic analytics retention.
    await require("../models/SiteTrafficEvent").createIndexes();
    return connection;
  });
}

module.exports = { connectDatabase };
