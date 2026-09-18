const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "routes", "outreach.js"), "utf8");
const emailSource = fs.readFileSync(path.join(__dirname, "services", "email.js"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "..", "frontend", "src", "pages", "Outreach.jsx"), "utf8");

assert.match(source, /const \{ campaignId, outreachIds \} = req\.body/);
assert.match(source, /filter\._id = \{ \$in: outreachIds \}/);
assert.match(source, /status: \{ \$in: \["pending", "failed"\] \}/);
assert.match(source, /deliveryStatus: \{ \$nin: \["bounced", "suppressed", "complained"\] \}/);
assert.match(source, /prospectingAttested !== true/);
assert.match(source, /deliveryPurpose === "business_prospecting"/);
assert.match(source, /Promise\.all\(Array\.from\(\{ length: Math\.min\(5, items\.length\) \}, worker\)\)/);
assert.match(emailSource, /if \(deliveryPurpose === "business_prospecting"\) return \{ eligible: true, contact \}/);
assert.match(emailSource, /contact\?\.status === "unsubscribed"/);
assert.match(emailSource, /EmailSuppression\.findOne/);
assert.match(emailSource, /deliveryPurpose === "business_prospecting"\)\)/);
assert.match(uiSource, /Why this message did not send/);
assert.match(uiSource, /Cold business prospecting/);
assert.match(uiSource, /prospectingAttested: deliveryPurpose === "business_prospecting"/);

console.log("Outreach batch approval tests passed.");
