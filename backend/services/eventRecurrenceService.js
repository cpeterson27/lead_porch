const Event = require("../models/Event");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

// How far ahead to keep occurrences generated. Running this sweep every few
// hours and only topping up to a rolling horizon (rather than generating
// everything up to `until` in one shot) means a class Ellie sets up as
// "no end date" never tries to create years of future Events at once.
const HORIZON_DAYS = 56;

function nextOccurrenceDate(date, frequency) {
  const next = new Date(date);
  if (frequency === "monthly") next.setMonth(next.getMonth() + 1);
  else if (frequency === "biweekly") next.setDate(next.getDate() + 14);
  else next.setDate(next.getDate() + 7);
  return next;
}

async function ensureOccurrencesFor(parent) {
  if (!parent.recurrence?.frequency || !parent.startDate) return 0;
  const horizon = new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const until = parent.recurrence.until ? new Date(parent.recurrence.until) : null;
  const durationMs = parent.endDate ? new Date(parent.endDate).getTime() - new Date(parent.startDate).getTime() : 0;
  const latest = await Event.findOne({
    $or: [{ _id: parent._id }, { seriesId: parent._id }],
  })
    .sort({ startDate: -1 })
    .select("startDate")
    .lean();
  let cursor = latest?.startDate ? new Date(latest.startDate) : new Date(parent.startDate);
  let created = 0;
  while (true) {
    const next = nextOccurrenceDate(cursor, parent.recurrence.frequency);
    if (next > horizon) break;
    if (until && next > until) break;
    await Event.create({
      workspaceId: parent.workspaceId,
      name: parent.name,
      description: parent.description,
      summary: parent.summary,
      category: parent.category,
      tags: parent.tags,
      startDate: next,
      endDate: durationMs ? new Date(next.getTime() + durationMs) : undefined,
      timeZone: parent.timeZone,
      locationType: parent.locationType,
      location: parent.location,
      onlineUrl: parent.onlineUrl,
      capacity: parent.capacity,
      status: "active",
      seriesId: parent._id,
    });
    created += 1;
    cursor = next;
  }
  return created;
}

// Unscoped on purpose, same pattern as eventReminderService's own sweep:
// this needs to see every workspace's recurring events, then re-enters each
// one's own tenant context before touching its data.
async function runRecurrenceSweep() {
  const parents = await Event.find({
    status: "active",
    "recurrence.frequency": { $in: ["weekly", "biweekly", "monthly"] },
    seriesId: null,
  }).lean();
  let occurrencesCreated = 0;
  for (const parent of parents) {
    occurrencesCreated += await runWithWorkspace(parent.workspaceId, () => ensureOccurrencesFor(parent));
  }
  return { parentsChecked: parents.length, occurrencesCreated };
}

let timer = null;
function startEventRecurrenceRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(60 * 60000, Number(process.env.EVENT_RECURRENCE_INTERVAL_MS) || 6 * 60 * 60000);
  timer = setInterval(() => runRecurrenceSweep().catch((error) => console.error("Event recurrence runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}
function stopEventRecurrenceRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  runRecurrenceSweep,
  ensureOccurrencesFor,
  startEventRecurrenceRunner,
  stopEventRecurrenceRunner,
};
