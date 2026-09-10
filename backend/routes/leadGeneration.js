/**
 * Jarvis-coordinated, multi-provider lead generation (Vertex, OpenAI Web
 * Search, PDL Person Search, Apollo People Search). New routes only —
 * listing/saving/dismissing/PDL-enriching a result and the review queue
 * itself are unchanged and stay at their existing
 * /audience/research/vertex-grounding/* endpoints (PDL/Apollo-sourced rows
 * land in that SAME GroundingResearchResult collection, so they already
 * appear there without any new route).
 */
const express = require("express");
const router = express.Router();
const leadGenerationCoordinatorService = require("../services/leadGenerationCoordinatorService");
const DiscoverySearch = require("../models/DiscoverySearch");
const LeadMonitorSuggestion = require("../models/LeadMonitorSuggestion");

router.get("/program-suggestions", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.getProgramSuggestions({ workspaceId: req.auth.workspaceId });
    return res.json({ success: true, data });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load program suggestions." });
  }
});

/** Free — parses the request into an editable ICP + credit estimate. No provider call is made here. */
router.post("/searches/propose", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.proposeSearch({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth,
      naturalLanguageRequest: req.body?.naturalLanguageRequest, programNoteId: req.body?.programNoteId,
      sources: req.body?.sources, freshnessDays: req.body?.freshnessDays, correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to propose this search", code: error.code || "DISCOVERY_SEARCH_PROPOSE_FAILED" });
  }
});

router.get("/searches/:id", async (req, res) => {
  try {
    const search = await DiscoverySearch.findOne({ _id: req.params.id, workspaceId: req.auth.workspaceId }).lean();
    if (!search) return res.status(404).json({ success: false, error: "Search not found" });
    return res.json({ success: true, data: search });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load this search." });
  }
});

router.get("/searches", async (req, res) => {
  try {
    const searches = await DiscoverySearch.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, data: searches });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load recent searches." });
  }
});

/** Spends: runs whichever providers the proposal selected and merges results into the shared review queue. */
router.post("/searches/:id/approve", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.approveAndRunSearch({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, searchId: req.params.id, correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to run this search", code: error.code || "DISCOVERY_SEARCH_RUN_FAILED" });
  }
});

/** Explicit, per-row Apollo enrichment — Apollo's own separate second-stage cross-check, mirroring PDL's. */
router.post("/results/:id/enrich-apollo", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.enrichWithApollo({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, resultId: req.params.id, correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code === "GROUNDING_RESULT_NOT_FOUND" ? 404 : 400).json({ success: false, error: error.message, code: error.code });
  }
});

/** Jarvis qualifies intent, recommends a program, explains reasoning, and drafts outreach for selected pending results. */
router.post("/results/qualify", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.qualifyAndRecommend({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, resultIds: req.body?.resultIds, correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Qualification failed", code: error.code || "DISCOVERY_QUALIFY_FAILED" });
  }
});

/** Always creates a disabled suggestion — never a live, schedulable monitor. See models/LeadMonitorSuggestion.js. */
router.post("/searches/:id/propose-monitor", async (req, res) => {
  try {
    const data = await leadGenerationCoordinatorService.proposeMonitorSuggestion({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, searchId: req.params.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to propose a monitor", code: error.code || "MONITOR_SUGGESTION_FAILED" });
  }
});

router.get("/monitor-suggestions", async (req, res) => {
  try {
    const suggestions = await LeadMonitorSuggestion.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, data: suggestions });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load monitor suggestions." });
  }
});

module.exports = router;
