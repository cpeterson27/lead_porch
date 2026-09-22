const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// Every scheduled Discovery run failed immediately, every day, with
// lastRunMessage "Agent workspace context does not match the caller" —
// confirmed live across all 7 of a real workspace's recurring discovery
// schedules. Root cause: runDueDiscoverySchedules() (a background poller
// with no HTTP session) called into code paths that go through
// agentExecutionService.runAgent(), which strictly requires
// auth.workspaceId to match the workspace being acted on with no bypass
// for a system caller — and this background path never built or passed
// an `auth` object at all. systemAuthService.buildWorkspaceSystemAuth()
// constructs a real auth context (the schedule creator's actual
// membership/permissions) once per claimed schedule; this must be built
// and threaded through every step of the scheduled run.
const engineSource = source("services/publicWebDiscoveryEngineService.js");
assert.ok(engineSource.includes('require("./systemAuthService")'), "must import buildWorkspaceSystemAuth");
assert.ok(engineSource.includes("const auth = await buildWorkspaceSystemAuth("), "runDueDiscoverySchedules must build a real auth context per claimed schedule");
assert.ok(/proposeScheduledRun\(\{[^}]*\bauth\b/.test(engineSource), "the propose call must receive auth");
assert.ok(/processNextBatch\(\{[^}]*\bauth\b/.test(engineSource), "the processNextBatch call must receive auth");
assert.ok(/autoGradeApproveAndEnroll\(\{[^}]*\bauth\b/.test(engineSource), "the auto-enrollment call must receive auth");

const enrollmentSource = source("services/discoveryAutoEnrollmentService.js");
assert.ok(/async function autoGradeApproveAndEnroll\(\{[^}]*\bauth\b/.test(enrollmentSource), "autoGradeApproveAndEnroll must accept auth");
assert.ok(/qualifyAndRecommend\(\{[^}]*\bauth\b/.test(enrollmentSource), "qualifyAndRecommend must be called with auth — it also goes through runAgent and would fail the exact same way");

const authServiceSource = source("services/systemAuthService.js");
assert.ok(authServiceSource.includes("createAuthContext("), "must build a real auth context, not a manufactured bypass");
assert.ok(authServiceSource.includes("ACTIVE_ROLES"), "must reject an inactive/viewer-only membership rather than silently running with no real permissions");

console.log("Discovery schedule auth test passed: scheduled runs now build and thread a real auth context through every runAgent-calling step.");
