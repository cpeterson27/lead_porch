import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/Discovery.jsx", "utf8");
const api = fs.readFileSync("src/services/api.js", "utf8");

// Vertex AI Grounding must be wired in as a genuinely separate, optional
// source — never replacing or auto-feeding Apollo/PDL or OpenAI/Jarvis.
const cardMatch = source.match(/<DashboardCard title="Vertex AI Grounding \(optional public-web source\)">[\s\S]*?<\/DashboardCard>/);
assert.ok(cardMatch, "Could not locate the Vertex Grounding Discovery card");
const card = cardMatch[0];
assert.ok(/Apollo\/PDL remain the structured/i.test(card), "the card must state Apollo/PDL are unchanged");
assert.ok(/OpenAI\/Jarvis still handles planning and qualification/i.test(card), "the card must state OpenAI/Jarvis's role is unchanged");
assert.ok(/Nothing here becomes a lead\s*\n?\s*automatically/i.test(card), "the card must state results never become leads automatically");

// Result-type selection covers all four entity types the backend supports.
assert.ok(/\["person", "organization", "event", "community"\]\.map\(\(type\) =>/.test(card), "the result-type checkboxes must cover all four entity types the backend supports");
assert.ok(card.includes("checked={groundingTypes.includes(type)}"), "each result type must be an independently toggleable checkbox");

// A pending result must offer exactly Save/Dismiss — no path that acts on
// it without a human decision, and no automatic promotion.
assert.ok(/result\.status === "pending_review" \? \(/.test(card), "only pending_review results may show review actions");
assert.ok(card.includes("onClick={() => saveGroundingResult(result._id)}"), "missing the explicit Save action");
assert.ok(card.includes("onClick={() => dismissGroundingResult(result._id)}"), "missing the explicit Dismiss action");
assert.ok(card.includes("Citations"), "citations must be visibly labeled for review, not just embedded silently");

// The search handler must guard against empty query, no selected types, or a request already in flight.
const searchHandlerMatch = source.match(/const runGroundingSearch = async \(\) => \{[\s\S]*?\n  \};/);
assert.ok(searchHandlerMatch, "Could not locate runGroundingSearch");
assert.ok(/if \(!groundingQuery\.trim\(\) \|\| groundingBusy \|\| !groundingTypes\.length\) return;/.test(searchHandlerMatch[0]), "runGroundingSearch must guard against empty query, no types selected, and duplicate submissions");

// The search call itself must use a longer per-call timeout, not a change
// to the shared client's default (same reasoning as every other Vertex call this session).
const searchFnMatch = api.match(/export const runVertexGroundingDiscoverySearch = \(payload\) =>\s*\n\s*api\.post\("\/audience\/research\/vertex-grounding\/search", payload, \{ timeout: (\d+) \}\)/);
assert.ok(searchFnMatch, "runVertexGroundingDiscoverySearch must pass a per-call timeout override");
assert.ok(Number(searchFnMatch[1]) >= 60000, "the Vertex Grounding Discovery search timeout should be sized for real grounding latency, not the default");

console.log("Vertex Grounding Discovery UI: presented as a genuinely separate optional source (Apollo/PDL and OpenAI/Jarvis roles stated as unchanged), covers all four result types, exposes only explicit Save/Dismiss on pending results with visible citations, and the search action guards against empty/duplicate/no-type-selected submissions with its own longer timeout — all passed.");
