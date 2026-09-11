import { useEffect, useRef, useState } from "react";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import {
  fetchLeadGenerationPrograms,
  fetchLeadGenerationProviderAvailability,
  fetchPublicWebDiscoveryRuns,
  fetchPublicWebDiscoveryRun,
  proposePublicWebDiscoveryRun,
  proposeStudentSearchPreset,
  approvePublicWebDiscoveryRun,
  previewPublicWebDiscoveryRunPlan,
  processPublicWebDiscoveryRunBatch,
  pausePublicWebDiscoveryRun,
  resumePublicWebDiscoveryRun,
  cancelPublicWebDiscoveryRun,
  createDiscoverySchedule,
  fetchDiscoverySchedules,
  enableDiscoverySchedule,
  disableDiscoverySchedule,
  runDiscoveryScheduleNow,
} from "../services/api.js";
import "./DiscoveryTargeting.css";

const JOB_CATEGORIES = [
  ["people", "People"],
  ["facebook_groups", "Public Facebook groups"],
  ["communities", "Communities"],
  ["organizations", "Organizations"],
  ["events", "Events"],
  ["forums", "Forums"],
  ["podcasts", "Podcasts"],
  ["directories", "Directories"],
  ["intent_discussions", "Recent problem/intent discussions"],
];
const SOURCE_LABELS = { vertex: "Vertex", openai_web_search: "OpenAI Web Search" };
const FREQUENCY_OPTIONS = [
  { label: "Every 12 hours", value: 720 },
  { label: "Every 24 hours", value: 1440 },
  { label: "Every 3 days", value: 4320 },
  { label: "Weekly", value: 10080 },
];
const RUN_ACTIVE_STATUSES = new Set(["queued", "running"]);
const RUN_TERMINAL_STATUSES = new Set(["completed", "stopped_at_cap", "failed", "canceled"]);
// "stopped_at_cap" must never render as "Completed" — the run stopped early
// because the provider credit cap was reached, not because it finished all
// its queued work (see publicWebDiscoveryEngineService.js's buildRunExplanation).
const RUN_STATUS_LABELS = { stopped_at_cap: "Stopped at budget cap" };
const MAX_BATCH_ITERATIONS = 500;

function groupJobsByCategory(jobs) {
  const groups = new Map(JOB_CATEGORIES.map(([key]) => [key, []]));
  for (const job of jobs || []) {
    if (!groups.has(job.category)) groups.set(job.category, []);
    groups.get(job.category).push(job);
  }
  return groups;
}

function StatusBadge({ status }) {
  return <span className={`leadgen-run-status leadgen-run-status--${status}`}>{RUN_STATUS_LABELS[status] || status}</span>;
}

/**
 * The owner-only production interface for the Public Web Discovery engine
 * (services/publicWebDiscoveryEngineService.js): propose editable search
 * families for one or more approved programs, review/edit them, configure
 * targets/limits/caps, run once or schedule (always created disabled —
 * enabling is a separate, explicit action), and watch status/progress.
 * Every accepted candidate lands in the existing GroundingResearchResult
 * review queue — nothing here bypasses that review step or auto-imports,
 * enriches, monitors, or contacts anyone.
 */
export default function PublicWebDiscoveryPanel({ onResultsChanged }) {
  const [programs, setPrograms] = useState([]);
  const [providerAvailability, setProviderAvailability] = useState(null);
  const [selectedProgramNoteIds, setSelectedProgramNoteIds] = useState([]);
  const [locationsDraft, setLocationsDraft] = useState("");
  const [proposeBusy, setProposeBusy] = useState(false);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState([]); // draft/queued/running/... runs this session is managing
  const [runBusy, setRunBusy] = useState({}); // runId -> action label in flight
  const [schedules, setSchedules] = useState([]);
  const [scheduleBusy, setScheduleBusy] = useState({});
  const [planPreviewByRun, setPlanPreviewByRun] = useState({}); // runId -> the EXACT finalized-job-plan preview from the backend
  const stopFlags = useRef({});
  const runInFlight = useRef({}); // synchronous re-entrancy guard — see runOnceNow

  useEffect(() => {
    fetchLeadGenerationPrograms().then((res) => setPrograms(res.data || [])).catch(() => {});
    fetchLeadGenerationProviderAvailability().then((res) => setProviderAvailability(res.data)).catch(() => {});
    fetchDiscoverySchedules().then((res) => setSchedules(res.data || [])).catch(() => {});
    // Reload persisted, non-draft runs (queued/running/paused/completed/
    // stopped-at-cap/failed) so a resumable run survives a page refresh
    // or redeployment instead of only ever existing in this component's
    // in-memory state — this fires before any propose/preset click could
    // add a session-local draft, so a plain prepend is safe here.
    fetchPublicWebDiscoveryRuns().then((res) => setRuns((current) => [...(res.data || []), ...current])).catch(() => {});
  }, []);

  // Recomputes the pre-run plan preview from the SAME finalization the
  // backend uses when approving (round-robin by source, then sliced to
  // queryLimitPerRun) whenever a draft run's relevant settings change —
  // never estimated locally from the unsliced draft query collection.
  const draftPreviewInputsKey = JSON.stringify(
    runs.filter((r) => r.status === "draft").map((r) => ({
      id: r._id,
      jobs: r.jobs.map((j) => ({ category: j.category, query: j.query, source: j.source, locationHint: j.locationHint })),
      sources: r.sources || ["vertex", "openai_web_search"],
      queryLimitPerRun: r.queryLimitPerRun, pageLimitPerQuery: r.pageLimitPerQuery, providerCreditCapUsd: r.providerCreditCapUsd,
      includePdlPersonSearch: r.includePdlPersonSearch, maxPdlPersonSearchCredits: r.maxPdlPersonSearchCredits,
      includePdlCrossReference: r.includePdlCrossReference, maxPdlCrossReferenceCredits: r.maxPdlCrossReferenceCredits,
      maxAttemptsPerJob: r.retryPolicy?.maxAttemptsPerJob,
    })),
  );
  useEffect(() => {
    const draftRuns = runs.filter((r) => r.status === "draft");
    if (!draftRuns.length) return undefined;
    const timeoutId = setTimeout(() => {
      draftRuns.forEach((run) => {
        previewPublicWebDiscoveryRunPlan({
          jobs: run.jobs, sources: run.sources || ["vertex", "openai_web_search"],
          queryLimitPerRun: run.queryLimitPerRun, pageLimitPerQuery: run.pageLimitPerQuery, providerCreditCapUsd: run.providerCreditCapUsd,
          includePdlPersonSearch: run.includePdlPersonSearch, maxPdlPersonSearchCredits: run.maxPdlPersonSearchCredits,
          includePdlCrossReference: run.includePdlCrossReference, maxPdlCrossReferenceCredits: run.maxPdlCrossReferenceCredits,
          maxAttemptsPerJob: run.retryPolicy?.maxAttemptsPerJob,
        }).then((response) => {
          setPlanPreviewByRun((current) => ({ ...current, [run._id]: response.data }));
        }).catch(() => {});
      });
    }, 300);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPreviewInputsKey]);

  const toggleProgram = (noteId) => {
    setSelectedProgramNoteIds((current) => (current.includes(noteId) ? current.filter((id) => id !== noteId) : [...current, noteId]));
  };

  const updateRunInState = (updatedRun) => {
    setRuns((current) => current.map((r) => (r._id === updatedRun._id ? updatedRun : r)));
  };

  const [presetBusy, setPresetBusy] = useState(false);

  const generateSearchFamilies = async (proposeFn, setBusy) => {
    if (!selectedProgramNoteIds.length || proposeBusy || presetBusy) return;
    setBusy(true);
    setError("");
    try {
      const locations = locationsDraft.split(",").map((v) => v.trim()).filter(Boolean);
      const created = [];
      for (const programNoteId of selectedProgramNoteIds) {
        const response = await proposeFn({ programNoteId, locations });
        created.push(response.data);
      }
      setRuns((current) => [...created, ...current]);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to generate search families.");
    } finally {
      setBusy(false);
    }
  };

  const updateJob = (run, jobIndex, field, value) => {
    const jobs = run.jobs.map((job, index) => (index === jobIndex ? { ...job, [field]: value } : job));
    updateRunInState({ ...run, jobs });
  };
  const removeJob = (run, jobIndex) => {
    updateRunInState({ ...run, jobs: run.jobs.filter((_, index) => index !== jobIndex) });
  };
  const addJob = (run, category) => {
    updateRunInState({ ...run, jobs: [...run.jobs, { category, query: "", source: "vertex", locationHint: "", status: "pending", page: 0, maxPages: run.pageLimitPerQuery || 2, attempts: 0, resultsCount: 0, acceptedCount: 0 }] });
  };
  const updateRunField = (run, field, value) => updateRunInState({ ...run, [field]: value });
  const toggleRunSource = (run, source) => {
    const sources = run.sources?.includes(source) ? run.sources.filter((s) => s !== source) : [...(run.sources || ["vertex", "openai_web_search"]), source];
    updateRunInState({ ...run, sources, jobs: run.jobs.filter((j) => sources.includes(j.source)) });
  };

  const approveRun = async (run) => {
    const response = await approvePublicWebDiscoveryRun(run._id, {
      jobs: run.jobs.filter((j) => j.query.trim()),
      dailyCandidateTarget: run.dailyCandidateTarget,
      pageLimitPerQuery: run.pageLimitPerQuery,
      queryLimitPerRun: run.queryLimitPerRun,
      providerCreditCapUsd: run.providerCreditCapUsd,
      includePdlCrossReference: run.includePdlCrossReference,
      includePdlPersonSearch: run.includePdlPersonSearch,
      maxPdlPersonSearchCredits: run.maxPdlPersonSearchCredits,
      maxPdlCrossReferenceCredits: run.maxPdlCrossReferenceCredits,
      maxAttemptsPerJob: run.retryPolicy?.maxAttemptsPerJob,
      sources: run.sources,
    });
    updateRunInState(response.data);
    return response.data;
  };

  /**
   * "Run once now": approves the run if still a draft, then repeatedly
   * processes bounded batches — never one giant blocking call — until the
   * run reports done (completed, a cap was hit, failed, or a single tick
   * failed before reaching any provider) or the owner pauses/cancels.
   * Never activates a schedule; this is a one-off, explicit run the owner
   * triggered themselves.
   *
   * runInFlight (a ref, checked/set synchronously) is the real guard
   * against a double-click starting a second overlapping request — the
   * runBusy STATE below only drives the button's visual disabled/loading
   * look, which can lag a render behind a very fast second click.
   */
  const runOnceNow = async (run) => {
    if (runInFlight.current[run._id]) return;
    runInFlight.current[run._id] = true;
    setRunBusy((current) => ({ ...current, [run._id]: "running" }));
    stopFlags.current[run._id] = false;
    setError("");
    try {
      let current = run.status === "draft" ? await approveRun(run) : run;
      let iterations = 0;
      while (!stopFlags.current[current._id] && RUN_ACTIVE_STATUSES.has(current.status) && iterations < MAX_BATCH_ITERATIONS) {
        // One job per request, not three — a single Vertex call alone can
        // legitimately take up to 75s server-side, so bounding each
        // request to one job keeps its worst case predictable instead of
        // stacking multiple slow provider calls (plus their citation
        // crawling) into one round trip. The loop still keeps calling
        // this repeatedly until the run reports done, so total throughput
        // is unaffected — each step is just smaller and less likely to
        // run out the clock.
        const outcome = await processPublicWebDiscoveryRunBatch(current._id, 1);
        current = outcome.data.run;
        updateRunInState(current);
        iterations += 1;
        // A tick can now fail before reaching any provider call and still
        // resolve normally (never throwing) — its sanitized, persisted
        // failure is carried on both outcome.data.error and current
        // itself (current.lastFailureMessage), so it survives a later
        // page refresh too. Surface it here immediately and stop this
        // click's loop — one click, one attempt, never a silent internal
        // retry storm against a persistent problem.
        if (outcome.data.error) { setError(outcome.data.error.message || "Unable to run this discovery run."); }
        if (outcome.data.done) break;
      }
      onResultsChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to run this discovery run.");
      // A network drop, timeout, or cold start can lose this request's
      // response entirely, leaving the card frozen on stale pre-attempt
      // data even though the backend may have persisted a real,
      // actionable failure (lastFailureMessage) for this exact tick.
      // Re-sync with what's actually saved so the card never keeps
      // showing 0 usage / no explanation while a generic banner implies
      // something happened.
      try {
        const fresh = await fetchPublicWebDiscoveryRun(run._id);
        updateRunInState(fresh.data);
      } catch {
        // Best-effort only — the generic banner above still stands.
      }
    } finally {
      runInFlight.current[run._id] = false;
      setRunBusy((current) => ({ ...current, [run._id]: "" }));
    }
  };

  const pauseRun = async (run) => {
    stopFlags.current[run._id] = true;
    try {
      const response = await pausePublicWebDiscoveryRun(run._id);
      updateRunInState(response.data);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to pause this run.");
    }
  };
  const resumeRun = async (run) => {
    try {
      const response = await resumePublicWebDiscoveryRun(run._id);
      updateRunInState(response.data);
      runOnceNow(response.data);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to resume this run.");
    }
  };
  const cancelRun = async (run) => {
    stopFlags.current[run._id] = true;
    try {
      const response = await cancelPublicWebDiscoveryRun(run._id);
      updateRunInState(response.data);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to cancel this run.");
    }
  };

  const [frequencyByRun, setFrequencyByRun] = useState({});
  const saveScheduleDisabled = async (run) => {
    setScheduleBusy((current) => ({ ...current, [run._id]: "saving" }));
    try {
      const response = await createDiscoverySchedule({
        name: `${run.programName || "Program"} — recurring discovery`,
        programNoteId: run.programNoteId, programName: run.programName,
        intervalMinutes: frequencyByRun[run._id] || 1440,
        dailyCandidateTarget: run.dailyCandidateTarget, pageLimitPerQuery: run.pageLimitPerQuery,
        queryLimitPerRun: run.queryLimitPerRun, providerCreditCapUsd: run.providerCreditCapUsd,
        includePdlCrossReference: run.includePdlCrossReference, includePdlPersonSearch: run.includePdlPersonSearch,
        maxPdlPersonSearchCredits: run.maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits: run.maxPdlCrossReferenceCredits,
        maxAttemptsPerJob: run.retryPolicy?.maxAttemptsPerJob,
        sources: run.sources,
      });
      setSchedules((current) => [response.data, ...current]);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save this schedule.");
    } finally {
      setScheduleBusy((current) => ({ ...current, [run._id]: "" }));
    }
  };
  const enableSchedule = async (schedule) => {
    setScheduleBusy((current) => ({ ...current, [schedule._id]: "enabling" }));
    try {
      const response = await enableDiscoverySchedule(schedule._id);
      setSchedules((current) => current.map((s) => (s._id === schedule._id ? response.data : s)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to enable this schedule.");
    } finally {
      setScheduleBusy((current) => ({ ...current, [schedule._id]: "" }));
    }
  };
  const disableSchedule = async (schedule) => {
    setScheduleBusy((current) => ({ ...current, [schedule._id]: "disabling" }));
    try {
      const response = await disableDiscoverySchedule(schedule._id);
      setSchedules((current) => current.map((s) => (s._id === schedule._id ? response.data : s)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to disable this schedule.");
    } finally {
      setScheduleBusy((current) => ({ ...current, [schedule._id]: "" }));
    }
  };
  const runScheduleNow = async (schedule) => {
    setScheduleBusy((current) => ({ ...current, [schedule._id]: "running" }));
    try {
      const response = await runDiscoveryScheduleNow(schedule._id);
      setSchedules((current) => current.map((s) => (s._id === schedule._id ? response.data : s)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to request a run for this schedule.");
    } finally {
      setScheduleBusy((current) => ({ ...current, [schedule._id]: "" }));
    }
  };

  /**
   * Renders one run — a draft still being edited/approved, or a
   * queued/running/paused/completed/stopped-at-cap/failed run reloaded
   * from persistence. Shared by both the in-progress draft-editing list
   * and the "Recent discovery runs" recovery list below (see the two
   * runs.filter(...).map(renderRun) calls) so a reloaded persisted run
   * renders identically to one just approved in this same session —
   * Continue always calls process-next-batch against run._id alone; it
   * never re-approves, regenerates queries, or resets the checkpoint.
   */
  const renderRun = (run) => {
    const jobGroups = groupJobsByCategory(run.jobs);
    const busy = runBusy[run._id];
    const sources = run.sources || ["vertex", "openai_web_search"];
    const preview = planPreviewByRun[run._id];
    const totalJobs = run.jobs.length;
    const currentJob = run.jobs[run.nextJobIndex];
    const schedule = schedules.find((s) => s.programNoteId === run.programNoteId);
    return (
      <section key={run._id} className="leadgen-run-panel" aria-label={`Discovery run for ${run.programName}`}>
        <div className="leadgen-run-panel__header">
          <h4>{run.programName || "Program"}</h4>
          <StatusBadge status={run.status} />
          {run.createdAt ? <span className="leadgen-run-created-at">{new Date(run.createdAt).toLocaleString()}</span> : null}
        </div>

        {run.status === "draft" ? (
          <>
            {JOB_CATEGORIES.map(([key, label]) => (jobGroups.get(key)?.length ? (
              <details key={key} className="leadgen-advanced-search" open>
                <summary>{label} ({jobGroups.get(key).length})</summary>
                <div className="leadgen-advanced-search__body">
                  {run.jobs.map((job, index) => (job.category === key ? (
                    <div className="leadgen-job-row" key={`${key}-${index}`}>
                      <input type="text" value={job.query} onChange={(event) => updateJob(run, index, "query", event.target.value)} placeholder="Search query" />
                      <input type="text" value={job.locationHint} onChange={(event) => updateJob(run, index, "locationHint", event.target.value)} placeholder="Location (optional)" className="leadgen-job-row__location" />
                      <select value={job.source} onChange={(event) => updateJob(run, index, "source", event.target.value)}>
                        <option value="vertex">Vertex</option>
                        <option value="openai_web_search">OpenAI Web Search</option>
                      </select>
                      <Button size="sm" variant="outline" onClick={() => removeJob(run, index)}>Remove</Button>
                    </div>
                  ) : null))}
                  <Button size="sm" variant="outline" onClick={() => addJob(run, key)}>+ Add query</Button>
                </div>
              </details>
            ) : null))}

            <div className="leadgen-field-group">
              <span className="leadgen-field-label">Enabled web providers</span>
              <div className="leadgen-pill-row">
                {["vertex", "openai_web_search"].map((source) => {
                  const availability = providerAvailability?.[source];
                  const disabledPill = availability && !availability.available;
                  return (
                    <button key={source} type="button" disabled={disabledPill} className={`leadgen-pill${sources.includes(source) ? " is-selected" : ""}${disabledPill ? " is-disabled" : ""}`} aria-pressed={sources.includes(source)} onClick={() => toggleRunSource(run, source)}>
                      {SOURCE_LABELS[source]}{disabledPill ? ` (${availability.reason})` : ""}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="leadgen-field-group">
              <span className="leadgen-field-label">PDL (People Data Labs) — tracked in its own credits, never converted to web cash</span>
              <div className="leadgen-review-grid">
                <label className="leadgen-run-checkbox"><input type="checkbox" checked={run.includePdlPersonSearch} onChange={(event) => updateRunField(run, "includePdlPersonSearch", event.target.checked)} /><span>PDL Person Search (independent candidate source)</span></label>
                <label><span>Max PDL Person Search credits</span><input type="number" min="0" max="500" disabled={!run.includePdlPersonSearch} value={run.maxPdlPersonSearchCredits} onChange={(event) => updateRunField(run, "maxPdlPersonSearchCredits", Number(event.target.value))} /></label>
                <label className="leadgen-run-checkbox"><input type="checkbox" checked={run.includePdlCrossReference} onChange={(event) => updateRunField(run, "includePdlCrossReference", event.target.checked)} /><span>Include PDL cross-reference</span></label>
                <label><span>Max PDL cross-reference credits</span><input type="number" min="0" max="500" disabled={!run.includePdlCrossReference} value={run.maxPdlCrossReferenceCredits} onChange={(event) => updateRunField(run, "maxPdlCrossReferenceCredits", Number(event.target.value))} /></label>
              </div>
              <p className="leadgen-run-disclosure">Each toggle above is the ONLY thing that turns its PDL call on or off — when off, nothing is enqueued, called, estimated, or charged for it.</p>
            </div>

            <div className="leadgen-review-grid">
              <label><span>Daily candidate target</span><input type="number" min="1" max="500" value={run.dailyCandidateTarget} onChange={(event) => updateRunField(run, "dailyCandidateTarget", Number(event.target.value))} /></label>
              <label><span>Web search cash cap ($) — Vertex + OpenAI only</span><input type="number" min="0" max="1000" step="0.5" value={run.providerCreditCapUsd} onChange={(event) => updateRunField(run, "providerCreditCapUsd", Number(event.target.value))} /></label>
              <label><span>Page limit per query</span><input type="number" min="1" max="10" value={run.pageLimitPerQuery} onChange={(event) => updateRunField(run, "pageLimitPerQuery", Number(event.target.value))} /></label>
              <label><span>Query limit per run (web queries only — never PDL)</span><input type="number" min="1" max="500" value={run.queryLimitPerRun} onChange={(event) => updateRunField(run, "queryLimitPerRun", Number(event.target.value))} /></label>
              <label><span>Retry attempts per query</span><input type="number" min="1" max="10" value={run.retryPolicy?.maxAttemptsPerJob || 3} onChange={(event) => updateRunInState({ ...run, retryPolicy: { maxAttemptsPerJob: Number(event.target.value) } })} /></label>
            </div>
            <dl className="leadgen-review-summary">
              <dt>Expected people</dt><dd>~{run.estimatedCreditUse?.expectedPeople ?? "?"} (rough estimate — direct outreach candidates)</dd>
              <dt>Expected communities/organizations</dt><dd>~{run.estimatedCreditUse?.expectedCommunitiesOrganizations ?? "?"} (rough estimate — need an organizer/partnership approach, not direct outreach)</dd>
              <dt>Target</dt><dd>{run.dailyCandidateTarget} {run.targetType === "person" ? "unique people specifically" : "candidates of any type"}</dd>
              <dt>Maximum PDL Person Search credits</dt><dd>{preview ? preview.maxPdlPersonSearchCredits : "…"}</dd>
              <dt>Maximum PDL cross-reference credits</dt><dd>{preview ? preview.maxPdlCrossReferenceCredits : "…"}</dd>
              <dt>Maximum Vertex calls</dt><dd>{preview ? `${preview.maxVertexCallsInitial} initial` : "…"}{preview?.maxVertexRetryExposure ? ` (up to ${preview.maxVertexRetryExposure} more only if a query fails and is retried)` : ""}</dd>
              <dt>Maximum OpenAI Web Search calls</dt><dd>{preview ? `${preview.maxOpenaiCallsInitial} initial` : "…"}{preview?.maxOpenaiRetryExposure ? ` (up to ${preview.maxOpenaiRetryExposure} more only if a query fails and is retried)` : ""}</dd>
              <dt>Maximum estimated web cash</dt><dd>{preview ? `$${preview.maxWebCashEnforced} (initial calls: $${preview.maxWebCashInitial}${preview.maxWebCashWithRetries !== preview.maxWebCashInitial ? `, up to $${preview.maxWebCashWithRetries} if every retry occurs` : ""}, capped at your $${preview.providerCreditCapUsd} hard cap)` : "…"} — Vertex + OpenAI only, PDL credits above are never converted into this figure</dd>
            </dl>
            {run.estimatedCreditUse?.budgetWarning ? <p className="form-error">{run.estimatedCreditUse.budgetWarning}</p> : null}
            <p className="leadgen-run-disclosure">Destination: the review queue below — nothing is imported into the CRM, enriched, monitored, or contacted automatically. {run.estimatedCreditUse?.note}</p>

            <div className="leadgen-review-actions">
              <Button loading={busy === "running"} disabled={Boolean(preview?.validationError)} onClick={() => runOnceNow(run)}>Run once now</Button>
              {preview?.validationError ? <span className="form-error leadgen-run-inline-error">{preview.validationError}</span> : null}
            </div>

            <div className="leadgen-schedule-form">
              <span className="leadgen-field-label">Schedule (optional)</span>
              <select value={frequencyByRun[run._id] || 1440} onChange={(event) => setFrequencyByRun((current) => ({ ...current, [run._id]: Number(event.target.value) }))}>
                {FREQUENCY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <Button size="sm" variant="outline" loading={scheduleBusy[run._id] === "saving"} onClick={() => saveScheduleDisabled(run)}>Save disabled</Button>
              <p className="leadgen-run-disclosure">A saved schedule never runs on its own — it stays disabled until you explicitly enable it below.</p>
            </div>
          </>
        ) : (
          <div className="leadgen-run-status-detail">
            <p>Checkpoint: job {Math.min(run.nextJobIndex + 1, totalJobs)} of {totalJobs}{currentJob ? ` — "${currentJob.query}" (page ${currentJob.page + 1} of ${currentJob.maxPages})` : ""}</p>
            {run.lastFailureMessage ? (
              <p className="form-error leadgen-run-explanation">
                Last attempt failed ({run.lastFailureCode || "error"}): {run.lastFailureMessage}
                {run.status === "failed"
                  ? " — this happened 3 times in a row, so this run will not resume automatically. Review your settings and propose a new run once the underlying problem is fixed."
                  : " — nothing was spent and your checkpoint is unchanged; Continue running below will safely retry from here."}
              </p>
            ) : null}
            {run.runSummary?.explanation ? <p className="leadgen-run-explanation">{run.runSummary.explanation}</p> : null}
            <dl className="leadgen-review-summary">
              <dt>PDL Person Search credits used</dt><dd>{run.spend?.pdlPersonSearchCredits || 0} of {run.maxPdlPersonSearchCredits} max{!run.includePdlPersonSearch ? " (off)" : ""}</dd>
              <dt>PDL cross-reference credits used</dt><dd>{run.spend?.pdlCrossReferenceCredits || 0} of {run.maxPdlCrossReferenceCredits} max{!run.includePdlCrossReference ? " (off)" : ""}</dd>
              <dt>Vertex calls</dt><dd>{run.spend?.vertexCalls || 0}</dd>
              <dt>OpenAI Web Search calls</dt><dd>{run.spend?.openaiCalls || 0}</dd>
              <dt>Web cash spent</dt><dd>${run.spend?.estimatedUsd ?? 0} of ${run.providerCreditCapUsd} cap</dd>
              <dt>Accepted</dt><dd>{run.runSummary?.created || 0} new · {run.runSummary?.merged || 0} merged into existing queue entries</dd>
              <dt>Freshness</dt><dd>{run.runSummary?.byFreshnessTier?.recent || 0} recent (0-90d) · {run.runSummary?.byFreshnessTier?.aging || 0} aging (91-365d) · {run.runSummary?.byFreshnessTier?.evergreen || 0} evergreen/undated</dd>
              <dt>Excluded</dt><dd>{run.runSummary?.rejectedSelfMatch || 0} self-match · {run.runSummary?.rejectedCrmDuplicate || 0} already in CRM · {run.runSummary?.rejectedPreviouslyDismissed || 0} previously dismissed</dd>
              <dt>Crawl</dt><dd>{run.runSummary?.crawlBlockedByRobots || 0} blocked by robots.txt · {run.runSummary?.crawlSkippedLoginWall || 0} skipped (login wall/never-crawled platform) · {run.runSummary?.crawlErrors || 0} errors</dd>
            </dl>
            {run.runSummary?.zeroCallReasons?.length ? (
              <ul className="leadgen-run-zero-call-reasons">
                {run.runSummary.zeroCallReasons.map((reason, index) => <li key={index} className="form-error">{reason}</li>)}
              </ul>
            ) : null}
            {run.runSummary?.perSource?.length ? (
              <div className="leadgen-provider-breakdown-wrap">
                <table className="leadgen-provider-breakdown">
                  <thead><tr><th>Source</th><th>Category</th><th>Crawled</th><th>Found</th><th>Accepted</th><th>Error</th></tr></thead>
                  <tbody>
                    {run.runSummary.perSource.map((entry, index) => (
                      <tr key={index}>
                        <td>{entry.source}</td><td>{entry.category}</td><td>{entry.urlsCrawled ?? "—"}</td>
                        <td>{entry.entitiesExtracted ?? 0}</td><td>{entry.accepted ?? 0}</td>
                        <td>{entry.error ? <span className="form-error">{entry.error}</span> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="leadgen-review-actions">
              {RUN_ACTIVE_STATUSES.has(run.status) ? <Button loading={busy === "running"} onClick={() => runOnceNow(run)}>Continue running</Button> : null}
              {RUN_ACTIVE_STATUSES.has(run.status) ? <Button variant="outline" onClick={() => pauseRun(run)}>Pause</Button> : null}
              {run.status === "paused" ? <Button onClick={() => resumeRun(run)}>Resume</Button> : null}
              {!RUN_TERMINAL_STATUSES.has(run.status) ? <Button variant="outline" onClick={() => cancelRun(run)}>Cancel</Button> : null}
            </div>
          </div>
        )}

        {schedule ? (
          <div className="leadgen-monitor-suggestion">
            <p>Schedule "{schedule.name}": <strong>{schedule.enabled ? "enabled" : "disabled"}</strong> — every {schedule.intervalMinutes >= 1440 ? `${Math.round(schedule.intervalMinutes / 1440)} day(s)` : `${schedule.intervalMinutes} min`}. {schedule.nextRunAt ? `Next run: ${new Date(schedule.nextRunAt).toLocaleString()}.` : ""} {schedule.lastRunMessage ? `Last run: ${schedule.lastRunMessage}` : ""}</p>
            <div className="leadgen-review-actions">
              {!schedule.enabled ? <Button size="sm" loading={scheduleBusy[schedule._id] === "enabling"} onClick={() => enableSchedule(schedule)}>Enable schedule</Button> : <Button size="sm" variant="outline" loading={scheduleBusy[schedule._id] === "disabling"} onClick={() => disableSchedule(schedule)}>Disable schedule</Button>}
              <Button size="sm" variant="outline" loading={scheduleBusy[schedule._id] === "running"} onClick={() => runScheduleNow(schedule)}>Run schedule now</Button>
            </div>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <DashboardCard title="High-volume Public Web Discovery">
      <p className="leadgen-run-intro">
        Generates many editable search queries per approved program — people, public Facebook groups, communities, organizations, events, forums, podcasts, directories, and recent problem/intent discussions — instead of one combined search, crawls only publicly accessible cited pages, cross-references PDL, and stages every result in the review queue below. Nothing here ever auto-imports, enriches, monitors, or contacts anyone.
      </p>

      <div className="leadgen-field-group">
        <span className="leadgen-field-label">Approved program(s)</span>
        <div className="leadgen-pill-row" role="group" aria-label="Select one or more approved programs">
          {programs.map((program) => (
            <button
              key={program.noteId} type="button"
              className={`leadgen-pill${selectedProgramNoteIds.includes(program.noteId) ? " is-selected" : ""}`}
              aria-pressed={selectedProgramNoteIds.includes(program.noteId)}
              onClick={() => toggleProgram(program.noteId)}
            >
              {program.title}
            </button>
          ))}
        </div>
      </div>

      <label className="leadgen-run-locations">
        <span>Target locations (optional, comma-separated)</span>
        <input type="text" value={locationsDraft} onChange={(event) => setLocationsDraft(event.target.value)} placeholder="e.g. Texas, Florida" />
      </label>

      <div className="leadgen-review-actions">
        <Button disabled={!selectedProgramNoteIds.length} loading={presetBusy} onClick={() => generateSearchFamilies(proposeStudentSearchPreset, setPresetBusy)}>
          {presetBusy ? "Generating…" : "Find prospective students"}
        </Button>
        <Button variant="outline" disabled={!selectedProgramNoteIds.length} loading={proposeBusy} onClick={() => generateSearchFamilies(proposePublicWebDiscoveryRun, setProposeBusy)}>
          {proposeBusy ? "Generating…" : "Generate custom search families"}
        </Button>
        <p className="leadgen-run-disclosure">
          <strong>Find prospective students</strong> prioritizes: PDL Person Search as an independent candidate source, then recent problem/intent discussions, then aspiring/beginner-investor people searches, then communities and groups — with coaches, course sellers, syndicators, brokers, lenders, vendors, and capital-raising services excluded from the people/intent/PDL results (never from communities). Defaults to 25 unique people, one page per query, one retry, and a $1 hard cap.
        </p>
        <p className="leadgen-run-disclosure">
          Both buttons use one Jarvis/OpenAI call per selected program to draft these queries — standard AI usage, billed like any other Jarvis request. No Vertex, OpenAI Web Search, or PDL provider credit is spent yet; that only happens when you approve and run below.
        </p>
      </div>
      {error ? <p className="form-error">{error}</p> : null}

      {runs.filter((run) => run.status === "draft").map(renderRun)}

      {runs.filter((run) => run.status !== "draft").length ? (
        <details className="leadgen-recent-runs discovery-run-details">
          <summary><span><b>Step 3</b> Run Details</span><small>{runs.filter((run) => run.status !== "draft").length} saved run{runs.filter((run) => run.status !== "draft").length === 1 ? "" : "s"} · provider usage, budgets, checkpoints, and history</small></summary>
          <p className="leadgen-run-disclosure">
            Reloaded from what's actually persisted for this workspace — a queued, running, or paused run here can be safely continued from its exact checkpoint; nothing is re-approved or regenerated.
          </p>
          {runs.filter((run) => run.status !== "draft").map(renderRun)}
        </details>
      ) : null}
    </DashboardCard>
  );
}
