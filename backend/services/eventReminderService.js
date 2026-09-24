const Event = require("../models/Event");
const CrmActivity = require("../models/CrmActivity");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

// Checklist section 8: webinar/event reminders had no trigger at all before
// this — event.registered already fires (and already sends a confirmation
// via the eventbrite_lead automation), but nothing ever reminded a
// registrant as the event approached. This mirrors paymentReminderService's
// pattern exactly: log a CrmActivity event that the Automations engine
// picks up, so the reminder content stays editable the same way as
// everything else, rather than a hardcoded send.
async function remindRegistrant({ workspaceId, contactId, event }) {
  const idempotencyKey = `event-reminder:${event._id}:${contactId}`;
  const existing = await CrmActivity.findOne({ workspaceId, "metadata.idempotencyKey": idempotencyKey }).select("_id").lean();
  if (existing) return false;
  await CrmActivity.create({
    workspaceId,
    contactId,
    type: "system",
    title: `Event reminder due — ${event.name}`,
    source: "crm",
    metadata: {
      eventType: "event.reminder_due",
      idempotencyKey,
      eventId: event._id,
      eventName: event.name,
      startDate: event.startDate,
      onlineUrl: event.onlineUrl || "",
    },
  });
  return true;
}

async function runDueEventReminders({ windowHours = 24 } = {}) {
  const now = new Date();
  const window = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
  const events = await Event.find({ status: "active", startDate: { $gte: now, $lte: window } }).lean();
  let checked = 0, sent = 0;
  for (const event of events) {
    const externalIds = [event.integrations?.eventbrite?.eventId, event.integrations?.meetup?.eventId].filter(Boolean).map(String);
    if (!externalIds.length) continue;
    const registrations = await CrmActivity.find({
      workspaceId: event.workspaceId,
      "metadata.eventType": { $in: ["event.registered", "event.attended"] },
      $or: [{ "metadata.eventId": { $in: externalIds } }, { "metadata.providerEventId": { $in: externalIds } }],
    }).select("contactId").lean();
    const contactIds = [...new Set(registrations.map((row) => String(row.contactId)).filter(Boolean))];
    checked += contactIds.length;
    for (const contactId of contactIds) {
      const result = await runWithWorkspace(event.workspaceId, () => remindRegistrant({ workspaceId: event.workspaceId, contactId, event }));
      if (result) sent += 1;
    }
  }
  return { eventsChecked: events.length, registrantsChecked: checked, sent };
}

let timer = null;
function startEventReminderRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(60 * 60000, Number(process.env.EVENT_REMINDER_INTERVAL_MS) || 6 * 60 * 60000);
  timer = setInterval(() => runDueEventReminders().catch((error) => console.error("Event reminder runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}
function stopEventReminderRunner() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runDueEventReminders, startEventReminderRunner, stopEventReminderRunner };
