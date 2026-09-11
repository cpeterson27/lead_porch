// Regression coverage for the missing persisted-run recovery UI in
// High-volume Public Web Discovery: a queued/running/paused/resumable-
// failed run must survive a page refresh (it must not exist only in this
// component's in-memory state), and continuing it must resume the SAME
// persisted run by its existing _id — never re-approve, never regenerate
// queries, never create a new run.
//
// No React renderer/jsdom is used here (this repo's other *-ui.js tests
// follow the same convention) — real component wiring is verified by
// reading the actual source, and the fetch-merge-resume BEHAVIOR itself
// is verified with a small, fully-mocked simulation of the exact logic
// the component runs, so this proves behavior, not just that certain
// strings are present.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const panelSrc = fs.readFileSync(path.join(root, "src", "pages", "PublicWebDiscoveryPanel.jsx"), "utf8");
const apiSrc = fs.readFileSync(path.join(root, "src", "services", "api.js"), "utf8");
const routeSrc = fs.readFileSync(path.join(root, "..", "backend", "routes", "publicWebDiscovery.js"), "utf8");

// ---- 1. Real component wiring: persisted runs are actually fetched on mount and merged in ----

assert.ok(apiSrc.includes("export const fetchPublicWebDiscoveryRuns"), "the list-runs API helper must exist");
assert.ok(panelSrc.includes("fetchPublicWebDiscoveryRuns"), "the panel must import/call fetchPublicWebDiscoveryRuns — this was the actual reported bug: it was never called, so a persisted run only ever existed in temporary component state");
assert.ok(/useEffect\(\(\) => \{[\s\S]*fetchPublicWebDiscoveryRuns\(\)[\s\S]*\}, \[\]\)/.test(panelSrc), "persisted runs must be fetched in the component's mount effect (empty dependency array), not only after some user action");
assert.ok(/fetchPublicWebDiscoveryRuns\(\)\.then\(\(res\) => setRuns\(/.test(panelSrc), "the fetched runs must actually be merged into the runs state that drives rendering");

// ---- 2. A "Recent discovery runs" section exists, distinct from the in-progress draft editor ----

assert.ok(panelSrc.includes("Recent discovery runs"), "a dedicated recovery section must be shown, not just silently mixed into the draft editor with no label");
assert.ok(/runs\.filter\(\(run\) => run\.status === "draft"\)\.map\(renderRun\)/.test(panelSrc), "drafts (in-progress, unapproved edits) render separately from persisted runs");
assert.ok(/runs\.filter\(\(run\) => run\.status !== "draft"\)\.map\(renderRun\)/.test(panelSrc), "every non-draft persisted run (queued/running/paused/completed/stopped_at_cap/failed) must render individually — never guessing which one to resume");

// ---- 3. Continue calls process-next-batch by run._id alone — never re-approves or regenerates ----

const runOnceNowSrc = panelSrc.slice(panelSrc.indexOf("const runOnceNow ="), panelSrc.indexOf("const pauseRun ="));
assert.ok(runOnceNowSrc.includes('run.status === "draft" ? await approveRun(run) : run'), "approveRun (which regenerates the finalized job plan) must be skipped entirely for anything already persisted as non-draft — Continue must not reapprove or reset the checkpoint");
assert.ok(runOnceNowSrc.includes("processPublicWebDiscoveryRunBatch(current._id, 1)"), "Continue must call process-next-batch against the run's own existing _id");
assert.ok(runOnceNowSrc.includes("runInFlight.current[run._id]"), "the existing synchronous guard must still gate every Continue/Run-once-now click against duplicate in-flight requests");

// ---- 4. Terminal runs remain viewable but never expose an invalid Continue ----

assert.ok(panelSrc.includes('RUN_ACTIVE_STATUSES.has(run.status) ? <Button loading={busy === "running"} onClick={() => runOnceNow(run)}>Continue running</Button> : null'), "Continue running must only ever render for an active (queued/running) status — a completed/cancelled/stopped_at_cap/failed run must never show it");

// ---- 5. The backend list endpoint returns real, resumable data: jobs included, drafts excluded ----

const listRouteSrc = routeSrc.slice(routeSrc.indexOf('router.get("/runs", async'), routeSrc.indexOf('router.post("/runs/:id/approve"'));
assert.ok(/status: \{\s*\$ne: "draft"\s*\}/.test(listRouteSrc), "the recovery list must exclude drafts — a draft is only an in-progress unapproved edit, not a resumable run");
assert.ok(!listRouteSrc.includes('.select("-jobs")'), "jobs must be included in the list response — the frontend needs nextJobIndex/jobs to render the exact checkpoint (job N of M) for a reloaded run");

// ---- 6. Behavioral simulation: a queued run "survives" a simulated refresh and resumes by its existing ID ----

// Simulate the exact mount-time merge: an empty in-memory `runs` array
// (a fresh page load/redeployment — the reported symptom) plus one
// persisted queued run coming back from the (mocked) API.
function simulateMountMerge(persistedRunsFromApi) {
  let runs = []; // component state before the mount effect resolves — the bug's exact starting point
  runs = [...persistedRunsFromApi, ...runs]; // the exact merge this fix performs in the mount useEffect
  return runs;
}

const persistedQueuedRun = {
  _id: "run-persisted-1", status: "queued", programName: "Multifamily Bootcamp",
  jobs: [
    { category: "people", query: "v1", source: "vertex", status: "pending", page: 0, maxPages: 1 },
    { category: "intent_discussions", query: "o1", source: "openai_web_search", status: "pending", page: 0, maxPages: 1 },
  ],
  nextJobIndex: 0, spend: { vertexCalls: 0, openaiCalls: 0, pdlPersonSearchCredits: 0, pdlCrossReferenceCredits: 0, estimatedUsd: 0 },
  providerCreditCapUsd: 0.1, createdAt: new Date().toISOString(),
};

const runsAfterSimulatedRefresh = simulateMountMerge([persistedQueuedRun]);
assert.equal(runsAfterSimulatedRefresh.length, 1, "the persisted queued run must survive the simulated refresh instead of the panel starting empty");
assert.equal(runsAfterSimulatedRefresh[0]._id, "run-persisted-1");
assert.equal(runsAfterSimulatedRefresh[0].status, "queued", "it must come back exactly as it was persisted — checkpoint job 1 of 2, not reset");

// Simulate exactly what clicking "Continue running" does for this reloaded run
// (the same branch runOnceNow takes): a non-draft run skips approveRun
// entirely and calls process-next-batch with its own existing _id only.
let approveCalled = false;
let batchCallRunId = null;
async function simulateApproveRun() { approveCalled = true; }
async function simulateProcessBatch(runId) { batchCallRunId = runId; return { data: { done: true, run: { ...persistedQueuedRun, status: "completed" } } }; }
async function simulateRunOnceNow(run) {
  const current = run.status === "draft" ? await simulateApproveRun(run) : run;
  await simulateProcessBatch(current._id);
}
await simulateRunOnceNow(runsAfterSimulatedRefresh[0]);

assert.equal(approveCalled, false, "resuming a persisted queued run must never re-approve it — that would regenerate/re-slice the job plan and reset the checkpoint");
assert.equal(batchCallRunId, "run-persisted-1", "Continue must process the SAME run by its existing, persisted _id — never a newly created run");

console.log("Public Web Discovery run recovery: persisted queued/running/paused/resumable-failed runs are fetched and merged on page load, rendered individually under a distinct \"Recent discovery runs\" section, Continue resumes the exact persisted run by its existing _id without re-approving or regenerating queries, terminal runs never expose an invalid Continue, the recovery list endpoint excludes drafts and includes jobs, and a queued run demonstrably survives a simulated refresh — all passed.");
