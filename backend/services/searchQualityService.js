/**
 * Search-quality feedback loop: ties each Discovery monitor's real output
 * (buckets, approvals, dismissals) to real downstream CRM outcomes
 * (opportunities, enrollments, won revenue) so monitor quality is measured
 * by qualified applications and enrolled students — not raw result volume.
 * Entirely deterministic; no OpenAI calls.
 */
const ResearchMonitor = require("../models/ResearchMonitor");
const IntentSignal = require("../models/IntentSignal");
const SalesOpportunity = require("../models/SalesOpportunity");
const Enrollment = require("../models/Enrollment");
const CoachingProgram = require("../models/CoachingProgram");
const researchMonitorService = require("./researchMonitorService");
const { buildProgramProfiles } = require("./leadDiscoveryTaxonomy");

const deps = { ResearchMonitor, IntentSignal, SalesOpportunity, Enrollment, CoachingProgram };

// Buckets are re-derived live from each signal's real content rather than trusting the stored
// `bucket` field, so performance stays accurate for signals collected before the bucket system
// existed (their stored value is just the schema default) without requiring a data migration.
function liveBucketFor(signal, monitor, programProfiles) {
  if (!monitor) return "live_lead";
  const eligibility = researchMonitorService.signalEligibility(signal, monitor, programProfiles);
  const ranking = researchMonitorService.scoreSignal(signal, monitor, programProfiles);
  return researchMonitorService.classifySignalBucket({ signal, monitor, eligibility, ranking }).bucket;
}

async function getMonitorPerformance(workspaceId, models = deps) {
  const [monitors, rawSignals, opportunities, programs] = await Promise.all([
    models.ResearchMonitor.find({ workspaceId }).select("name monitorType enabled totals lastRunStatus lastRunAt createdAt keywords intentCategories negativeKeywords locations").lean(),
    models.IntentSignal.find({ workspaceId }).lean(),
    models.SalesOpportunity.find({ workspaceId, "leadAttribution.monitorId": { $ne: null } }).select("leadAttribution.monitorId stageKey value wonAt").lean(),
    models.CoachingProgram.find({ workspaceId, status: "active" }).select("name internalSummary publicPresentation.summary status").lean(),
  ]);
  const programProfiles = buildProgramProfiles(programs);
  const monitorMap = new Map(monitors.map((m) => [String(m._id), m]));
  const signals = rawSignals.map((s) => ({ ...s, liveBucket: liveBucketFor(s, monitorMap.get(String(s.monitorId)), programProfiles) }));
  const oppsByMonitor = new Map();
  for (const opp of opportunities) {
    const key = String(opp.leadAttribution.monitorId);
    if (!oppsByMonitor.has(key)) oppsByMonitor.set(key, []);
    oppsByMonitor.get(key).push(opp);
  }
  const enrollments = await models.Enrollment.find({ workspaceId, sourceOpportunityId: { $in: opportunities.map((o) => o._id) } }).select("sourceOpportunityId").lean();
  const enrolledOppIds = new Set(enrollments.map((e) => String(e.sourceOpportunityId)));

  const performance = monitors.map((monitor) => {
    const key = String(monitor._id);
    const monitorSignals = signals.filter((s) => String(s.monitorId) === key);
    const buckets = { live_lead: 0, watchlist: 0, community_opportunity: 0, rejected: 0 };
    for (const s of monitorSignals) buckets[s.liveBucket] = (buckets[s.liveBucket] || 0) + 1;
    const approved = monitorSignals.filter((s) => ["qualified", "converted"].includes(s.status)).length;
    const dismissed = monitorSignals.filter((s) => s.status === "dismissed").length;
    const opps = oppsByMonitor.get(key) || [];
    const won = opps.filter((o) => o.stageKey === "won");
    const enrolled = opps.filter((o) => enrolledOppIds.has(String(o._id)));
    const revenue = won.reduce((sum, o) => sum + (Number(o.value) || 0), 0);
    const totalCandidates = monitorSignals.length;
    const rejectionRate = totalCandidates ? Math.round((buckets.rejected / totalCandidates) * 100) : 0;
    const conversionRate = buckets.live_lead ? Math.round((enrolled.length / buckets.live_lead) * 100) : 0;
    return {
      monitorId: monitor._id, name: monitor.name, monitorType: monitor.monitorType || "buyer_intent", enabled: monitor.enabled, lastRunStatus: monitor.lastRunStatus, lastRunAt: monitor.lastRunAt,
      totalCandidates, buckets, approved, dismissed, opportunities: opps.length, enrolled: enrolled.length, wonRevenue: Math.round(revenue), rejectionRate, conversionRate,
    };
  });
  return performance.sort((a, b) => (b.wonRevenue - a.wonRevenue) || (b.enrolled - a.enrolled) || (b.buckets.live_lead - a.buckets.live_lead));
}

/** Deterministic, evidence-based recommendations — never an unexplained opinion. */
function recommendationsFor(performance) {
  const recommendations = [];
  for (const monitor of performance) {
    if (monitor.totalCandidates >= 15 && monitor.rejectionRate >= 85) {
      recommendations.push({ monitorId: monitor.monitorId, monitorName: monitor.name, issue: "high_rejection_rate", severity: "medium", detail: `${monitor.rejectionRate}% of ${monitor.totalCandidates} candidates were rejected. Narrow the keywords, add more specific exclusion terms, or split into smaller focused searches.` });
    }
    if (monitor.enabled && monitor.buckets.live_lead >= 8 && monitor.enrolled === 0) {
      recommendations.push({ monitorId: monitor.monitorId, monitorName: monitor.name, issue: "no_conversions", severity: "high", detail: `${monitor.buckets.live_lead} live leads found but zero enrollments so far. Review whether Closer follow-up is happening on these leads, or whether the qualification bar needs adjusting.` });
    }
    if (monitor.enabled && monitor.lastRunStatus === "failed") {
      recommendations.push({ monitorId: monitor.monitorId, monitorName: monitor.name, issue: "monitor_failing", severity: "high", detail: "This monitor's last run failed. Check its source configuration and recent activity log." });
    }
    if (!monitor.enabled && monitor.wonRevenue > 0) {
      recommendations.push({ monitorId: monitor.monitorId, monitorName: monitor.name, issue: "disabled_but_productive", severity: "medium", detail: `This monitor is disabled but has generated $${monitor.wonRevenue.toLocaleString()} in won revenue historically. Consider re-enabling it.` });
    }
    if (monitor.enabled && monitor.totalCandidates === 0) {
      recommendations.push({ monitorId: monitor.monitorId, monitorName: monitor.name, issue: "no_results", severity: "low", detail: "This monitor has found nothing yet. Its keywords or sources may be too narrow, or it may not have run recently." });
    }
  }
  return recommendations.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.severity] - { high: 3, medium: 2, low: 1 }[a.severity]));
}

module.exports = { getMonitorPerformance, recommendationsFor };
