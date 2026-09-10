const express = require("express");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const CoachingApplication = require("../models/CoachingApplication");
const Testimonial = require("../models/Testimonial");
const PublicProfile = require("../models/PublicProfile");
const CoachProfile = require("../models/CoachProfile");
const Contact = require("../models/Contact");
const CoachingProgram = require("../models/CoachingProgram");
const service = require("../services/publicSiteService");
const applicationService = require("../services/publicApplicationService");
const { requireCapability } = require("../middleware/auth");
const router = express.Router();
const admin = requireCapability("workspace.manage");
const media = require("../services/imageAssetService");
router.post("/program-media", admin, async (req, res) => {
  try {
    const asset = await media.uploadVideo({
      file: req.body.file,
      folder: `growth-operator/programs/${req.auth.workspaceId}`,
    });
    res.status(201).json({ success: true, data: { ...asset, type: "video" } });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});
router.post("/testimonial-media", admin, async (req, res) => {
  try {
    const asset = await media.uploadVideo({
      file: req.body.file,
      folder: `growth-operator/testimonials/${req.auth.workspaceId}`,
    });
    res.status(201).json({ success: true, data: { ...asset, type: "video" } });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});
router.post("/testimonial-media-signature", admin, async (req, res) => {
  try {
    const data = media.createVideoUploadSignature({
      folder: `growth-operator/testimonials/${req.auth.workspaceId}`,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});
router.post("/homepage-media-signature", admin, async (req, res) => {
  try {
    const data = media.createVideoUploadSignature({
      folder: `growth-operator/homepage/${req.auth.workspaceId}`,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});
router.get("/config", admin, async (req, res) => {
  const config = await WorkspaceConfig.findOne({
    workspaceId: req.auth.workspaceId,
    key: "primary",
  }).lean();
  res.json({
    success: true,
    data: service.sanitizedConfig(req.auth.workspace, config),
  });
});
router.patch("/config", admin, async (req, res) => {
  try {
    const clean = service.sanitizedConfig(req.auth.workspace, {
      branding: req.body.branding,
      appBranding: req.body.appBranding,
      publicSite: req.body.publicSite,
      moduleAccess: req.body.moduleAccess,
      organizationLogoUrl: req.body.organizationLogoUrl,
    });
    const config = await WorkspaceConfig.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, key: "primary" },
      {
        $set: {
          branding: clean.branding,
          appBranding: clean.appBranding,
          publicSite: clean.publicSite,
          moduleAccess: clean.moduleAccess,
        },
      },
      { upsert: true, new: true },
    );
    res.json({
      success: true,
      data: service.sanitizedConfig(req.auth.workspace, config),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/config/lead-porch-starter", admin, async (req, res) => {
  try {
    if (
      req.auth.workspace?.slug === (process.env.ELLIE_WORKSPACE_SLUG || "ellie")
    )
      return res
        .status(403)
        .json({ error: "Ellie’s website cannot use the Lead Porch starter." });
    const starter = service.defaults(req.auth.workspace);
    const config = await WorkspaceConfig.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, key: "primary" },
      {
        $set: {
          branding: starter.branding,
          publicSite: starter.publicSite,
          moduleAccess: {
            coaching: false,
            ambassadors: false,
            publicProof: false,
          },
        },
      },
      { upsert: true, new: true },
    );
    res.json({
      success: true,
      data: service.sanitizedConfig(req.auth.workspace, config),
    });
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "Unable to load Lead Porch starter site.",
      });
  }
});
router.get("/application-config", admin, async (req, res) => {
  const config = await WorkspaceConfig.findOne({
    workspaceId: req.auth.workspaceId,
    key: "primary",
  }).lean();
  res.json({
    success: true,
    data: {
      ...applicationService.publicConfig(config),
      defaultAssigneeUserId:
        config?.publicApplication?.defaultAssigneeUserId || null,
      programAssignments: config?.publicApplication?.programAssignments || [],
      notificationRecipientUserIds:
        config?.publicApplication?.notificationRecipientUserIds || [],
    },
  });
});
router.patch("/application-config", admin, async (req, res) => {
  try {
    const input = req.body || {};
    const notificationRecipientUserIds = [
      ...new Set((input.notificationRecipientUserIds || []).map(String)),
    ].slice(0, 100);
    const assigneeIds = [
      input.defaultAssigneeUserId,
      ...(input.programAssignments || []).map((row) => row.userId),
    ].filter(Boolean);
    for (const userId of assigneeIds) {
      const member = await WorkspaceMembership.findOne({
        workspaceId: req.auth.workspaceId,
        userId,
        status: "active",
      }).lean();
      const roles = new Set(
        [...(member?.roles || []), member?.role].filter(Boolean),
      );
      if (
        !member ||
        !["owner", "admin", "closer"].some((role) => roles.has(role))
      )
        throw new Error(
          "Every application assignee must be an active owner, admin, or closer",
        );
    }
    for (const userId of notificationRecipientUserIds)
      if (
        !(await WorkspaceMembership.exists({
          workspaceId: req.auth.workspaceId,
          userId,
          status: "active",
        }))
      )
        throw new Error(
          "Every notification recipient must be an active workspace member",
        );
    for (const row of input.programAssignments || [])
      if (
        !(await CoachingProgram.exists({
          _id: row.coachingProgramId,
          workspaceId: req.auth.workspaceId,
        }))
      )
        throw new Error("Application program must belong to this workspace");
    const values = {
      enabled: input.enabled !== false,
      heading: String(input.heading || "Apply to Join a Program").slice(0, 240),
      intro: String(input.intro || "").slice(0, 1200),
      confirmationMessage: String(input.confirmationMessage || "").slice(
        0,
        1000,
      ),
      heroImageUrl: service.safeUrl(input.heroImageUrl || ""),
      questionLabels: Object.fromEntries(
        Object.entries(input.questionLabels || {}).map(([key, value]) => [
          key,
          String(value).slice(0, 160),
        ]),
      ),
      timelineOptions: (input.timelineOptions || []).map(String).slice(0, 20),
      nextStepCta: {
        label: String(input.nextStepCta?.label || "").slice(0, 120),
        url: service.safeUrl(input.nextStepCta?.url || "", { relative: true }),
      },
      privacyUrl: service.safeUrl(input.privacyUrl || "/privacy", {
        relative: true,
      }),
      termsUrl: service.safeUrl(input.termsUrl || "/terms", { relative: true }),
      defaultAssigneeUserId: input.defaultAssigneeUserId || null,
      notificationRecipientUserIds,
      programAssignments: (input.programAssignments || [])
        .slice(0, 100)
        .map((row) => ({
          coachingProgramId: row.coachingProgramId,
          userId: row.userId,
        })),
    };
    const config = await WorkspaceConfig.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, key: "primary" },
      { $set: { publicApplication: values } },
      { upsert: true, new: true },
    );
    res.json({ success: true, data: config.publicApplication });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.get("/applications", admin, async (req, res) => {
  const query = { workspaceId: req.auth.workspaceId };
  if (req.query.status) query.status = req.query.status;
  if (req.query.programId) query.coachingProgramId = req.query.programId;
  if (req.query.assignedUserId) query.assignedUserId = req.query.assignedUserId;
  const rows = await CoachingApplication.find(query)
    .sort({ submittedAt: -1 })
    .limit(500)
    .populate("contactId", "name email phone")
    .populate("coachingProgramId", "name defaultPrice")
    .populate("assignedUserId", "name email")
    .lean();
  res.json({ success: true, data: rows });
});
router.get("/testimonials", admin, async (req, res) =>
  res.json({
    success: true,
    data: await Testimonial.find({ workspaceId: req.auth.workspaceId })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean(),
  }),
);
router.post("/testimonials", admin, async (req, res) => {
  try {
    const approved = req.body.status === "approved";
    const item = await Testimonial.create({
      workspaceId: req.auth.workspaceId,
      displayName: req.body.displayName,
      headline: req.body.headline,
      body: req.body.body,
      avatarUrl: service.safeUrl(req.body.avatarUrl),
      resultContext: String(req.body.resultContext || "").slice(0, 2000),
      rating: req.body.rating || null,
      videoUrl: service.safeUrl(req.body.videoUrl),
      consentConfirmed: req.body.consentConfirmed === true,
      status: approved ? "approved" : "pending",
      featured: approved && Boolean(req.body.featured),
      sortOrder: Number(req.body.sortOrder) || 0,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? req.auth.user._id : null,
    });
    res.status(201).json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.patch("/testimonials/:id", admin, async (req, res) => {
  try {
    const item = await Testimonial.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
    });
    if (!item) return res.status(404).json({ error: "Testimonial not found" });
    for (const key of [
      "displayName",
      "headline",
      "body",
      "resultContext",
      "rating",
      "featured",
      "sortOrder",
      "consentConfirmed",
    ])
      if (req.body[key] !== undefined) item[key] = req.body[key];
    if (req.body.avatarUrl !== undefined)
      item.avatarUrl = service.safeUrl(req.body.avatarUrl);
    if (req.body.videoUrl !== undefined)
      item.videoUrl = service.safeUrl(req.body.videoUrl);
    if (
      req.body.status &&
      ["pending", "approved", "rejected"].includes(req.body.status)
    ) {
      item.status = req.body.status;
      item.approvedAt = req.body.status === "approved" ? new Date() : null;
      item.approvedBy =
        req.body.status === "approved" ? req.auth.user._id : null;
      item.rejectedAt = req.body.status === "rejected" ? new Date() : null;
      item.rejectedBy =
        req.body.status === "rejected" ? req.auth.user._id : null;
    }
    if (item.status !== "approved") item.featured = false;
    await item.save();
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.delete("/testimonials/:id", admin, async (req, res) => {
  try {
    const item = await Testimonial.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
    });
    if (!item) return res.status(404).json({ error: "Testimonial not found" });
    await item.deleteOne();
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.patch("/programs/:id", admin, async (req, res) => {
  try {
    const program = await CoachingProgram.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
    });
    if (!program) return res.status(404).json({ error: "Program not found" });
    const input = req.body || {},
      slug = String(
        input.slug || program.publicPresentation?.slug || program.name,
      )
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
      description = String(input.description || "").trim();
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      return res.status(400).json({
        error:
          "Use a lowercase program slug with letters, numbers, and hyphens",
      });
    if (input.status === "published" && (!slug || !description))
      return res.status(400).json({
        error: "Add a program name and description before publishing.",
      });
    program.publicPresentation = {
      slug,
      title: String(input.title || program.name).slice(0, 180),
      summary: description.slice(0, 1200),
      description: description.slice(0, 12000),
      priceVisible: true,
      highlights: (Array.isArray(input.highlights) ? input.highlights : [])
        .map(String)
        .slice(0, 20),
      outcomes: (Array.isArray(input.outcomes) ? input.outcomes : [])
        .map(String)
        .slice(0, 20),
      curriculum: (Array.isArray(input.curriculum) ? input.curriculum : [])
        .map(String)
        .slice(0, 30),
      imageUrl: service.safeUrl(input.imageUrl || ""),
      audience: String(input.audience || "").slice(0, 3000),
      introVideoUrl: service.safeUrl(input.introVideoUrl || ""),
      introVideoPublicId: String(input.introVideoPublicId || "").slice(0, 500),
      ctaLabel: String(input.ctaLabel || "Apply Now").slice(0, 80),
      ctaUrl: service.safeUrl(input.ctaUrl || "/apply", { relative: true }),
      ctaSupportingText: String(input.ctaSupportingText || "").slice(0, 500),
      status: input.status === "published" ? "published" : "hidden",
      section: input.section === "accelerator" ? "accelerator" : "intensive",
      featured: input.featured === true,
      sortOrder: Number(input.sortOrder) || 0,
    };
    await program.save();
    res.json({ success: true, data: program });
  } catch (error) {
    res.status(400).json({
      error:
        error.code === 11000
          ? "That public program slug is already used"
          : error.message,
    });
  }
});
router.get("/profiles", admin, async (req, res) =>
  res.json({
    success: true,
    data: await PublicProfile.find({ workspaceId: req.auth.workspaceId })
      .sort({ ownerType: 1, displayName: 1 })
      .lean(),
  }),
);
router.post("/profiles", admin, async (req, res) => {
  try {
    const ownerType = req.body.ownerType;
    if (!["coach", "team", "student"].includes(ownerType))
      throw new Error("Choose a coach, team member, or student profile type");
    let userId = null,
      coachProfileId = null,
      contactId = null,
      displayName = req.body.displayName;
    if (ownerType === "coach") {
      const coach = await CoachProfile.findOne({
        _id: req.body.coachProfileId,
        workspaceId: req.auth.workspaceId,
      });
      if (!coach) throw new Error("Coach not found");
      userId = coach.userId;
      coachProfileId = coach._id;
      displayName = displayName || coach.displayName;
    } else if (ownerType === "team") {
      const member = await WorkspaceMembership.findOne({
        workspaceId: req.auth.workspaceId,
        userId: req.body.userId,
        status: "active",
      }).populate("userId", "name firstName lastName");
      if (!member) throw new Error("Active workspace team member not found");
      userId = member.userId._id;
      if (
        await PublicProfile.exists({
          workspaceId: req.auth.workspaceId,
          ownerType: "team",
          userId,
        })
      )
        throw new Error("This team member already has a public profile");
      displayName =
        displayName ||
        member.userId.name ||
        [member.userId.firstName, member.userId.lastName]
          .filter(Boolean)
          .join(" ");
    } else {
      const contact = await Contact.findOne({
        _id: req.body.contactId,
        workspaceId: req.auth.workspaceId,
      });
      if (!contact) throw new Error("Student Contact not found");
      contactId = contact._id;
      displayName = displayName || contact.name;
    }
    const profile = await PublicProfile.create({
      workspaceId: req.auth.workspaceId,
      ownerType,
      userId,
      coachProfileId,
      contactId,
      ...service.profileInput({ ...req.body, displayName, status: "draft" }),
    });
    res.status(201).json({ success: true, data: profile });
  } catch (error) {
    res.status(400).json({
      error:
        error.code === 11000
          ? "A public profile already exists for this person or URL"
          : error.message,
    });
  }
});
router.patch("/profiles/:id", admin, async (req, res) => {
  try {
    const profile = await PublicProfile.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    Object.assign(
      profile,
      service.profileInput({ ...profile.toObject(), ...req.body }),
    );
    profile.moderatedBy = req.auth.user._id;
    await profile.save();
    res.json({ success: true, data: profile });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post("/profiles/:id/edit-token", admin, async (req, res) => {
  const profile = await PublicProfile.findOne({
    _id: req.params.id,
    workspaceId: req.auth.workspaceId,
    ownerType: "student",
  });
  if (!profile)
    return res.status(404).json({ error: "Student profile not found" });
  const token = await service.issueToken(
    profile,
    req.auth.workspaceId,
    req.auth.user._id,
  );
  res.status(201).json({
    success: true,
    data: { editPath: `/profile/edit/${token}`, expiresInDays: 30 },
  });
});
router.get(
  "/profile/me",
  requireCapability("coaching.view_assigned"),
  async (req, res) => {
    const coach = await CoachProfile.findOne({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
    });
    const profile = coach
      ? await PublicProfile.findOne({
          workspaceId: req.auth.workspaceId,
          coachProfileId: coach._id,
        })
      : null;
    res.json({ success: true, data: profile });
  },
);
router.put(
  "/profile/me",
  requireCapability("coaching.view_assigned"),
  async (req, res) => {
    try {
      const coach = await CoachProfile.findOne({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.user._id,
        status: "active",
      });
      if (!coach)
        return res.status(403).json({ error: "Active coach profile required" });
      let profile = await PublicProfile.findOne({
        workspaceId: req.auth.workspaceId,
        coachProfileId: coach._id,
      });
      const values = service.profileInput({
        ...profile?.toObject(),
        ...req.body,
        displayName:
          req.body.displayName || profile?.displayName || coach.displayName,
        slug: req.body.slug || profile?.slug,
      });
      if (!profile)
        profile = new PublicProfile({
          workspaceId: req.auth.workspaceId,
          ownerType: "coach",
          coachProfileId: coach._id,
          userId: req.auth.user._id,
        });
      Object.assign(profile, values);
      await profile.save();
      res.json({ success: true, data: profile });
    } catch (error) {
      res.status(400).json({
        error:
          error.code === 11000
            ? "That profile URL is already used"
            : error.message,
      });
    }
  },
);
module.exports = router;
