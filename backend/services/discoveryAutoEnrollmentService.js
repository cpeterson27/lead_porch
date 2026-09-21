const GroundingResearchResult = require("../models/GroundingResearchResult");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const { qualifyAndRecommend } = require("./leadGenerationCoordinatorService");
const { saveResult } = require("./vertexGroundingDiscoveryService");
const { regenerateCampaignOutreach } = require("./outreachGenerationService");

// qualifyAndRecommend() itself caps a single call at 20 result ids.
const GRADE_BATCH_SIZE = 20;

/**
 * The one campaign currently "open" for new Discovery leads: whichever
 * campaign has an upcoming scheduled send that hasn't gone out yet,
 * picking the soonest if more than one qualifies. The moment a campaign
 * actually sends (services/campaignSendScheduler.js sets
 * scheduledSendCompletedAt), it stops matching this query on its own —
 * no separate "turn off" step needed. Returns null when nothing is
 * currently open, which is the caller's signal to import straight to
 * the CRM with no campaign attached instead.
 */
async function findActiveCampaign(workspaceId) {
  return Campaign.findOne({
    workspaceId,
    scheduledSendAt: { $gt: new Date() },
    scheduledSendCompletedAt: null,
  }).sort({ scheduledSendAt: 1 }).select("_id name");
}

/**
 * Runs after a scheduled Discovery run finishes: grades every newly found
 * person with the same AI qualification Jarvis already uses for manual
 * review (identity confidence, real program fit, buyer-intent evidence —
 * see leadGenerationCoordinatorService.qualifyAndRecommend), then saves
 * only the ones it actually calls "qualified" straight into the CRM via
 * the exact same saveResult() a human clicking "Save" already uses —
 * into whichever campaign is currently open, or as a plain CRM contact
 * (still clearly tagged with which recurring search found them) when no
 * campaign is currently open. Anything graded "needs_review" or
 * "not_a_fit" is left exactly where a manual search already leaves it —
 * sitting in the review queue for a human to look at.
 */
async function autoGradeApproveAndEnroll({ workspaceId, discoveryRunId, scheduleName = "" }) {
  const summary = { graded: 0, qualified: 0, saved: 0, campaignId: null, campaignName: "", errors: [] };
  const pending = await GroundingResearchResult.find({
    workspaceId, discoveryRunId, type: "person", status: "pending_review", qualificationLabel: "",
  }).select("_id");
  if (!pending.length) return summary;

  for (let index = 0; index < pending.length; index += GRADE_BATCH_SIZE) {
    const batchIds = pending.slice(index, index + GRADE_BATCH_SIZE).map((row) => String(row._id));
    try {
      await qualifyAndRecommend({ workspaceId, resultIds: batchIds });
      summary.graded += batchIds.length;
    } catch (error) {
      summary.errors.push(`Grading failed: ${error.message || error}`);
    }
  }

  const qualifiedRows = await GroundingResearchResult.find({
    workspaceId, discoveryRunId, type: "person", status: "pending_review", qualificationLabel: "qualified",
  }).select("_id");
  summary.qualified = qualifiedRows.length;
  if (!qualifiedRows.length) return summary;

  const activeCampaign = await findActiveCampaign(workspaceId);
  summary.campaignId = activeCampaign?._id || null;
  summary.campaignName = activeCampaign?.name || "";

  for (const row of qualifiedRows) {
    try {
      const saved = await saveResult({ workspaceId, userId: null, resultId: row._id, campaignId: activeCampaign?._id || null });
      summary.saved += 1;
      if (saved.savedContactId && scheduleName) {
        await Contact.updateOne({ _id: saved.savedContactId }, { $addToSet: { tags: `discovery:${scheduleName}` } });
      }
    } catch (error) {
      summary.errors.push(`${row._id}: ${error.message || error}`);
    }
  }

  // Draft their outreach email so it's ready the moment someone reviews
  // it — but stop there. Auto-qualifying a LEAD (this person is worth
  // contacting) is a different, smaller decision than auto-approving the
  // actual EMAIL COPY sent in their name; that still gets a human's eyes
  // before it can be included in a scheduled send.
  if (activeCampaign && summary.saved) {
    try {
      const fullCampaign = await Campaign.findById(activeCampaign._id);
      if (fullCampaign) await regenerateCampaignOutreach(fullCampaign, { onlyMissing: true });
    } catch (error) {
      summary.errors.push(`Draft generation failed: ${error.message || error}`);
    }
  }
  return summary;
}

module.exports = { autoGradeApproveAndEnroll, findActiveCampaign };
