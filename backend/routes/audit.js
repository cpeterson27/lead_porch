const express = require("express");
const auditService = require("../services/auditService");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireRole("owner", "admin"));

router.get("/", async (req, res) => {
  try {
    const result = await auditService.query({
      workspaceId: req.auth.workspaceId,
      action: req.query.action,
      targetType: req.query.targetType,
      targetId: req.query.targetId,
      actorUserId: req.query.actorUserId,
      origin: req.query.origin,
      success: req.query.success === undefined ? undefined : req.query.success === "true",
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Audit log could not be loaded" });
  }
});

router.get("/export", async (req, res) => {
  try {
    const csv = await auditService.exportCsv({ workspaceId: req.auth.workspaceId, action: req.query.action, targetType: req.query.targetType, from: req.query.from, to: req.query.to });
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"` });
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ success: false, error: "Audit log export failed" });
  }
});

router.post("/retention", async (req, res) => {
  try {
    return res.json({ success: true, data: await auditService.purgeOlderThan({ workspaceId: req.auth.workspaceId, olderThanDays: Number(req.body?.olderThanDays) }) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Retention purge failed", code: error.code });
  }
});

module.exports = router;
