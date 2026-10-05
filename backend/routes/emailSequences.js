const express = require("express");
const { requireRole } = require("../middleware/auth");
const emailSequenceService = require("../services/emailSequenceService");

const router = express.Router();
router.use(requireRole("owner", "admin", "member"));

router.get("/", async (req, res) => {
  try {
    return res.json({ success: true, data: await emailSequenceService.listSequences(req.auth.workspaceId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Unable to load email sequences" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    return res.json({ success: true, data: await emailSequenceService.getSequence(req.auth.workspaceId, req.params.id) });
  } catch (error) {
    return res.status(error.code ? 404 : 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.get("/:id/enrollments", async (req, res) => {
  try {
    return res.json({ success: true, data: await emailSequenceService.listEnrollments({ workspaceId: req.auth.workspaceId, sequenceId: req.params.id }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Unable to load enrollments" });
  }
});

router.post("/", async (req, res) => {
  try {
    const sequence = await emailSequenceService.createSequence({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id,
      name: req.body?.name, description: req.body?.description, campaignId: req.body?.campaignId,
      steps: req.body?.steps, stopOnReply: req.body?.stopOnReply,
    });
    return res.status(201).json({ success: true, data: sequence });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message, code: error.code });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const sequence = await emailSequenceService.updateSequence({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, sequenceId: req.params.id,
      name: req.body?.name, description: req.body?.description, status: req.body?.status,
      steps: req.body?.steps, stopOnReply: req.body?.stopOnReply,
    });
    return res.json({ success: true, data: sequence });
  } catch (error) {
    return res.status(error.code ? 400 : 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.post("/:id/enroll", async (req, res) => {
  try {
    const data = await emailSequenceService.enrollContacts({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, sequenceId: req.params.id,
      contactIds: req.body?.contactIds,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.code ? 400 : 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.post("/enrollments/:enrollmentId/:action", async (req, res) => {
  try {
    const status = { pause: "paused", resume: "active", stop: "stopped" }[req.params.action];
    if (!status) return res.status(400).json({ success: false, error: "Unknown action", code: "EMAIL_SEQUENCE_ENROLLMENT_ACTION_INVALID" });
    const enrollment = await emailSequenceService.setEnrollmentStatus({
      workspaceId: req.auth.workspaceId, enrollmentId: req.params.enrollmentId, status, reason: req.body?.reason,
    });
    return res.json({ success: true, data: enrollment });
  } catch (error) {
    return res.status(error.code ? 404 : 500).json({ success: false, error: error.message, code: error.code });
  }
});

module.exports = router;
