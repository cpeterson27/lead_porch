import assert from "node:assert/strict";
import fs from "node:fs";

const workspace = fs.readFileSync(new URL("./src/pages/CampaignWorkspace.jsx", import.meta.url), "utf8");
const outreach = fs.readFileSync(new URL("./src/pages/Outreach.jsx", import.meta.url), "utf8");

assert.match(workspace, /Automatic recipient routing/);
assert.match(workspace, /You do not assign contacts here/);
assert.match(workspace, /Template you are editing/);
assert.match(workspace, /Individual overrides are optional/);
assert.match(workspace, /Generate ideas with AI/);
assert.match(workspace, /Approve recipient routing/);
assert.match(workspace, /use main fallback/);
assert.match(workspace, /need routing review/);
assert.ok(workspace.indexOf("Campaign setup") < workspace.indexOf("Target audience"));
assert.ok(workspace.indexOf("Target audience") < workspace.indexOf("Email design"));
assert.match(workspace, /Continue to target audience/);
assert.match(workspace, /Continue to email design/);
assert.doesNotMatch(workspace, /campaign-professional-flow/);
assert.match(outreach, /Draft routing complete/);

console.log("Campaign template routing UI tests passed.");
