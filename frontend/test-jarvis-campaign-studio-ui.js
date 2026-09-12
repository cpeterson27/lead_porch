import assert from "node:assert/strict";
import fs from "node:fs";

const jarvis = fs.readFileSync(new URL("./src/components/JarvisChat.jsx", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("./src/pages/Dashboard.jsx", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("./src/services/api.js", import.meta.url), "utf8");

assert.match(jarvis, /JarvisCampaignPackagePreview/, "Jarvis must render the reviewable package rather than hiding it in raw JSON");
assert.match(jarvis, /Approve and build drafts/, "image generation and record creation require a visible approval action");
assert.match(jarvis, /Nothing is published or sent/, "the draft-only boundary must be visible to the owner");
assert.match(jarvis, /Images.*ready.*not enabled/, "image readiness must be reported independently");
assert.match(jarvis, /Vertex.*ready.*not enabled/, "Vertex readiness must be visible");
assert.match(api, /campaign-packages\/\$\{packageId\}\/build/, "the package approval must call the dedicated build endpoint");
assert.match(dashboard, /Jarvis morning prospect desk/, "the daily review queue must be visible from the start-of-day dashboard");
assert.match(dashboard, /Found today/, "the dashboard must distinguish today's candidates from the backlog");
assert.match(dashboard, /Waiting for review/, "the dashboard must show the review queue clearly");

console.log("Jarvis Campaign Studio UI: visible proposal approval, provider readiness, draft-only disclosure, and dashboard morning prospect desk passed.");
