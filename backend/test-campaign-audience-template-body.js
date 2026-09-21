const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// AI-generated audience-specific email versions rewrite the body by
// replacing each detected editable text block in the source design — but
// only ever matched Unlayer's "text" block type. A real campaign's design
// used only "paragraph" blocks (confirmed live), so zero blocks were ever
// found, and personalizeEmailDesign() silently returned an exact copy of
// the source for every audience: only the separately-stored subject field
// ever visibly changed, never the body.
const contents = source("routes/campaigns.js");
assert.ok(contents.includes('new Set(["text", "paragraph"])'), "EMAIL_TEXT_BLOCK_TYPES must include both text and paragraph block types");
assert.ok(contents.includes("EMAIL_TEXT_BLOCK_TYPES.has(value.type)"), "collectEmailTextBlocks/personalizeEmailDesign must check against EMAIL_TEXT_BLOCK_TYPES, not a single hardcoded type");
assert.equal((contents.match(/EMAIL_TEXT_BLOCK_TYPES\.has\(value\.type\)/g) || []).length, 2, "both collectEmailTextBlocks and personalizeEmailDesign must use the shared type set");

console.log("Campaign audience-template body test passed: text-block detection covers both Unlayer block type names.");
