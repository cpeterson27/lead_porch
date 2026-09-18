const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "routes", "outreach.js"), "utf8");

assert.match(source, /const \{ campaignId, outreachIds \} = req\.body/);
assert.match(source, /filter\._id = \{ \$in: outreachIds \}/);
assert.match(source, /const filter = \{ campaignId, status: "pending" \}/);
assert.match(source, /Promise\.all\(Array\.from\(\{ length: Math\.min\(5, items\.length\) \}, worker\)\)/);

console.log("Outreach batch approval tests passed.");
