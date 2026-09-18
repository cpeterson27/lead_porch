const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: String(parts.weekday || "").slice(0, 3).toLowerCase(),
  };
}

function zonedDateTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(candidate, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  return candidate;
}

function nextScheduledRun(schedule, from = new Date()) {
  const timeZone = validTimezone(schedule.timezone) ? schedule.timezone : "UTC";
  const [hour, minute] = String(schedule.timeOfDay || "09:00").split(":").map(Number);
  const local = partsAt(from, timeZone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const cadence = schedule.cadence === "weekly" ? "weekly" : "daily";
  const desiredWeekday = WEEKDAYS.indexOf(String(schedule.dayOfWeek || "mon").slice(0, 3).toLowerCase());

  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(localDate.getTime() + offset * 86400000);
    if (cadence === "weekly" && date.getUTCDay() !== (desiredWeekday < 0 ? 1 : desiredWeekday)) continue;
    const candidate = zonedDateTimeToUtc({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute,
    }, timeZone);
    if (candidate.getTime() > from.getTime() + 1000) return candidate;
  }
  throw new Error("Unable to calculate the next scheduled discovery run");
}

module.exports = { WEEKDAYS, validTimezone, nextScheduledRun, partsAt, zonedDateTimeToUtc };
