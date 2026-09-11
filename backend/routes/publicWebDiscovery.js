/**
 * High-volume Public Web Discovery engine routes
 * (services/publicWebDiscoveryEngineService.js) — new, additive surface
 * only. Every result still lands in the existing GroundingResearchResult
 * review queue and its existing /api/lead-generation and
 * /api/audience/research/vertex-grounding save/dismiss/enrich endpoints —
 * nothing here bypasses that review step.
 */
const express = require("express");
const router = express.Router();
const publicWebDiscoveryEngineService = require("../services/publicWebDiscoveryEngineService");
const PublicWebDiscoveryRun = require("../models/PublicWebDiscoveryRun");
const DiscoverySchedule = require("../models/DiscoverySchedule");

/** Free — generates editable search families for an approved program. No provider call is made here. */
router.post("/runs/propose", async (req, res) => {
  try {
    const data = await publicWebDiscoveryEngineService.proposePublicWebDiscoveryRun({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth,
      programNoteId: req.body?.programNoteId, locations: req.body?.locations,
      correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to propose a discovery run", code: error.code || "DISCOVERY_RUN_PROPOSE_FAILED" });
  }
});

/**
 * One-click "Find prospective students" preset — free, no provider call.
 * Assembles PDL (independent candidate source) → intent discussions →
 * aspiring/beginner people → communities/groups, in that priority order,
 * with conservative first-run defaults (25 unique people, one page per
 * query, one retry, $1 hard cap).
 */
router.post("/runs/propose-student-preset", async (req, res) => {
  try {
    const data = await publicWebDiscoveryEngineService.proposeStudentSearchPreset({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth,
      programNoteId: req.body?.programNoteId, locations: req.body?.locations,
      correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to propose the student-search preset", code: error.code || "DISCOVERY_RUN_PRESET_FAILED" });
  }
});

/**
 * Free, pure, no-DB-write preview of the EXACT finalized job plan
 * approving with these exact settings would produce — uses the same
 * finalizeWebJobPlan()/computeRunPlanPreview() functions
 * approvePublicWebDiscoveryRun itself uses, so this can never show a
 * different number than what "Run once now" will actually do.
 */
router.post("/runs/preview", (req, res) => {
  try {
    const data = publicWebDiscoveryEngineService.computeRunPlanPreview({
      jobs: req.body?.jobs, sources: req.body?.sources, queryLimitPerRun: req.body?.queryLimitPerRun, pageLimitPerQuery: req.body?.pageLimitPerQuery,
      providerCreditCapUsd: req.body?.providerCreditCapUsd, includePdlPersonSearch: req.body?.includePdlPersonSearch, maxPdlPersonSearchCredits: req.body?.maxPdlPersonSearchCredits,
      includePdlCrossReference: req.body?.includePdlCrossReference, maxPdlCrossReferenceCredits: req.body?.maxPdlCrossReferenceCredits, maxAttemptsPerJob: req.body?.maxAttemptsPerJob,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to compute the run plan preview" });
  }
});

router.get("/runs/:id", async (req, res) => {
  try {
    const run = await PublicWebDiscoveryRun.findOne({ _id: req.params.id, workspaceId: req.auth.workspaceId }).lean();
    if (!run) return res.status(404).json({ success: false, error: "Discovery run not found" });
    return res.json({ success: true, data: run });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load this discovery run." });
  }
});

/**
 * Persisted, non-draft runs (queued/running/paused/completed/
 * stopped_at_cap/failed) for the "Recent discovery runs" recovery list —
 * a draft is only ever an in-progress, unapproved edit and is
 * intentionally excluded here; it exists solely in the owner's current
 * session via the propose/preset endpoints above. `jobs` is included
 * (not excluded) so a reloaded run's checkpoint/current-query display
 * renders identically to one just approved in this same session.
 */
router.get("/runs", async (req, res) => {
  try {
    const runs = await PublicWebDiscoveryRun.find({ workspaceId: req.auth.workspaceId, status: { $ne: "draft" } }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, data: runs });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load recent discovery runs." });
  }
});

/** Applies the owner's edits and queues the run — still spends nothing until a processNextBatch tick runs. */
router.post("/runs/:id/approve", async (req, res) => {
  try {
    const data = await publicWebDiscoveryEngineService.approvePublicWebDiscoveryRun({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, runId: req.params.id,
      jobs: req.body?.jobs, dailyCandidateTarget: req.body?.dailyCandidateTarget, pageLimitPerQuery: req.body?.pageLimitPerQuery,
      queryLimitPerRun: req.body?.queryLimitPerRun, providerCreditCapUsd: req.body?.providerCreditCapUsd,
      includePdlCrossReference: req.body?.includePdlCrossReference, includePdlPersonSearch: req.body?.includePdlPersonSearch,
      maxPdlPersonSearchCredits: req.body?.maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits: req.body?.maxPdlCrossReferenceCredits,
      sources: req.body?.sources, maxAttemptsPerJob: req.body?.maxAttemptsPerJob,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to approve this discovery run", code: error.code || "DISCOVERY_RUN_APPROVE_FAILED" });
  }
});

/** Spends: processes one bounded batch of the queued run and returns immediately — call again to continue. */
router.post("/runs/:id/process-next-batch", async (req, res) => {
  try {
    const data = await publicWebDiscoveryEngineService.processNextBatch({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, runId: req.params.id,
      batchSize: req.body?.batchSize, correlationId: req.headers["x-request-id"] || "",
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 502).json({ success: false, error: error.message || "Unable to process this discovery run", code: error.code || "DISCOVERY_RUN_PROCESS_FAILED" });
  }
});

router.post("/runs/:id/pause", async (req, res) => {
  try {
    const run = await PublicWebDiscoveryRun.findOneAndUpdate({ _id: req.params.id, workspaceId: req.auth.workspaceId, status: { $in: ["queued", "running"] } }, { $set: { status: "paused" } }, { new: true });
    if (!run) return res.status(404).json({ success: false, error: "No pausable discovery run found" });
    return res.json({ success: true, data: run });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to pause this discovery run." });
  }
});

router.post("/runs/:id/resume", async (req, res) => {
  try {
    const run = await PublicWebDiscoveryRun.findOneAndUpdate({ _id: req.params.id, workspaceId: req.auth.workspaceId, status: "paused" }, { $set: { status: "queued" } }, { new: true });
    if (!run) return res.status(404).json({ success: false, error: "No paused discovery run found" });
    return res.json({ success: true, data: run });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to resume this discovery run." });
  }
});

router.post("/runs/:id/cancel", async (req, res) => {
  try {
    const run = await PublicWebDiscoveryRun.findOneAndUpdate({ _id: req.params.id, workspaceId: req.auth.workspaceId, status: { $in: ["draft", "queued", "running", "paused"] } }, { $set: { status: "canceled" } }, { new: true });
    if (!run) return res.status(404).json({ success: false, error: "No cancelable discovery run found" });
    return res.json({ success: true, data: run });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to cancel this discovery run." });
  }
});

/** Schedules — all created (and stay) disabled until the owner explicitly flips them on. */
router.post("/schedules", async (req, res) => {
  try {
    const schedule = await DiscoverySchedule.create({
      workspaceId: req.auth.workspaceId, name: req.body?.name || "Discovery schedule", programNoteId: req.body?.programNoteId || null,
      programName: req.body?.programName || "", intervalMinutes: req.body?.intervalMinutes, dailyCandidateTarget: req.body?.dailyCandidateTarget,
      pageLimitPerQuery: req.body?.pageLimitPerQuery, queryLimitPerRun: req.body?.queryLimitPerRun, providerCreditCapUsd: req.body?.providerCreditCapUsd,
      sources: req.body?.sources, includePdlCrossReference: req.body?.includePdlCrossReference, includePdlPersonSearch: req.body?.includePdlPersonSearch,
      maxPdlPersonSearchCredits: req.body?.maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits: req.body?.maxPdlCrossReferenceCredits,
      maxAttemptsPerJob: req.body?.maxAttemptsPerJob,
      enabled: false, // Never honors a client-supplied enabled:true — the owner must flip it on via /enable below.
      createdByUserId: req.auth.user?._id,
    });
    return res.json({ success: true, data: schedule });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to create this schedule" });
  }
});

router.get("/schedules", async (req, res) => {
  try {
    const schedules = await DiscoverySchedule.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, data: schedules });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load discovery schedules." });
  }
});

router.post("/schedules/:id/enable", async (req, res) => {
  try {
    const schedule = await DiscoverySchedule.findOneAndUpdate({ _id: req.params.id, workspaceId: req.auth.workspaceId }, { $set: { enabled: true, nextRunAt: new Date() } }, { new: true });
    if (!schedule) return res.status(404).json({ success: false, error: "Schedule not found" });
    return res.json({ success: true, data: schedule });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to enable this schedule." });
  }
});

router.post("/schedules/:id/disable", async (req, res) => {
  try {
    const schedule = await DiscoverySchedule.findOneAndUpdate({ _id: req.params.id, workspaceId: req.auth.workspaceId }, { $set: { enabled: false } }, { new: true });
    if (!schedule) return res.status(404).json({ success: false, error: "Schedule not found" });
    return res.json({ success: true, data: schedule });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to disable this schedule." });
  }
});

router.post("/schedules/:id/run-now", async (req, res) => {
  try {
    const schedule = await publicWebDiscoveryEngineService.requestScheduleRunNow({ workspaceId: req.auth.workspaceId, scheduleId: req.params.id });
    if (!schedule) return res.status(404).json({ success: false, error: "Schedule not found" });
    return res.json({ success: true, data: schedule });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to request a run for this schedule." });
  }
});

module.exports = router;
