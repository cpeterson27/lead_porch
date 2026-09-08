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
    return connection;
  });
}

module.exports = { connectDatabase };
