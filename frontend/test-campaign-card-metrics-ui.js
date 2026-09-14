import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./src/pages/Campaigns.jsx", import.meta.url), "utf8");

assert.match(source, /isProgram \? "Email campaign" : "Event campaign"/);
assert.match(source, /Matched recipients/);
assert.match(source, /Email opens vs sent/);
assert.match(source, /No emails sent yet/);
assert.match(source, /emailProgress}% open rate/);
assert.match(source, /isProgram[\s\S]*registration goal/);

console.log("Campaign cards separate email performance from event registrations.");
