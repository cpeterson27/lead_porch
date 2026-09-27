function zonedDate(year, month, day, hour, minute, timezone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let value = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    value += target - shown;
  }
  return new Date(value);
}

const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timeValid = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
function normalizeTimeOff(rows = []) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Choose up to 100 time-off periods.');
  return rows.map(row => {
    const { startDate, endDate } = row;
    const allDay = row.allDay !== false;
    if (!dateValid(startDate) || !dateValid(endDate) || endDate < startDate) throw new Error('Time off requires a valid start and end date.');
    if (!allDay && (!timeValid(row.startTime) || !timeValid(row.endTime) || `${endDate}T${row.endTime}` <= `${startDate}T${row.startTime}`)) throw new Error('Time off must end after it starts.');
    return { startDate, endDate, allDay, startTime: allDay ? '00:00' : row.startTime, endTime: allDay ? '00:00' : row.endTime };
  });
}
function timeOffWindows(rows, timezone) {
  return normalizeTimeOff(rows).map(row => {
    const start = row.startDate.split('-').map(Number), end = row.endDate.split('-').map(Number);
    const st = row.startTime.split(':').map(Number), et = row.endTime.split(':').map(Number);
    if (row.allDay) { const next = new Date(Date.UTC(end[0], end[1] - 1, end[2] + 1)); end.splice(0, 3, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()); }
    return { start: zonedDate(...start, ...st, timezone).getTime(), end: zonedDate(...end, ...et, timezone).getTime() };
  });
}
const overlapsTimeOff = (windows, start, end) => windows.some(row => start < row.end && end > row.start);
module.exports = { normalizeTimeOff, timeOffWindows, overlapsTimeOff, zonedDate };
