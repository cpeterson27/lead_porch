const assert = require("assert");
const { nextScheduledRun, partsAt, validTimezone } = require("./services/discoveryScheduleTimeService");

assert.equal(validTimezone("America/Los_Angeles"), true);
assert.equal(validTimezone("not/a-zone"), false);

const mondayMorning = nextScheduledRun({ cadence: "weekly", dayOfWeek: "mon", timeOfDay: "09:30", timezone: "America/Los_Angeles" }, new Date("2026-09-17T20:00:00.000Z"));
const weeklyParts = partsAt(mondayMorning, "America/Los_Angeles");
assert.equal(weeklyParts.weekday, "mon");
assert.equal(weeklyParts.hour, 9);
assert.equal(weeklyParts.minute, 30);
assert(mondayMorning > new Date("2026-09-17T20:00:00.000Z"));

const daily = nextScheduledRun({ cadence: "daily", timeOfDay: "08:15", timezone: "America/New_York" }, new Date("2026-09-17T20:00:00.000Z"));
const dailyParts = partsAt(daily, "America/New_York");
assert.equal(dailyParts.hour, 8);
assert.equal(dailyParts.minute, 15);
assert(daily > new Date("2026-09-17T20:00:00.000Z"));

console.log("Discovery schedule timezone and weekday calculations passed");
