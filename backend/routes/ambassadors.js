const express = require("express");
const AmbassadorProfile = require("../models/AmbassadorProfile");
const service = require("../services/ambassadorService");
const workspaceMemberService = require("../services/workspaceMemberService");
const welcomeService = require("../services/ambassadorWelcomeService");
const contentTasks = require("../services/ambassadorContentService");
const referralIdentity = require("../services/ambassadorReferralIdentityService");
const resourceService = require("../services/ambassadorResourceService");
const CrmActivity = require("../models/CrmActivity");
const InAppNotification = require("../models/InAppNotification");
const { requireCapability } = require("../middleware/auth");
const router = express.Router();
const admin = requireCapability("ambassadors.manage");
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actorId = (req) => req.auth.user._id;
router.use(requireCapability("ambassadors.view_own", "ambassadors.view", "ambassadors.manage"));
router.get("/me", asyncRoute(async (req, res) => res.json({ success: true, data: await service.ownProfileWithCompleteness({ workspaceId: req.auth.workspaceId, userId: actorId(req) }) })));
router.get("/me/content-tasks", asyncRoute(async (req, res) => res.json(await contentTasks.ownTasks({ workspaceId: req.auth.workspaceId, userId: actorId(req) }))));
router.get("/me/notifications", asyncRoute(async (req, res) => res.json(await InAppNotification.find({ workspaceId: req.auth.workspaceId, userId: actorId(req), type: "ambassador_reminder" }).select("title message readAt createdAt").sort({ createdAt: -1 }).limit(50).lean())));
router.get("/:id/history", admin, asyncRoute(async (req, res) => {
  const profile = await AmbassadorProfile.findOne({ _id: req.params.id, workspaceId: req.auth.workspaceId }).lean();
  if (!profile) return res.status(404).json({ error: "Ambassador not found" });
  const history = await CrmActivity.find({ workspaceId: req.auth.workspaceId, $or: [{ "metadata.ambassadorProfileId": profile._id }, { "metadata.userId": profile.userId, "metadata.eventType": /^team\.invitation\./ }] }).select("title occurredAt").sort({ occurredAt: -1 }).limit(100).lean();
  res.json(history);
}));
router.patch("/me/content-tasks/:id", asyncRoute(async (req, res) => res.json(await contentTasks.transition({ workspaceId: req.auth.workspaceId, userId: actorId(req), taskId: req.params.id, status: req.body.status, postUrl: req.body.postUrl }))));
router.patch("/me", asyncRoute(async (req, res) => res.json({ success: true, data: await service.updateOwnProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req), changes: req.body || {} }) })));
router.get("/me/referrals", asyncRoute(async (req, res) => { const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) }); res.json({ success: true, data: await service.ownReferrals({ workspaceId: req.auth.workspaceId, ambassadorProfileId: profile._id }) }); }));
router.post("/me/referrals", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) });
  const result = await service.submitReferral({ workspaceId: req.auth.workspaceId, ambassadorProfileId: profile._id, actorUserId: actorId(req), name: req.body?.name, email: req.body?.email, phone: req.body?.phone, source: req.body?.source, consentGiven: req.body?.consentGiven === true });
  res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
}));
router.post("/me/referrals/:id/notes", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) });
  res.status(201).json({ success: true, data: await service.addFollowUpNote({ workspaceId: req.auth.workspaceId, ambassadorProfileId: profile._id, attributionId: req.params.id, userId: actorId(req), note: req.body?.note, reminderAt: req.body?.reminderAt }) });
}));
router.post("/me/referrals/:id/dispute", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) });
  res.status(201).json({ success: true, data: await service.fileDispute({ workspaceId: req.auth.workspaceId, ambassadorProfileId: profile._id, attributionId: req.params.id, userId: actorId(req), reason: req.body?.reason }) });
}));
router.patch("/referrals/:id/dispute", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await service.resolveDispute({ workspaceId: req.auth.workspaceId, attributionId: req.params.id, actorUserId: actorId(req), status: req.body?.status, resolution: req.body?.resolution }) })));
router.get("/me/payouts", asyncRoute(async (req, res) => { const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) }); res.json({ success: true, data: await service.ownPayouts({ workspaceId: req.auth.workspaceId, ambassadorProfileId: profile._id }) }); }));
router.get("/", requireCapability("ambassadors.view", "ambassadors.manage"), asyncRoute(async (req, res) => {
  const profiles = await AmbassadorProfile.find({ workspaceId: req.auth.workspaceId }).populate("userId", "name email lastLoginAt avatarUrl").sort({ displayName: 1 }).lean();
  res.json({ success: true, data: profiles.map((profile) => ({ ...profile, displayName: profile.userId?.name || profile.displayName, referralUrl: referralIdentity.referralUrl(profile.referralSlug || profile.referralCode) })) });
}));
router.post("/", admin, asyncRoute(async (req, res) => { const data = await workspaceMemberService.onboardAmbassador({ ...req.body, workspaceId: req.auth.workspaceId, actorUserId: actorId(req) }); const lifecycle = data.membership.status === "active" ? "ambassador_profile_active" : "invite_ready"; res.status(data.alreadyActive ? 200 : 201).json({ success: true, data: { profile: data.ambassadorProfile, lifecycle, invitation: data.invitation ? { id: data.invitation._id, status: data.invitation.status, deliveryStatus: data.invitation.deliveryStatus, roleKey: data.invitation.roleKey, templateVersion: data.invitation.templateVersion, subject: data.invitation.subject, body: data.invitation.body, expiresAt: data.invitation.expiresAt } : null } }); }));
router.get("/welcome-template", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await welcomeService.getTemplate(req.auth.workspaceId) })));
router.put("/welcome-template", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await welcomeService.saveTemplate({ workspaceId: req.auth.workspaceId, input: req.body || {}, userId: actorId(req) }) })));
router.post("/:id/welcome-content", admin, asyncRoute(async (req, res) => res.status(201).json({ success: true, data: await welcomeService.generate({ workspaceId: req.auth.workspaceId, ambassadorProfileId: req.params.id, userId: actorId(req) }) })));
router.patch("/:id/referral-identity", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await referralIdentity.updateIdentity({ workspaceId: req.auth.workspaceId, profileId: req.params.id, referralCode: req.body?.referralCode, regenerate: req.body?.regenerate === true, actorUserId: actorId(req) }) })));
router.patch("/:id", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await service.updateProfile({ workspaceId: req.auth.workspaceId, profileId: req.params.id, changes: req.body || {} }) })));
router.patch("/:id/status", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await service.setStatus({ workspaceId: req.auth.workspaceId, profileId: req.params.id, status: req.body?.status }) })));
router.get("/:id/referrals", requireCapability("ambassadors.view", "ambassadors.manage"), asyncRoute(async (req, res) => res.json({ success: true, data: await service.referrals({ workspaceId: req.auth.workspaceId, ambassadorProfileId: req.params.id }) })));
router.patch("/referrals/:id/state", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await service.transitionReferral({ workspaceId: req.auth.workspaceId, attributionId: req.params.id, state: req.body?.state, actorUserId: actorId(req) }) })));
router.get("/:id/payouts", requireCapability("ambassadors.view", "ambassadors.manage"), asyncRoute(async (req, res) => res.json({ success: true, data: await service.payouts({ workspaceId: req.auth.workspaceId, ambassadorProfileId: req.params.id }) })));
router.post("/payouts", admin, asyncRoute(async (req, res) => res.status(201).json({ success: true, data: await service.createPayout({ ...req.body, workspaceId: req.auth.workspaceId, actorUserId: actorId(req) }) })));
router.patch("/payouts/:id/status", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await service.transitionPayout({ workspaceId: req.auth.workspaceId, payoutId: req.params.id, status: req.body?.status, notes: req.body?.notes, actorUserId: actorId(req) }) })));

/**
 * Ambassador Resource Center. Admin CRUD is capability-gated; ambassador
 * browsing/download/acknowledge is visibility-filtered per resource and
 * never exposes a stored/permanent file URL — every download re-fetches a
 * fresh, short-lived signed URL from Cloudinary at request time.
 */
router.get("/resources", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await resourceService.listForAdmin({ workspaceId: req.auth.workspaceId, category: req.query.category, status: req.query.status }) })));
router.post("/resources", admin, asyncRoute(async (req, res) => res.status(201).json({ success: true, data: await resourceService.create({ ...req.body, workspaceId: req.auth.workspaceId, userId: actorId(req) }) })));
router.patch("/resources/:id", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await resourceService.updateMetadata({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req), changes: req.body || {} }) })));
router.post("/resources/:id/versions", admin, asyncRoute(async (req, res) => res.status(201).json({ success: true, data: await resourceService.addVersion({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req), fileDataUri: req.body?.fileDataUri, fileName: req.body?.fileName, changeNotes: req.body?.changeNotes }) })));
router.patch("/resources/:id/jarvis-approval", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await resourceService.setJarvisApproval({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, approved: req.body?.approved === true }) })));
router.post("/resources/:id/archive", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await resourceService.archive({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req) }) })));
router.get("/resources/:id/history", admin, asyncRoute(async (req, res) => res.json({ success: true, data: await resourceService.accessHistory({ workspaceId: req.auth.workspaceId, resourceId: req.params.id }) })));

router.get("/me/resources", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) }).catch(() => null);
  res.json({ success: true, data: await resourceService.listForViewer({ workspaceId: req.auth.workspaceId, userId: actorId(req), ambassadorProfileId: profile?._id || null, search: req.query.search || "" }) });
}));
router.post("/me/resources/:id/download", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) }).catch(() => null);
  const { buffer, fileName, mimeType } = await resourceService.recordAccessAndGetDownload({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req), ambassadorProfileId: profile?._id || null, action: "download" });
  res.set({ "Content-Type": mimeType || "application/octet-stream", "Content-Disposition": `attachment; filename="${fileName.replace(/[^\w.\- ]/g, "_")}"`, "Content-Length": buffer.length });
  res.send(buffer);
}));
router.post("/me/resources/:id/view", asyncRoute(async (req, res) => {
  const profile = await service.ownProfile({ workspaceId: req.auth.workspaceId, userId: actorId(req) }).catch(() => null);
  res.json({ success: true, data: await resourceService.recordAccessAndGetDownload({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req), ambassadorProfileId: profile?._id || null, action: "view" }) });
}));
router.post("/me/resources/:id/acknowledge", asyncRoute(async (req, res) => {
  res.status(201).json({ success: true, data: await resourceService.acknowledge({ workspaceId: req.auth.workspaceId, resourceId: req.params.id, userId: actorId(req) }) });
}));

module.exports = router;
