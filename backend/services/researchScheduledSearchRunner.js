const Audience = require("../models/Audience");
const MarketResearchJob = require("../models/MarketResearchJob");
const { runMarketResearchJob } = require("./externalMarketResearchService");
const { autoEnrollPeopleForCampaign, MAX_ORGANIZATIONS_PER_RUN } = require("./audienceAutoEnrollmentService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

function localParts(date, timezone) {
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  return { dateKey, time, weekdayIndex };
}

function isDue(audience, now) {
  const schedule = audience.scheduledSearch || {};
  if (!schedule.enabled) return false;
  let parts;
  try {
    parts = localParts(now, schedule.timezone || "America/New_York");
  } catch {
    return false;
  }
  if (parts.dateKey === schedule.lastRunDateKey) return false;
  if (!(schedule.days || []).includes(parts.weekdayIndex)) return false;
  return parts.time >= (schedule.time || "08:00");
}

let timer = null;
let running = false;

async function runDueScheduledSearches() {
  if (running) return [];
  running = true;
  try {
    const now = new Date();
    const candidates = await Audience.find({ "scheduledSearch.enabled": true }).select("_id workspaceId scheduledSearch");
    const results = [];
    for (const audience of candidates) {
      if (!isDue(audience, now)) continue;
      const { dateKey } = localParts(now, audience.scheduledSearch.timezone || "America/New_York");
      // Claimed atomically so an overlapping tick can never rerun the same
      // saved search twice for the same calendar day.
      const claimed = await Audience.findOneAndUpdate(
        { _id: audience._id, "scheduledSearch.lastRunDateKey": { $ne: dateKey } },
        { $set: { "scheduledSearch.lastRunDateKey": dateKey, "scheduledSearch.lastRunAt": now } },
      );
      if (!claimed) continue;
      try {
        await runWithWorkspace(audience.workspaceId, async () => {
          const priorJob = await MarketResearchJob.findOne({ audienceId: audience._id }).sort({ createdAt: -1 });
          if (!priorJob) return;
          const job = await MarketResearchJob.create({
            workspaceId: audience.workspaceId,
            userId: priorJob.userId || null,
            audienceId: audience._id,
            question: priorJob.question,
            plan: priorJob.plan,
            sourceId: priorJob.sourceId,
            status: "queued",
          });
          await runMarketResearchJob(job._id, { maxResults: 300 });
          results.push({ audienceId: audience._id, jobId: job._id });

          if (audience.scheduledSearch.autoEnrollCampaignId) {
            const refreshed = await Audience.findById(audience._id).select("organizationIds scheduledSearch.autoEnrolledOrganizationIds");
            const alreadyProcessed = new Set((refreshed?.scheduledSearch?.autoEnrolledOrganizationIds || []).map(String));
            const unprocessed = (refreshed?.organizationIds || []).filter((id) => !alreadyProcessed.has(String(id)));
            if (unprocessed.length) {
              const batch = unprocessed.slice(0, MAX_ORGANIZATIONS_PER_RUN);
              try {
                const enrollment = await autoEnrollPeopleForCampaign({
                  workspaceId: audience.workspaceId,
                  campaignId: audience.scheduledSearch.autoEnrollCampaignId,
                  organizationIds: batch,
                });
                results.push({ audienceId: audience._id, autoEnrollment: enrollment });
              } finally {
                // Mark this batch processed regardless of outcome — a
                // transient Apollo failure on one organization should not
                // make the poller retry (and re-bill) it every single tick.
                await Audience.updateOne({ _id: audience._id }, { $addToSet: { "scheduledSearch.autoEnrolledOrganizationIds": { $each: batch } } });
              }
            }
          }
        });
      } catch (error) {
        console.error("Scheduled search failed:", { audienceId: String(audience._id), message: error.message });
      }
    }
    return results;
  } finally {
    running = false;
  }
}

function startResearchScheduledSearchRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(15000, Number(process.env.RESEARCH_SCHEDULED_SEARCH_INTERVAL_MS) || 5 * 60000);
  timer = setInterval(() => runDueScheduledSearches().catch((error) => console.error("Research scheduled search runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}

function stopResearchScheduledSearchRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runDueScheduledSearches, startResearchScheduledSearchRunner, stopResearchScheduledSearchRunner, isDue };
