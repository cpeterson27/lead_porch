const IntegrationConnection = require("../models/IntegrationConnection");
const Testimonial = require("../models/Testimonial");
const service = require("./googleBusinessProfileService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

const SIX_HOURS = 6 * 60 * 60 * 1000;
let timer = null;

async function syncConnectedProfiles() {
  const connections = await IntegrationConnection.find({ provider: service.PROVIDER, accountScope: "workspace", status: "connected", "settings.locationName": { $ne: "" } }).select("workspaceId settings.lastSyncedAt").lean();
  for (const connection of connections) {
    await runWithWorkspace(connection.workspaceId, () => Testimonial.deleteMany({
      workspaceId: connection.workspaceId,
      source: service.PROVIDER,
      lastSyncedAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    }));
    const lastSync = new Date(connection.settings?.lastSyncedAt || 0).getTime();
    if (Date.now() - lastSync < SIX_HOURS - 60000) continue;
    try {
      await runWithWorkspace(connection.workspaceId, () => service.syncReviews(connection.workspaceId));
    } catch (error) {
      await runWithWorkspace(connection.workspaceId, () => IntegrationConnection.updateOne({ _id: connection._id, workspaceId: connection.workspaceId }, { $set: { lastError: String(error.message || "Google review sync failed").slice(0, 1000) } }));
      console.error("Google Business Profile review sync failed:", error.message);
    }
  }
}

function startGoogleBusinessProfileSyncRunner() {
  if (timer) return timer;
  const initial = setTimeout(() => syncConnectedProfiles().catch((error) => console.error("Google Business Profile sync runner failed:", error.message)), 2 * 60 * 1000);
  initial.unref?.();
  timer = setInterval(() => syncConnectedProfiles().catch((error) => console.error("Google Business Profile sync runner failed:", error.message)), 30 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { startGoogleBusinessProfileSyncRunner, syncConnectedProfiles };
