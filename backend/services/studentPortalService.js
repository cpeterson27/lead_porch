const crypto = require("crypto");
const Enrollment = require("../models/Enrollment");
const Contact = require("../models/Contact");
const CoachingProgram = require("../models/CoachingProgram");
const CourseModule = require("../models/CourseModule");
const ModuleCompletion = require("../models/ModuleCompletion");
const PortalAccessToken = require("../models/PortalAccessToken");
const CoachingSession = require("../models/CoachingSession");
const CrmActivity = require("../models/CrmActivity");

const PORTAL_TOKEN_DAYS = 365;

function portalError(message, code = "PORTAL_ERROR") {
  return Object.assign(new Error(message), { code });
}

// One token per enrollment — reissuing replaces rather than piling up
// live links for the same student, so an old copy/paste of the link
// (screenshot, forwarded email) can be invalidated by reissuing.
async function issuePortalLink({ workspaceId, enrollmentId, userId }) {
  const enrollment = await Enrollment.findOne({ _id: enrollmentId, workspaceId });
  if (!enrollment) throw portalError("Enrollment not found", "ENROLLMENT_NOT_FOUND");
  await PortalAccessToken.deleteMany({ workspaceId, enrollmentId });
  const raw = crypto.randomBytes(32).toString("base64url");
  await PortalAccessToken.create({
    workspaceId, enrollmentId,
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + PORTAL_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    createdBy: userId || null,
  });
  return raw;
}

async function resolveToken(raw) {
  const tokenHash = crypto.createHash("sha256").update(String(raw || "")).digest("hex");
  const record = await PortalAccessToken.findOne({ tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } }).select("+tokenHash");
  if (!record) throw portalError("This portal link is invalid or has expired. Ask your coach for a new one.", "PORTAL_TOKEN_INVALID");
  record.lastUsedAt = new Date();
  await record.save();
  return record;
}

function weekUnlocksAt(enrollment, weekNumber) {
  const start = new Date(enrollment.startsAt);
  start.setDate(start.getDate() + (weekNumber - 1) * 7);
  return start;
}

async function getPortalData(raw) {
  const token = await resolveToken(raw);
  const enrollment = await Enrollment.findOne({ _id: token.enrollmentId, workspaceId: token.workspaceId });
  if (!enrollment) throw portalError("This enrollment is no longer available", "ENROLLMENT_NOT_FOUND");
  const [contact, program, modules, completions, sessions] = await Promise.all([
    Contact.findOne({ _id: enrollment.contactId, workspaceId: token.workspaceId }).select("name firstName email").lean(),
    CoachingProgram.findOne({ _id: enrollment.coachingProgramId, workspaceId: token.workspaceId }).select("name description").lean(),
    CourseModule.find({ workspaceId: token.workspaceId, coachingProgramId: enrollment.coachingProgramId }).sort({ weekNumber: 1 }).lean(),
    ModuleCompletion.find({ workspaceId: token.workspaceId, enrollmentId: enrollment._id }).lean(),
    CoachingSession.find({ workspaceId: token.workspaceId, contactId: enrollment.contactId, startsAt: { $gte: new Date() }, status: "scheduled" }).sort({ startsAt: 1 }).limit(5).select("startsAt durationMinutes videoMode zoom.joinUrl calendar.htmlLink").lean(),
  ]);
  const completedIds = new Set(completions.map((row) => String(row.courseModuleId)));
  const now = new Date();
  const items = modules.map((module) => {
    const unlocksAt = weekUnlocksAt(enrollment, module.weekNumber);
    const unlocked = unlocksAt <= now;
    return {
      _id: module._id, weekNumber: module.weekNumber, title: module.title,
      description: unlocked ? module.description : "", resources: unlocked ? module.resources : [], homeworkPrompt: unlocked ? module.homeworkPrompt : "",
      unlocked, unlocksAt, completed: completedIds.has(String(module._id)),
    };
  });
  return {
    student: { name: contact?.name || contact?.firstName || "", email: contact?.email || "" },
    program: { name: program?.name || "", description: program?.description || "" },
    enrollment: { status: enrollment.status, startsAt: enrollment.startsAt, expectedEndAt: enrollment.expectedEndAt },
    modules: items,
    progress: { completed: items.filter((item) => item.completed).length, total: items.length },
    upcomingSessions: sessions,
  };
}

async function markModuleComplete({ raw, courseModuleId }) {
  const token = await resolveToken(raw);
  const module = await CourseModule.findOne({ _id: courseModuleId, workspaceId: token.workspaceId }).lean();
  if (!module) throw portalError("Module not found", "MODULE_NOT_FOUND");
  const enrollment = await Enrollment.findOne({ _id: token.enrollmentId, workspaceId: token.workspaceId });
  if (weekUnlocksAt(enrollment, module.weekNumber) > new Date()) throw portalError("This week isn't unlocked yet", "MODULE_LOCKED");
  await ModuleCompletion.findOneAndUpdate(
    { workspaceId: token.workspaceId, enrollmentId: token.enrollmentId, courseModuleId },
    { $setOnInsert: { completedAt: new Date() } },
    { upsert: true },
  );
  const [totalModules, completedModules] = await Promise.all([
    CourseModule.countDocuments({ workspaceId: token.workspaceId, coachingProgramId: enrollment.coachingProgramId }),
    ModuleCompletion.countDocuments({ workspaceId: token.workspaceId, enrollmentId: token.enrollmentId }),
  ]);
  // Fires a normal CrmActivity marker so this shows up on the contact
  // timeline immediately. Certificate/testimonial-request/referral-request/
  // upsell automations (checklist section 7) aren't wired to this event
  // yet — that's real follow-up work, not done here, flagged separately.
  if (totalModules > 0 && completedModules >= totalModules) {
    await CrmActivity.create({ workspaceId: token.workspaceId, contactId: enrollment.contactId, type: "system", title: "Student completed all program modules", source: "system", metadata: { eventType: "coaching.program.modules_completed", enrollmentId: enrollment._id } });
  }
  return getPortalData(raw);
}

module.exports = { issuePortalLink, getPortalData, markModuleComplete };
