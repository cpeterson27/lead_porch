const CoachProfile = require("../models/CoachProfile");
const CoachingProgram = require("../models/CoachingProgram");
const Enrollment = require("../models/Enrollment");
const Contact = require("../models/Contact");
const SalesOpportunity = require("../models/SalesOpportunity");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const CrmActivity = require("../models/CrmActivity");
const ReferralAttribution = require("../models/ReferralAttribution");

const dependencies = { CoachProfile, CoachingProgram, Enrollment, Contact, SalesOpportunity, WorkspaceMembership, CrmActivity, ReferralAttribution };

function domainError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireWorkspaceId(workspaceId) {
  if (!workspaceId) throw domainError("workspaceId is required", "WORKSPACE_REQUIRED");
  return workspaceId;
}

function normalizeStages(stages = []) {
  if (!Array.isArray(stages)) throw domainError("Program stages must be an array", "STAGES_INVALID");
  const keys = new Set();
  return stages.map((stage, index) => {
    const key = String(stage?.key || stage?.label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
    if (!key || keys.has(key)) throw domainError("Every program stage needs a unique key", "STAGES_INVALID");
    keys.add(key);
    return {
      key,
      label: String(stage?.label || key).trim().slice(0, 120),
      order: Number.isFinite(Number(stage?.order)) ? Math.max(0, Number(stage.order)) : index,
      defaultDuration: {
        value: stage?.defaultDuration?.value == null ? null : Math.max(0, Number(stage.defaultDuration.value) || 0),
        unit: ["days", "weeks", "months"].includes(stage?.defaultDuration?.unit) ? stage.defaultDuration.unit : "",
      },
    };
  }).sort((a, b) => a.order - b.order);
}

async function recordActivity(models, { workspaceId, contactId, eventType, title, body = "", metadata = {}, createdBy = null }) {
  return models.CrmActivity.create({
    workspaceId,
    contactId,
    type: "system",
    title,
    body,
    source: "crm",
    createdBy,
    metadata: { ...metadata, eventType },
  });
}

async function createCoachProfile(input, models = dependencies) {
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const membership = await models.WorkspaceMembership.findOne({
    workspaceId,
    userId: input.userId,
    status: "active",
    $or: [{ role: { $in: ["owner", "admin", "coach"] } }, { roles: { $in: ["owner", "admin", "coach"] } }],
  }).lean();
  if (!membership) throw domainError("Coach user must be an active member of this workspace", "COACH_MEMBERSHIP_REQUIRED");

  return models.CoachProfile.create({
    workspaceId,
    userId: input.userId,
    displayName: String(input.displayName || "").trim(),
    status: "active",
    timezone: String(input.timezone || "").trim(),
    capacity: input.capacity == null ? null : Math.max(0, Number(input.capacity) || 0),
  });
}

async function updateCoachProfile({ workspaceId, coachProfileId, changes }, models = dependencies) {
  requireWorkspaceId(workspaceId);
  const update = {};
  if (changes.displayName !== undefined) update.displayName = String(changes.displayName || "").trim();
  if (changes.timezone !== undefined) update.timezone = String(changes.timezone || "").trim();
  if (changes.capacity !== undefined) update.capacity = changes.capacity == null ? null : Math.max(0, Number(changes.capacity) || 0);
  const profile = await models.CoachProfile.findOneAndUpdate({ _id: coachProfileId, workspaceId }, { $set: update }, { new: true, runValidators: true });
  if (!profile) throw domainError("Coach profile not found", "COACH_NOT_FOUND");
  return profile;
}

async function deactivateCoachProfile({ workspaceId, coachProfileId, at = new Date() }, models = dependencies) {
  requireWorkspaceId(workspaceId);
  const profile = await models.CoachProfile.findOneAndUpdate(
    { _id: coachProfileId, workspaceId },
    { $set: { status: "inactive", deactivatedAt: at } },
    { new: true, runValidators: true },
  );
  if (!profile) throw domainError("Coach profile not found", "COACH_NOT_FOUND");
  return profile;
}

async function activateCoachProfile({ workspaceId, coachProfileId }, models = dependencies) {
  requireWorkspaceId(workspaceId);
  const existing = await models.CoachProfile.findOne({ _id: coachProfileId, workspaceId }).lean();
  if (!existing) throw domainError("Coach profile not found", "COACH_NOT_FOUND");
  const membership = await models.WorkspaceMembership.findOne({
    workspaceId,
    userId: existing.userId,
    status: "active",
    $or: [{ role: { $in: ["owner", "admin", "coach"] } }, { roles: { $in: ["owner", "admin", "coach"] } }],
  }).lean();
  if (!membership) throw domainError("Coach user must be an active member of this workspace", "COACH_MEMBERSHIP_REQUIRED");
  return models.CoachProfile.findOneAndUpdate(
    { _id: coachProfileId, workspaceId },
    { $set: { status: "active", deactivatedAt: null } },
    { new: true, runValidators: true },
  );
}

async function createCoachingProgram(input, models = dependencies) {
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const name = String(input.name || "").trim();
  if (!name) throw domainError("Program name is required", "PROGRAM_NAME_REQUIRED");
  return models.CoachingProgram.create({
    workspaceId,
    name,
    internalSummary: String(input.internalSummary || "").trim(),
    targetAudience: String(input.targetAudience || "").trim(),
    status: input.status === "active" ? "active" : "draft",
    duration: input.duration || {},
    defaultPrice: input.defaultPrice || {},
    stages: normalizeStages(input.stages),
    version: 1,
  });
}

async function updateCoachingProgram({ workspaceId, coachingProgramId, changes }, models = dependencies) {
  requireWorkspaceId(workspaceId);
  const program = await models.CoachingProgram.findOne({ _id: coachingProgramId, workspaceId });
  if (!program) throw domainError("Coaching program not found", "PROGRAM_NOT_FOUND");
  if (program.status === "archived") throw domainError("Archived programs cannot be edited", "PROGRAM_ARCHIVED");
  if (changes.name !== undefined) program.name = String(changes.name || "").trim();
  if (changes.internalSummary !== undefined) program.internalSummary = String(changes.internalSummary || "").trim();
  if (changes.targetAudience !== undefined) program.targetAudience = String(changes.targetAudience || "").trim();
  if (changes.duration !== undefined) program.duration = changes.duration;
  if (changes.defaultPrice !== undefined) program.defaultPrice = changes.defaultPrice;
  if (changes.stages !== undefined) program.stages = normalizeStages(changes.stages);
  if (changes.status !== undefined && ["draft", "active"].includes(changes.status)) program.status = changes.status;
  program.version += 1;
  await program.save();
  return program;
}

async function archiveCoachingProgram({ workspaceId, coachingProgramId, at = new Date() }, models = dependencies) {
  requireWorkspaceId(workspaceId);
  const program = await models.CoachingProgram.findOneAndUpdate(
    { _id: coachingProgramId, workspaceId },
    { $set: { status: "archived", archivedAt: at } },
    { new: true, runValidators: true },
  );
  if (!program) throw domainError("Coaching program not found", "PROGRAM_NOT_FOUND");
  return program;
}

function programSnapshot(program) {
  return {
    name: program.name,
    duration: program.duration?.toObject?.() || program.duration || {},
    defaultPrice: program.defaultPrice?.toObject?.() || program.defaultPrice || {},
    stages: (program.stages || []).map((stage) => stage.toObject?.() || { ...stage }),
  };
}

async function createEnrollment(input, models = dependencies) {
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const [contact, program] = await Promise.all([
    models.Contact.findOne({ _id: input.contactId, workspaceId }).lean(),
    models.CoachingProgram.findOne({ _id: input.coachingProgramId, workspaceId }).lean(),
  ]);
  if (!contact) throw domainError("Contact must belong to this workspace", "CONTACT_WORKSPACE_MISMATCH");
  if (!program) throw domainError("Coaching program must belong to this workspace", "PROGRAM_WORKSPACE_MISMATCH");
  if (program.status === "archived") throw domainError("Archived programs cannot receive new enrollments", "PROGRAM_ARCHIVED");

  let opportunity = null;
  if (input.sourceOpportunityId) {
    opportunity = await models.SalesOpportunity.findOne({ _id: input.sourceOpportunityId, workspaceId }).lean();
    if (!opportunity) throw domainError("Sales opportunity must belong to this workspace", "OPPORTUNITY_WORKSPACE_MISMATCH");
    if (opportunity.primaryContactId && String(opportunity.primaryContactId) !== String(contact._id)) {
      throw domainError("Sales opportunity belongs to a different contact", "OPPORTUNITY_CONTACT_MISMATCH");
    }
  }

  const firstStage = [...(program.stages || [])].sort((a, b) => a.order - b.order)[0];
  const enrollment = await models.Enrollment.create({
    workspaceId,
    contactId: contact._id,
    coachingProgramId: program._id,
    sourceOpportunityId: opportunity?._id || null,
    status: input.status === "active" ? "active" : "pending",
    startsAt: input.startsAt || new Date(),
    expectedEndAt: input.expectedEndAt || null,
    currentStageKey: input.currentStageKey || firstStage?.key || "",
    programVersion: program.version,
    programSnapshot: programSnapshot(program),
    createdBy: input.createdBy || null,
  });
  await recordActivity(models, {
    workspaceId,
    contactId: contact._id,
    eventType: "student.enrolled",
    title: "Student enrolled",
    metadata: { enrollmentId: enrollment._id, coachingProgramId: program._id, sourceOpportunityId: opportunity?._id || null },
    createdBy: input.createdBy,
  });
  if (models.ReferralAttribution?.updateOne) await models.ReferralAttribution.updateOne({ workspaceId, contactId: contact._id, promoterType: "ambassador" }, { $set: { enrollmentId: enrollment._id, state: enrollment.status === "active" ? "enrolled" : "qualified" } });
  return enrollment;
}

const ENROLLMENT_TRANSITIONS = Object.freeze({
  pending: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
});

async function transitionEnrollment(input, models = dependencies) {
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const enrollment = await models.Enrollment.findOne({ _id: input.enrollmentId, workspaceId });
  if (!enrollment) throw domainError("Enrollment not found", "ENROLLMENT_NOT_FOUND");
  if (!ENROLLMENT_TRANSITIONS[enrollment.status]?.includes(input.status)) {
    throw domainError(`Enrollment cannot transition from ${enrollment.status} to ${input.status}`, "ENROLLMENT_TRANSITION_INVALID");
  }
  if (input.currentStageKey !== undefined) {
    const validStage = (enrollment.programSnapshot?.stages || []).some((stage) => stage.key === input.currentStageKey);
    if (input.currentStageKey && !validStage) throw domainError("Enrollment stage is not part of its program snapshot", "ENROLLMENT_STAGE_INVALID");
    enrollment.currentStageKey = input.currentStageKey;
  }
  enrollment.status = input.status;
  enrollment.completedAt = input.status === "completed" ? (input.at || new Date()) : null;
  await enrollment.save();
  await recordActivity(models, {
    workspaceId,
    contactId: enrollment.contactId,
    eventType: input.status === "completed" ? "coaching.program.completed" : "coaching.enrollment.transitioned",
    title: input.status === "completed" ? "Coaching program completed" : `Enrollment ${input.status}`,
    metadata: { enrollmentId: enrollment._id, status: input.status, currentStageKey: enrollment.currentStageKey },
    createdBy: input.createdBy,
  });
  if (models.ReferralAttribution?.updateOne) await models.ReferralAttribution.updateOne({ workspaceId, contactId: enrollment.contactId, promoterType: "ambassador" }, { $set: { enrollmentId: enrollment._id, state: input.status === "cancelled" ? "cancelled" : input.status === "completed" ? "converted" : "enrolled" } });
  return enrollment;
}

module.exports = {
  ENROLLMENT_TRANSITIONS,
  activateCoachProfile,
  archiveCoachingProgram,
  createCoachProfile,
  createCoachingProgram,
  createEnrollment,
  deactivateCoachProfile,
  normalizeStages,
  transitionEnrollment,
  updateCoachProfile,
  updateCoachingProgram,
};
