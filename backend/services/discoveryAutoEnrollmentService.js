const GroundingResearchResult = require("../models/GroundingResearchResult");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const { qualifyAndRecommend } = require("./leadGenerationCoordinatorService");
const { saveResult } = require("./vertexGroundingDiscoveryService");
const { regenerateCampaignOutreach } = require("./outreachGenerationService");

// qualifyAndRecommend() itself caps a single call at 20 result ids.
const GRADE_BATCH_SIZE = 20;

/**
 * The one campaign currently "open" for new Discovery leads: an owner
 * explicitly turns acceptingDiscoveryLeads on for a campaign (the
 * "Accepting Discovery leads" toggle in Outreach) — never inferred. This
 * is deliberately built so an owner can turn the switch on for SEVERAL
 * campaigns at once — a whole week's worth, say — and it behaves as a
 * queue: only the single soonest-scheduled one among them ever receives
 * new leads. services/campaignSendScheduler.js turns that one's flag back
 * off automatically the instant its send completes, and because it's no
 * longer "open," the next-soonest campaign in the group becomes the new
 * answer on its own — no one needs to remember to flip anything each day.
 * A campaign with no scheduledSendAt set yet is excluded rather than
 * sorting first (Mongo sorts null before any real date ascending), so an
 * unscheduled campaign can never accidentally jump the queue. Returns
 * null when nothing is currently open, which is the caller's signal to
 * import straight to the CRM with no campaign attached instead.
 */
async function findActiveCampaign(workspaceId) {
  return Campaign.findOne({
    workspaceId,
    acceptingDiscoveryLeads: true,
    scheduledSendAt: { $ne: null },
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
async function autoGradeApproveAndEnroll({ workspaceId, auth, discoveryRunId, scheduleName = "" }) {
  const summary = { graded: 0, qualified: 0, saved: 0, campaignId: null, campaignName: "", errors: [] };
  const pending = await GroundingResearchResult.find({
    workspaceId, discoveryRunId, type: "person", status: "pending_review", qualificationLabel: "",
  }).select("_id");
  if (!pending.length) return summary;

  for (let index = 0; index < pending.length; index += GRADE_BATCH_SIZE) {
    const batchIds = pending.slice(index, index + GRADE_BATCH_SIZE).map((row) => String(row._id));
    try {
      await qualifyAndRecommend({ workspaceId, auth, resultIds: batchIds });
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

/**
 * One-time catch-up for backlog that predates this file (2026-09-21) or
 * came from a run whose own per-run auto-enrollment step never fired
 * (a manual/ad-hoc "Find leads" run, which never calls
 * autoGradeApproveAndEnroll at all — only a scheduled run's completion
 * does). Never runs automatically; only ever triggered by an explicit
 * admin action in the Discovery UI, since it spends real AI credit and can
 * add people to whatever campaign is currently open.
 *
 * Bounded per call (a handful of runs, a couple hundred non-person rows) —
 * NOT the whole backlog in one shot — because a single request processing
 * a huge backlog risks the platform's own reverse-proxy request timeout
 * cutting the HTTP response off long before the work (which keeps running
 * server-side regardless) actually finishes, exactly the "looked like a
 * silent failure but was really still working" trap process-next-batch's
 * own comment already documents. The caller loops, calling again while
 * hasMore is true, same shape as that existing pattern.
 */
async function regradeBacklog({ workspaceId, auth, personRunLimit = 3, partnershipRowLimit = 100 }) {
  const discoveryPartnershipService = require("./discoveryPartnershipService");
  const personRunIds = (await GroundingResearchResult.distinct("discoveryRunId", {
    workspaceId, type: "person", status: "pending_review", qualificationLabel: "",
  })).filter(Boolean);

  const personTotals = { runsProcessed: 0, graded: 0, qualified: 0, saved: 0, errors: [] };
  for (const discoveryRunId of personRunIds.slice(0, personRunLimit)) {
    try {
      const result = await autoGradeApproveAndEnroll({ workspaceId, auth, discoveryRunId, scheduleName: "backlog-cleanup" });
      personTotals.runsProcessed += 1;
      personTotals.graded += result.graded;
      personTotals.qualified += result.qualified;
      personTotals.saved += result.saved;
      if (result.errors.length) personTotals.errors.push(...result.errors);
    } catch (error) {
      personTotals.errors.push(`${discoveryRunId}: ${error.message || error}`);
    }
  }

  const partnership = await discoveryPartnershipService.triageNonPersonResults({ workspaceId, limit: partnershipRowLimit });
  const remainingPersonRuns = personRunIds.length - Math.min(personRunLimit, personRunIds.length);
  const remaining = await GroundingResearchResult.countDocuments({ workspaceId, status: "pending_review" });
  const hasMore = remainingPersonRuns > 0 || partnership.checked >= partnershipRowLimit;
  return { people: personTotals, partnership, remainingInQueue: remaining, hasMore };
}

/**
 * Explicit override for the "needs_review" pile: the AI already looked at
 * these and specifically wasn't confident enough to call them "qualified"
 * on its own — this bypasses that judgment call entirely on the owner's
 * direct instruction, saving every one of them into the CRM (and whatever
 * campaign is currently open) the same way an AI-confirmed "qualified"
 * lead already would. Only ever runs from an explicit, confirmed admin
 * click — never automatically — since it knowingly lowers lead quality
 * in exchange for volume, a real tradeoff the owner chose eyes-open.
 * Bounded per call for the same reverse-proxy-timeout reason
 * regradeBacklog() documents; the caller loops while hasMore is true.
 */
async function approveNeedsReviewPeople({ workspaceId, limit = 50 }) {
  const rows = await GroundingResearchResult.find({
    workspaceId, type: "person", status: "pending_review", qualificationLabel: "needs_review",
  }).select("_id").limit(limit);

  const summary = { saved: 0, errors: [], campaignId: null, campaignName: "" };
  if (!rows.length) return { ...summary, hasMore: false };

  const activeCampaign = await findActiveCampaign(workspaceId);
  summary.campaignId = activeCampaign?._id || null;
  summary.campaignName = activeCampaign?.name || "";

  for (const row of rows) {
    try {
      await saveResult({ workspaceId, userId: null, resultId: row._id, campaignId: activeCampaign?._id || null });
      summary.saved += 1;
    } catch (error) {
      summary.errors.push(`${row._id}: ${error.message || error}`);
    }
  }

  if (activeCampaign && summary.saved) {
    try {
      const fullCampaign = await Campaign.findById(activeCampaign._id);
      if (fullCampaign) await regenerateCampaignOutreach(fullCampaign, { onlyMissing: true });
    } catch (error) {
      summary.errors.push(`Draft generation failed: ${error.message || error}`);
    }
  }

  const remaining = await GroundingResearchResult.countDocuments({ workspaceId, type: "person", status: "pending_review", qualificationLabel: "needs_review" });
  return { ...summary, hasMore: remaining > 0 };
}

module.exports = { autoGradeApproveAndEnroll, findActiveCampaign, regradeBacklog, approveNeedsReviewPeople };
