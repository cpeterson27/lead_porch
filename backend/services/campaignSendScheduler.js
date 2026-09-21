const Campaign = require("../models/Campaign");
const { sendApprovedOutreachForCampaign } = require("./scheduledCampaignSendService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

let timer = null;
let running = false;

async function runDueCampaignSends() {
  if (running) return [];
  running = true;
  try {
    const due = await Campaign.find({
      scheduledSendAt: { $lte: new Date() },
      scheduledSendCompletedAt: null,
    }).select("_id workspaceId scheduledSendDeliveryPurpose");
    const results = [];
    for (const campaign of due) {
      // Claimed atomically (findOneAndUpdate, not just the find above) so
      // two overlapping poller ticks — or a poller restart mid-run — can
      // never send the same scheduled campaign twice.
      // acceptingDiscoveryLeads goes false in this same atomic claim — the
      // instant a campaign's send fires is exactly when it should stop
      // absorbing new Discovery leads (see discoveryAutoEnrollmentService's
      // findActiveCampaign), whether or not the send itself succeeds.
      const claimed = await Campaign.findOneAndUpdate(
        { _id: campaign._id, scheduledSendCompletedAt: null },
        { $set: { scheduledSendCompletedAt: new Date(), acceptingDiscoveryLeads: false } },
        { new: false },
      );
      if (!claimed) continue;
      try {
        const result = await runWithWorkspace(campaign.workspaceId, () =>
          sendApprovedOutreachForCampaign(campaign._id, { deliveryPurpose: campaign.scheduledSendDeliveryPurpose || "marketing" }));
        await Campaign.updateOne({ _id: campaign._id }, { $set: { scheduledSendResult: { ...result, completedAt: new Date() } } });
        results.push({ campaignId: campaign._id, ...result });
      } catch (error) {
        await Campaign.updateOne({ _id: campaign._id }, { $set: { scheduledSendResult: { error: error.message || "Scheduled send failed", completedAt: new Date() } } });
        console.error("Scheduled campaign send failed:", { campaignId: String(campaign._id), message: error.message });
      }
    }
    return results;
  } finally {
    running = false;
  }
}

function startCampaignSendScheduler({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(15000, Number(process.env.CAMPAIGN_SEND_SCHEDULER_INTERVAL_MS) || 60000);
  timer = setInterval(() => runDueCampaignSends().catch((error) => console.error("Campaign send scheduler failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}

function stopCampaignSendScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runDueCampaignSends, startCampaignSendScheduler, stopCampaignSendScheduler };
