const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

// The project-wide pill-shaped-control rule in frontend/src/index.css
// (`select { border-radius: var(--radius-pill) !important }`) was being
// silently overridden on any page without its own !important radius
// override, because frontend/src/styles/crm.css — imported globally in
// main.jsx, AFTER index.css — had its own blanket, equal-specificity,
// ALSO !important rule forcing every select/input/textarea/button to a
// square 3px radius. CSS !important vs !important ties resolve by source
// order, so the later-imported crm.css rule always won, regardless of any
// page-specific (non-!important) pill radius set elsewhere. Confirmed
// live via computed styles on the campaign template-editor's audience
// selector: appearance was "auto" and border-radius was overridden down
// to exactly "3px", not the intended 999px pill, even though its own
// scoped CSS rule already set the pill radius — that rule just had no
// !important to fight crm.css's with.
const crmCss = read("frontend/src/styles/crm.css");
assert.ok(
  crmCss.includes(".select-input,select,input:not([type=\"checkbox\"]):not([type=\"radio\"]),textarea{border:1px solid var(--crm-line)!important;min-height:42px}"),
  "crm.css's select/input/textarea rule must not force a square 3px radius, and must not apply its min-height:42px to checkboxes/toggles",
);
assert.ok(!/\.btn\{[^}]*border-radius:3px!important/.test(crmCss), "crm.css's .btn rule must not force a square 3px radius");

console.log("Select pill-radius test passed: crm.css no longer fights the global pill-shape rule or distorts toggle switches.");
