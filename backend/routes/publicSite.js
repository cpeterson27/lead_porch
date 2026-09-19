const express = require("express");
const Testimonial = require("../models/Testimonial");
const PublicProfile = require("../models/PublicProfile");
const CoachingProgram = require("../models/CoachingProgram");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const service = require("../services/publicSiteService");
const applicationService = require("../services/publicApplicationService");
const paymentService = require("../services/paymentService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const router = express.Router();
const attempts = new Map();
const CoachProfile = require("../models/CoachProfile");
const WorkspaceMembership = require("../models/WorkspaceMembership");
function limited(req, res, next) {
  const key = String(req.ip || "local");
  const now = Date.now(),
    row = attempts.get(key) || [];
  const recent = row.filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 5)
    return res
      .status(429)
      .json({ error: "Please wait before submitting again" });
  recent.push(now);
  attempts.set(key, recent);
  next();
}
router.get("/site", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const data = await service.site(req);
    const legalPath = String(req.query.publicPath || "").match(
      /^\/(?:privacy(?:-policy)?|terms|data-deletion)\/?$/,
    );
    if (!data.publicSite?.published && !legalPath)
      return res.status(404).json({ error: "This website is not published." });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
router.get("/programs", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const rows = await runWithWorkspace(ws._id, () =>
      CoachingProgram.find({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      })
        .sort({ "publicPresentation.sortOrder": 1 })
        .lean(),
    );
    res.json({ success: true, data: rows.map(service.programProjection) });
  } catch (error) {
    next(error);
  }
});
router.get("/programs/:slug", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const row = await runWithWorkspace(ws._id, () =>
      CoachingProgram.findOne({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
        "publicPresentation.slug": String(req.params.slug).toLowerCase(),
      }).lean(),
    );
    if (!row) return res.status(404).json({ error: "Program not found" });
    res.json({ success: true, data: service.programProjection(row) });
  } catch (error) {
    next(error);
  }
});
router.get("/application", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const config = await runWithWorkspace(ws._id, () =>
      WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).lean(),
    );
    const programs = await runWithWorkspace(ws._id, () =>
      CoachingProgram.find({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      })
        .sort({ "publicPresentation.sortOrder": 1 })
        .lean(),
    );
    res.json({
      success: true,
      data: {
        ...applicationService.publicConfig(config),
        programs: programs.map(service.programProjection),
      },
    });
  } catch (error) {
    next(error);
  }
});
router.post("/application", limited, async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const item = await runWithWorkspace(ws._id, () =>
      applicationService.submit({
        workspaceId: ws._id,
        input: req.body || {},
        requestFingerprint: String(req.ip || ""),
      }),
    );
    const config = await runWithWorkspace(ws._id, () =>
      WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).lean(),
    );
    res.status(201).json({
      success: true,
      data: {
        applicationId: item._id,
        message: applicationService.publicConfig(config).confirmationMessage,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/programs/:slug/checkout", limited, async (req, res) => {
  try {
    const ws = await service.workspace(req);
    const program = await runWithWorkspace(ws._id, () =>
      CoachingProgram.findOne({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
        "publicPresentation.slug": String(req.params.slug).toLowerCase(),
      }).select("_id").lean(),
    );
    if (!program) return res.status(404).json({ error: "Program not found" });
    const result = await runWithWorkspace(ws._id, () =>
      paymentService.beginPublicProgramCheckout({
        workspaceId: ws._id,
        programId: program._id,
        input: req.body || {},
      }),
    );
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "PAYMENT_REQUEST_FAILED" });
  }
});
router.get("/testimonials", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const rows = await runWithWorkspace(ws._id, () =>
      Testimonial.find({ workspaceId: ws._id, status: "approved" })
        .sort({ featured: -1, sortOrder: 1, approvedAt: -1 })
        .lean(),
    );
    res.json({ success: true, data: rows.map(service.testimonialProjection) });
  } catch (error) {
    next(error);
  }
});
router.post("/testimonials", limited, async (req, res, next) => {
  try {
    if (req.body?.consentConfirmed !== true)
      return res
        .status(400)
        .json({ error: "Consent for public display is required" });
    const ws = await service.workspace(req);
    const displayName = String(req.body?.displayName || "").trim(),
      body = String(req.body?.body || "").trim();
    if (displayName.length < 2 || body.length < 20)
      return res.status(400).json({
        error: "Add your name and a testimonial of at least 20 characters",
      });
    await runWithWorkspace(ws._id, () =>
      Testimonial.create({
        workspaceId: ws._id,
        displayName,
        headline: String(req.body?.headline || "").slice(0, 300),
        body: body.slice(0, 8000),
        rating: Number(req.body?.rating) || null,
        videoUrl: service.safeUrl(req.body?.videoUrl),
        consentConfirmed: true,
        status: "pending",
      }),
    );
    res.status(202).json({
      success: true,
      message: "Thank you. Your testimonial was submitted for review.",
    });
  } catch (error) {
    next(error);
  }
});
router.get("/profiles/:slug", async (req, res, next) => {
  try {
    const ws = await service.workspace(req);
    const row = await runWithWorkspace(ws._id, () =>
      PublicProfile.findOne({
        workspaceId: ws._id,
        slug: String(req.params.slug).toLowerCase(),
        status: "published",
      }).lean(),
    );
    if (!row) return res.status(404).json({ error: "Profile not found" });
    if (row.ownerType === "coach") {
      const coach = await runWithWorkspace(ws._id, () =>
        CoachProfile.findOne({
          _id: row.coachProfileId,
          workspaceId: ws._id,
          status: "active",
        })
          .select("userId")
          .lean(),
      );
      const member = coach
        ? await runWithWorkspace(ws._id, () =>
            WorkspaceMembership.exists({
              workspaceId: ws._id,
              userId: coach.userId,
              status: "active",
            }),
          )
        : null;
      if (!coach || !member || !row.displayName || !row.bio)
        return res.status(404).json({ error: "Profile not found" });
    }
    res.json({ success: true, data: service.profileProjection(row) });
  } catch (error) {
    next(error);
  }
});
router.get("/profile-edit/:token", limited, async (req, res, next) => {
  try {
    const found = await service.tokenProfile(req.params.token);
    if (!found)
      return res
        .status(404)
        .json({ error: "This profile-edit link is invalid or expired" });
    res.json({
      success: true,
      data: service.profileProjection(found.profile),
      status: found.profile.status,
    });
  } catch (error) {
    next(error);
  }
});
router.patch("/profile-edit/:token", limited, async (req, res, next) => {
  try {
    const found = await service.tokenProfile(req.params.token);
    if (!found)
      return res
        .status(404)
        .json({ error: "This profile-edit link is invalid or expired" });
    Object.assign(
      found.profile,
      service.profileInput({ ...found.profile.toObject(), ...req.body }),
    );
    await found.profile.save();
    res.json({
      success: true,
      data: service.profileProjection(found.profile),
      status: found.profile.status,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
module.exports = router;
