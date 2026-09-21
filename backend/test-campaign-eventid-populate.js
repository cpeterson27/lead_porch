const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// Every route that saves and returns a campaign must re-populate eventId,
// or the frontend's next setCampaign(response) silently downgrades
// campaign.eventId from a real Event object back to a bare id — breaking
// anything that reads campaign.eventId.startDate (e.g. the "Add to
// Calendar" button), even though the Event's own data was never touched.
const contents = source("routes/campaigns.js");
const populateCount = (contents.match(/\.populate\("eventId"\)/g) || []).length;
// One on the GET /:id route, plus one for each of: brand, audience,
// schedule, and the two scheduled-send return points.
assert.ok(populateCount >= 6, `expected at least 6 .populate("eventId") call sites, found ${populateCount}`);

console.log(`Campaign eventId-populate test passed: ${populateCount} call sites keep eventId populated after every save.`);
