const Campaign = require("../models/Campaign");
const Outreach = require("../models/Outreach");
const { sendApprovedOutreachForCampaign } = require("./scheduledCampaignSendService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

let timer = null;
let running = false;
let sweepTimer = null;
let sweeping = false;

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
        { $set: { scheduledSendCompletedAt: new Date(), acceptingDiscoveryLeads: false, status: "completed" } },
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

// Confirmed live: CAMPAIGN KIT 01 matched 728 recipients, sent 101 (the
// hourly rate cap), and then sat there with 627 approved-but-unsent drafts
// forever — runDueCampaignSends only ever fires ONCE per campaign
// (scheduledSendCompletedAt gets set on that first claim, permanently), so
// nothing else was watching for capacity to free up and finish the job. This
// sweep is that missing piece: it finds every campaign that currently has
// any "approved" draft — regardless of the campaign's own status or whether
// its one-shot scheduled trigger already fired — and re-attempts them,
// naturally self-limiting through the same hourly cap in services/email.js.
// A draft only leaves "approved" here by actually sending or by a genuine
// (non-rate-limit) failure; a rate-limited attempt is left "approved" by
// scheduledCampaignSendService.js specifically so this sweep picks it back
// up on its next pass, with no manual re-approval required.
async function runApprovedOutreachSweep() {
  if (sweeping) return [];
  sweeping = true;
  try {
    const campaignIds = await Outreach.distinct("campaignId", { status: "approved" });
    const results = [];
    for (const campaignId of campaignIds) {
      const campaign = await Campaign.findById(campaignId).select("workspaceId");
      if (!campaign) continue;
      try {
        const result = await runWithWorkspace(campaign.workspaceId, () =>
          sendApprovedOutreachForCampaign(campaignId, { deliveryPurpose: "business_prospecting" }));
        results.push({ campaignId, ...result });
      } catch (error) {
        console.error("Approved outreach sweep failed for campaign:", { campaignId: String(campaignId), message: error.message });
      }
    }
    return results;
  } finally {
    sweeping = false;
  }
}

function startApprovedOutreachSweep({ force = false } = {}) {
  if (sweepTimer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return sweepTimer;
  const interval = Math.max(60000, Number(process.env.APPROVED_OUTREACH_SWEEP_INTERVAL_MS) || 15 * 60000);
  sweepTimer = setInterval(() => runApprovedOutreachSweep().catch((error) => console.error("Approved outreach sweep failed:", error.message)), interval);
  sweepTimer.unref?.();
  return sweepTimer;
}

function stopApprovedOutreachSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  runDueCampaignSends,
  startCampaignSendScheduler,
  stopCampaignSendScheduler,
  runApprovedOutreachSweep,
  startApprovedOutreachSweep,
  stopApprovedOutreachSweep,
};
