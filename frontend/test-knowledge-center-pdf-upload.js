import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/KnowledgeCenter.jsx", "utf8");
const api = fs.readFileSync("src/services/api.js", "utf8");

// Regression: clicking Cancel used to just hide the form without resetting
// any state, so unsaved title/content silently reappeared next time the
// form was opened. Cancel must now confirm before discarding, then
// actually clear everything.
const cancelHandlerMatch = source.match(/const cancelNewKnowledge = \(\) => \{[\s\S]*?\n  \};/);
assert.ok(cancelHandlerMatch, "Could not locate cancelNewKnowledge");
const cancelHandler = cancelHandlerMatch[0];
assert.ok(/window\.confirm\(/.test(cancelHandler), "Cancel must ask for confirmation before discarding unsaved content");
assert.ok(cancelHandler.includes('setDraft({ title: "", content: "", category: "sops" });'), "Cancel must actually reset the draft fields");
assert.ok(cancelHandler.includes("setPendingApproval(null);"), "Cancel must clear any pending approval state");
assert.ok(cancelHandler.includes('setConfirmationInput("");'), "Cancel must clear the typed confirmation phrase");
assert.ok(cancelHandler.includes("setShowNewForm(false);"), "Cancel must close the form");

// The toggle button must route through the confirming handler when open,
// not the raw toggle that caused the original bug.
assert.ok(/onClick=\{\(\) => \(showNewForm \? cancelNewKnowledge\(\) : setShowNewForm\(true\)\)\}/.test(source), "the Add/Cancel button must call cancelNewKnowledge() when the form is open");

// A no-op cancel (nothing typed) should not need to ask — hasUnsavedNewKnowledge() gates the confirm.
assert.ok(/const hasUnsavedNewKnowledge = \(\) => Boolean\(draft\.title\.trim\(\) \|\| draft\.content\.trim\(\) \|\| pendingApproval\);/.test(source), "unsaved-content detection must check title, content, and any pending approval");

// Owner-only multi-PDF upload, separate from the manual "Add approved knowledge" form.
const uploadCardMatch = source.match(/hasRole\(session, "owner"\) \? \(\s*<DashboardCard title="Upload program PDFs">[\s\S]*?<\/DashboardCard>\s*\) : null/);
assert.ok(uploadCardMatch, "Could not locate the owner-only PDF upload card");
const uploadCard = uploadCardMatch[0];
assert.ok(/type="file" accept="application\/pdf" multiple/.test(uploadCard), "the file input must accept multiple real PDF files");
assert.ok(uploadCard.includes("disabled={pdfBusy}"), "the file input must be disabled while an upload is in progress");
assert.ok(/loading=\{pdfBusy\}/.test(uploadCard), "the upload button must show a loading state while busy");

// The upload call must use its own longer timeout (multi-PDF + AI analysis
// can take a while), not the shared client's default.
const uploadFnMatch = api.match(/export const uploadKnowledgePdfs = \(files, category\) => \{[\s\S]*?\n\};/);
assert.ok(uploadFnMatch, "Could not locate uploadKnowledgePdfs");
assert.ok(/timeout: \d{5,}/.test(uploadFnMatch[0]), "uploadKnowledgePdfs must set an explicit, longer per-call timeout");

console.log("Knowledge Center PDF upload UI: Cancel now confirms before discarding and actually resets all draft/approval state, the owner-only multi-PDF upload control is present with a busy-disabled file input and its own longer request timeout — all passed.");
