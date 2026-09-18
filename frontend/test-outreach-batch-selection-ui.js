import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./src/pages/Outreach.jsx", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("./src/services/api.js", import.meta.url), "utf8");

assert.match(source, /Select next \{Math\.min\(25, selectableItems\.length\)\}/);
assert.match(source, /Select next \{Math\.min\(50, selectableItems\.length\)\}/);
assert.match(source, /Approve selected · \{selectedPendingCount\}/);
assert.match(source, /Send selected · \{selectedApprovedCount\}/);
assert.match(source, /aria-label=\{`Select \$\{item\.contactName/);
assert.match(api, /Array\.isArray\(outreachIds\)/);
assert.match(api, /\/outreach\/send[\s\S]*timeout: 120000/);

console.log("Outreach batch selection UI tests passed.");
