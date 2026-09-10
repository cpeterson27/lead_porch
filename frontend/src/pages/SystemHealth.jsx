import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DashboardCard from "../components/DashboardCard.jsx";
import Button from "../components/Button.jsx";
import LoadingSpinner from "../components/LoadingSpinner.jsx";
import { fetchPipelineHealth, synthesizePipelineHealth } from "../services/api.js";
import "./SystemHealth.css";

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

function SummaryBar({ summary }) {
  return (
    <div className="system-health__summary">
      <div className="system-health__summary-item system-health__summary-item--critical">
        <strong>{summary.critical}</strong><span>Critical</span>
      </div>
      <div className="system-health__summary-item system-health__summary-item--high">
        <strong>{summary.high}</strong><span>High</span>
      </div>
      <div className="system-health__summary-item system-health__summary-item--medium">
        <strong>{summary.medium}</strong><span>Medium</span>
      </div>
      <div className="system-health__summary-item system-health__summary-item--low">
        <strong>{summary.low}</strong><span>Low</span>
      </div>
      <div className="system-health__summary-item">
        <strong>{summary.blockingCount}</strong><span>Blocking a workflow</span>
      </div>
      {summary.revenueAtRisk > 0 ? (
        <div className="system-health__summary-item">
          <strong>${summary.revenueAtRisk.toLocaleString()}</strong><span>Revenue at risk</span>
        </div>
      ) : null}
    </div>
  );
}

function FindingCard({ finding, synthesis }) {
  const detail = synthesis?.topPriorities?.find((item) => item.findingId === finding.id);
  return (
    <article className={`system-health__finding system-health__finding--${finding.severity}`}>
      <header>
        <span className={`system-health__badge system-health__badge--${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <h3>{finding.title}</h3>
        {finding.blocksWorkflow ? <span className="system-health__blocking-tag">Blocks a workflow</span> : null}
      </header>
      <p className="system-health__summary-text">{finding.summary}</p>
      <dl className="system-health__meta">
        <div><dt>Affected</dt><dd>{finding.count}</dd></div>
        {finding.ageDays != null ? <div><dt>Oldest</dt><dd>{finding.ageDays}d</dd></div> : null}
        {finding.revenueImpact ? <div><dt>Revenue impact</dt><dd>${finding.revenueImpact.toLocaleString()}</dd></div> : null}
      </dl>
      {finding.evidence.length ? (
        <details className="system-health__evidence">
          <summary>Evidence ({finding.evidence.length})</summary>
          <ul>{finding.evidence.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </details>
      ) : null}
      {detail ? (
        <div className="system-health__ai-synthesis">
          <strong>Root cause (AI-assisted):</strong> <span>{detail.rootCause}</span>
          <strong>Why it matters:</strong> <span>{detail.whyItMatters}</span>
        </div>
      ) : null}
      <div className="system-health__action">
        <strong>Recommended action</strong>
        <p>{detail?.sharpenedRecommendation || finding.recommendedAction}</p>
        <span className="system-health__approval-tag">Requires human review — System Agent does not make this change automatically.</span>
      </div>
      <div className="system-health__links">
        {finding.links.map((link) => (
          <Link key={link.url} to={link.url} className="system-health__link">{link.label} →</Link>
        ))}
      </div>
    </article>
  );
}

export default function SystemHealth() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [synthesis, setSynthesis] = useState(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesisError, setSynthesisError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchPipelineHealth()
      .then((data) => { if (!cancelled) { setReport(data); setError(""); } })
      .catch((err) => { if (!cancelled) setError(err?.response?.data?.message || "Could not load the Lead Pipeline Health report."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const refresh = () => {
    setLoading(true);
    setError("");
    setReloadKey((key) => key + 1);
  };

  const runSynthesis = async () => {
    setSynthesizing(true);
    setSynthesisError("");
    try {
      const data = await synthesizePipelineHealth();
      setSynthesis(data);
    } catch (err) {
      setSynthesisError(err?.response?.data?.message || "AI synthesis is unavailable right now. The deterministic report above is still fully accurate.");
    } finally {
      setSynthesizing(false);
    }
  };

  return (
    <div className="system-health">
      <div className="system-health__header">
        <div>
          <h1>Lead Pipeline Health</h1>
          <p className="system-health__subtitle">
            System Agent's read-only report on the pipeline and every other agent's plumbing. It never contacts anyone,
            publishes, deletes, or changes data — it only finds problems and points you to where to fix them.
          </p>
        </div>
        <div className="system-health__header-actions">
          <Button variant="secondary" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
          <Button onClick={runSynthesis} disabled={synthesizing || loading || !report?.findings?.length}>
            {synthesizing ? "Explaining with AI…" : "Explain top issues with AI"}
          </Button>
        </div>
      </div>

      {synthesisError ? <div className="system-health__notice system-health__notice--warning">{synthesisError}</div> : null}
      {synthesis?.overallAssessment ? <div className="system-health__notice">{synthesis.overallAssessment}</div> : null}

      {loading ? (
        <DashboardCard title="Loading">
          <p className="system-health__loading"><LoadingSpinner /> Running deterministic pipeline checks…</p>
        </DashboardCard>
      ) : error ? (
        <DashboardCard title="Couldn't load the report">
          <p className="system-health__error">{error}</p>
          <Button onClick={refresh}>Try again</Button>
        </DashboardCard>
      ) : !report?.findings?.length ? (
        <DashboardCard title="All clear">
          <p>No pipeline or system-health issues found right now. System Agent checks again every time you open this page.</p>
        </DashboardCard>
      ) : (
        <>
          <SummaryBar summary={report.summary} />
          <div className="system-health__list">
            {report.findings.map((finding) => (
              <FindingCard key={finding.id} finding={finding} synthesis={synthesis} />
            ))}
          </div>
        </>
      )}

      {report?.generatedAt ? <p className="system-health__generated-at">Generated {new Date(report.generatedAt).toLocaleString()}</p> : null}
    </div>
  );
}
