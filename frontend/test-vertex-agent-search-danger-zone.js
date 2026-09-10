import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/AiAcquisitionControls.jsx", "utf8");

// The purge control must live in its own collapsed danger zone, not inside
// the Agent Search "try it" testing area — extract each block by its own
// bounds so a future edit can't silently put it back in the wrong place.
const tryItBlockMatch = source.match(/Try Agent Search[\s\S]*?<\/div>\s*\)\s*:\s*null\}/);
assert.ok(tryItBlockMatch, "Could not locate the Agent Search try-it block");
assert.ok(!tryItBlockMatch[0].includes("Purge indexed data"), "The purge control must not be inside the Agent Search testing area");

const dangerZoneMatch = source.match(/<details className="ai-controls-danger-zone">[\s\S]*?<\/details>/);
assert.ok(dangerZoneMatch, "Could not locate the collapsed danger zone");
const dangerZone = dangerZoneMatch[0];
assert.ok(dangerZone.includes("Purge indexed data"), "The purge control must live inside the danger zone");
assert.ok(dangerZone.includes("<summary>Danger zone</summary>"), "The danger zone must be a native collapsed <details> disclosure");
assert.ok(/deletes every Knowledge Center document this workspace has indexed/.test(dangerZone), "The danger zone must explain what purging actually does");

// Owner-only, matching the backend's requireAiOwner gate on the same route.
assert.ok(/hasRole\(session, "owner"\)\s*\?\s*\(\s*<details className="ai-controls-danger-zone">/.test(source), "The danger zone must be gated to hasRole(session, \"owner\") only");

// Cancellation: must fully reset the confirmation state, not just hide the panel.
assert.ok(/const cancelPurgeConfirm = \(\) => \{\s*setPurgeConfirmOpen\(false\);\s*setPurgeConfirmText\(""\);\s*\};/.test(source), "cancelPurgeConfirm must reset both purgeConfirmOpen and purgeConfirmText");

// Incorrect confirmation text: the destructive button must be disabled, and
// the handler itself must refuse to act even if somehow invoked anyway
// (defense in depth beyond the disabled attribute).
assert.ok(/disabled=\{purgeConfirmText !== "PURGE"\}/.test(source), "The Confirm purge button must stay disabled until the typed text is exactly \"PURGE\"");
assert.ok(/if \(purgeConfirmText !== "PURGE"\) return;/.test(source), "confirmPurgeAgentSearchIndex must itself refuse to call the API unless the typed text is exactly \"PURGE\"");

// Successful confirmation: must call the real API and then reset state so a repeat click can't double-fire.
const confirmHandlerMatch = source.match(/const confirmPurgeAgentSearchIndex = async \(\) => \{[\s\S]*?\n  \};/);
assert.ok(confirmHandlerMatch, "Could not locate confirmPurgeAgentSearchIndex");
const confirmHandler = confirmHandlerMatch[0];
assert.ok(confirmHandler.includes("await purgeVertexAgentSearchIndex();"), "Confirming must call the real purge API");
assert.ok(confirmHandler.includes("setPurgeConfirmOpen(false);") && confirmHandler.includes('setPurgeConfirmText("");'), "A successful purge must reset the confirmation panel");

console.log("Vertex Agent Search danger zone: separated from search controls, owner-gated, collapsed by default, cancellation resets state, incorrect confirmation text is blocked at both the UI and handler level, and successful confirmation calls the real API and resets state — all passed.");
