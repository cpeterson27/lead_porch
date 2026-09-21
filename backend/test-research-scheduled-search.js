const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

// Repeats a saved company-targeting search daily at a chosen time, reusing
// the exact plan/question of its most recent run so newly matching
// organizations keep getting added to the same saved audience automatically.
includesAll(source("models/Audience.js"), [
  "scheduledSearch", "enabled: { type: Boolean, default: false }", "lastRunDateKey",
], "models/Audience.js");

includesAll(source("routes/audience.js"), [
  'router.patch("/research/history/:audienceId/schedule"',
  "This saved search has no completed run yet to repeat",
  "scheduledSearch",
], "routes/audience.js");

includesAll(source("services/researchScheduledSearchRunner.js"), [
  "runDueScheduledSearches", "findOneAndUpdate", "runMarketResearchJob",
  "startResearchScheduledSearchRunner", "stopResearchScheduledSearchRunner",
], "services/researchScheduledSearchRunner.js");

includesAll(source("server.js"), ["startResearchScheduledSearchRunner"], "server.js");

// isDue() correctness: weekday/time-of-day/already-ran-today gating.
const { isDue } = require("./services/researchScheduledSearchRunner");
const schedule = (overrides = {}) => ({ scheduledSearch: { enabled: true, time: "08:00", timezone: "America/New_York", days: [0, 1, 2, 3, 4, 5, 6], lastRunDateKey: "", ...overrides } });
const monday0830EST = new Date("2024-01-15T13:30:00Z");
const monday0730EST = new Date("2024-01-15T12:30:00Z");
assert.equal(isDue(schedule(), monday0830EST), true, "due after scheduled time");
assert.equal(isDue(schedule(), monday0730EST), false, "not due before scheduled time");
assert.equal(isDue(schedule({ lastRunDateKey: "2024-01-15" }), monday0830EST), false, "already ran today");
assert.equal(isDue(schedule({ days: [2] }), monday0830EST), false, "not scheduled for this weekday");
assert.equal(isDue({ scheduledSearch: { ...schedule().scheduledSearch, enabled: false } }, monday0830EST), false, "disabled schedule never due");

console.log("Research scheduled-search tests passed: model fields, route, isDue() gating, and server wiring all present.");
