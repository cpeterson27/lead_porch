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

// Fixing the block-type gap above didn't fully fix the reported bug: a
// real campaign's whole email lived in a *single* giant text block, and
// the prompt's own "if a block should not change, return it unchanged"
// escape hatch let the model legitimately hand back that one block
// (i.e. the entire message) byte-identical for every audience — verified
// live: every audienceKey on the retirement campaign had an identical
// body, only the subject line ever differed. A retry-when-unchanged pass,
// plus deriving the persisted body deterministically from the same
// validated text blocks (instead of trusting a separately-generated raw
// HTML string that can silently drift from what was actually validated),
// closes that gap.
assert.ok(contents.includes("isUnchanged"), "generateForAudience must detect when the model returned every block unchanged");
assert.ok(contents.includes("generated.bodyHtml === baseTemplate.bodyHtml"), "the unchanged-check must also cover bodyHtml, not just textBlocks");
assert.ok(contents.includes('runGeneration("Your previous attempt returned every block completely unchanged'), "an unchanged result must trigger a corrective retry");
assert.ok(contents.includes("function personalizeEmailBodyHtml("), "must derive the persisted body deterministically from validated text blocks");
assert.ok(contents.includes("const substitutedBody = personalizeEmailBodyHtml(mainTemplate.body, sourceTextBlocks, generated.textBlocks)"), "the audience template's stored body must be built from the substitution helper, not trusted blindly from the model's own bodyHtml");

console.log("Campaign audience-template body test passed: unchanged-output retry and deterministic body substitution are wired in.");
