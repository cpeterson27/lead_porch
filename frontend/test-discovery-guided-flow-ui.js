import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/Discovery.jsx", "utf8");
const css = fs.readFileSync("src/pages/Discovery.css", "utf8");

assert.ok(source.includes('searchParams.get("tab") || "people"'), "Discovery must open on the guided lead workflow");
assert.ok(!source.includes('className="discovery-tabs"'), "the five-tab primary navigation must not return");
for (const label of ["Find leads", "Review leads", "Automatic searches"]) assert.ok(source.includes(label), `missing primary workflow: ${label}`);
assert.ok(source.includes("Keywords and relevant topics"), "the program plan must show Jarvis-generated editable topics");
assert.ok(source.includes("Public LinkedIn profiles to watch"), "automatic searches must offer clearly scoped public LinkedIn profile watching");
assert.ok(source.includes("publicly indexed activity only"), "LinkedIn capability must disclose its public-only boundary");
assert.ok(source.includes("Why Lead Porch found this"), "every review card must explain why it was returned");
assert.ok(source.includes("Why this is only a possible match"), "undated database matches must not be presented as buying intent");
assert.ok(source.includes("No contact information yet"), "missing contact details must be explicit");
assert.match(css, /\.discovery-command-grid\{[^}]*grid-template-columns:repeat\(3/);
assert.match(css, /@media\(max-width:900px\)\{\.discovery-command-grid\{grid-template-columns:1fr/);

console.log("Discovery guided flow UI: three clear jobs, program/topic walkthrough, honest LinkedIn scope, explainable lead cards, and responsive grid all passed.");
