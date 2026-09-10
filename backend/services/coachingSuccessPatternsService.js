/**
 * Aggregated, anonymized successful-student patterns for the Coaching Agent.
 * Every number here is a count or average across enrollments — never a
 * student name, contact detail, or note excerpt. Entirely deterministic.
 */
const Enrollment = require("../models/Enrollment");
const CoachingProgram = require("../models/CoachingProgram");

const deps = { Enrollment, CoachingProgram };

function groupCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

async function getSuccessPatterns(workspaceId, models = deps) {
  const [enrollments, programs] = await Promise.all([
    models.Enrollment.find({ workspaceId }).select("coachingProgramId status startsAt completedAt currentStageKey").lean(),
    models.CoachingProgram.find({ workspaceId }).select("name").lean(),
  ]);
  const programNames = new Map(programs.map((p) => [String(p._id), p.name]));
  const completed = enrollments.filter((e) => e.status === "completed");
  const cancelled = enrollments.filter((e) => e.status === "cancelled");
  const active = enrollments.filter((e) => e.status === "active");
  const durations = completed.map((e) => (e.completedAt && e.startsAt ? Math.round((new Date(e.completedAt) - new Date(e.startsAt)) / 86400000) : null)).filter((value) => Number.isFinite(value) && value >= 0);
  const avgCompletionDays = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
  const commonCancelStages = groupCounts(cancelled.map((e) => e.currentStageKey || "unknown")).slice(0, 5);
  const byProgram = [...new Set(enrollments.map((e) => String(e.coachingProgramId)))].map((programId) => {
    const rows = enrollments.filter((e) => String(e.coachingProgramId) === programId);
    const programCompleted = rows.filter((e) => e.status === "completed").length;
    return { program: programNames.get(programId) || "Unknown program", totalEnrollments: rows.length, completed: programCompleted, cancelled: rows.filter((e) => e.status === "cancelled").length, active: rows.filter((e) => e.status === "active").length, completionRate: rows.length ? Math.round((programCompleted / rows.length) * 100) : 0 };
  }).sort((a, b) => b.totalEnrollments - a.totalEnrollments);
  return {
    totalEnrollments: enrollments.length,
    completed: completed.length,
    cancelled: cancelled.length,
    active: active.length,
    completionRate: enrollments.length ? Math.round((completed.length / enrollments.length) * 100) : 0,
    avgCompletionDays,
    commonCancelStages,
    byProgram,
  };
}

module.exports = { getSuccessPatterns };
