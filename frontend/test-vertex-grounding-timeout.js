import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/AiAcquisitionControls.jsx", "utf8");
const api = fs.readFileSync("src/services/api.js", "utf8");

// Regression for a real production bug: "Try Vertex Grounding" was failing
// with "timeout of 20000ms exceeded" even on requests that would have
// succeeded, because the request was capped at 20s while real Vertex +
// Google Search grounding latency legitimately exceeds that.

// A grounding-specific timeout, longer than 20s, WITHOUT touching the
// shared api client's global default (which stays unset for every other
// call — this must be a per-call override, not a blanket increase).
const apiClientMatch = api.match(/const api = axios\.create\(\{[\s\S]*?\}\);/);
assert.ok(apiClientMatch, "Could not locate the shared api client definition");
assert.ok(!apiClientMatch[0].includes("timeout"), "the shared api client must not gain a global default timeout as part of this fix");
const runVertexGroundingMatch = api.match(/export const runVertexGrounding = \(payload\) =>\s*\n\s*api\.post\("\/ai\/vertex\/grounding", payload, \{ timeout: (\d+) \}\)/);
assert.ok(runVertexGroundingMatch, "runVertexGrounding must pass a per-call timeout override, not rely on any global default");
const frontendTimeoutMs = Number(runVertexGroundingMatch[1]);
assert.ok(frontendTimeoutMs > 20000, `the frontend grounding timeout must exceed the original broken 20000ms; got ${frontendTimeoutMs}`);
assert.ok(frontendTimeoutMs >= 60000 && frontendTimeoutMs <= 120000, `expected a timeout in a sane range above the backend's own ceiling; got ${frontendTimeoutMs}`);

// Timeout handling: a response-less client-side timeout (no err.response at
// all) must get its own friendly message rather than falling through to a
// generic string with no explanation.
const tryGroundingMatch = source.match(/const tryGrounding = async \(\) => \{[\s\S]*?\n  \};/);
assert.ok(tryGroundingMatch, "Could not locate tryGrounding");
const tryGrounding = tryGroundingMatch[0];
assert.ok(/err\.code === "ECONNABORTED"/.test(tryGrounding), "a response-less timeout must be detected and given its own friendly message");
assert.ok(/taking longer than expected/i.test(tryGrounding), "the timeout message must be friendly, not a raw error dump");
assert.ok(tryGrounding.includes("setGroundingError("), "grounding errors must be shown near the grounding control, not just the page-level banner");

// Prevention of duplicate submissions: guarded in the handler itself (not
// just the disabled attribute, which a fast double-click or a re-render
// race could otherwise slip past) and reflected in the button's own state.
assert.ok(/if \(!groundingQuery\.trim\(\) \|\| groundingBusy\) return;/.test(tryGrounding), "tryGrounding must refuse to start a second request while one is already in flight");
const groundingButtonMatch = source.match(/<Button size="sm" variant="outline" loading=\{groundingBusy\} disabled=\{groundingBusy\}[\s\S]*?<\/Button>/);
assert.ok(groundingButtonMatch, "the Search button must bind both loading and disabled to groundingBusy");
assert.ok(/Searching \(can take up to a minute\)/.test(groundingButtonMatch[0]), "the button must show a clear loading state that sets the right expectation while waiting");

// Successful citation rendering: both the per-result evidence URLs AND the
// page-level groundingCitations (what Vertex actually grounded on) must be
// rendered — the latter existed in the API response already but was never
// shown before this fix.
const groundingResultBlockMatch = source.match(/\{groundingResult \? \([\s\S]*?\n\s*\) : null\}\s*\n\s*<\/div>/);
assert.ok(groundingResultBlockMatch, "Could not locate the grounding results rendering block");
const groundingResultBlock = groundingResultBlockMatch[0];
assert.ok(groundingResultBlock.includes("groundingResult.results?.length"), "structured, evidence-backed results must still render");
assert.ok(groundingResultBlock.includes("groundingResult.groundingCitations?.length"), "the real grounding citations Vertex returned must be rendered, not silently discarded");
assert.ok(/citation\.title \|\| citation\.url/.test(groundingResultBlock), "each grounding citation must render a real, clickable link");

console.log("Vertex Grounding timeout fix: grounding-specific timeout (not a global increase), friendly sanitized timeout messaging shown near the control, duplicate-submission prevention in both the handler and the button state, and successful rendering of both structured results and real grounding citations — all passed.");
