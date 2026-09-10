import { useState } from "react";
import Button from "./Button.jsx";
import { requestSalesAssist } from "../services/api.js";
import "../pages/SalesAgentPanel.css";

const ACTIONS = [
  ["summarize", "Summarize Lead"],
  ["next_step", "What Should I Do Next?"],
  ["draft_outreach", "Draft Outreach"],
  ["follow_up", "Suggest Follow-up"],
];

/**
 * Sales Agent: AI assistance grounded in this opportunity's real CRM record,
 * activity, and qualification evidence. Read-only — proposes nothing, changes
 * nothing. Usable on any opportunity, not only ones assigned in the Closer Queue.
 */
export default function SalesAgentPanel({ opportunityId }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [objection, setObjection] = useState("");

  async function ask(action) {
    if (!opportunityId || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await requestSalesAssist(opportunityId, { action, ...(action === "handle_objection" ? { objection } : {}) });
      setResult(response.data || null);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Sales Agent could not prepare a recommendation.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="sales-agent-panel">
      <div>
        <h3>Ask Sales Agent</h3>
        <p>AI assistance only. Nothing is sent or changed automatically.</p>
      </div>
      <div className="sales-agent-actions">
        {ACTIONS.map(([action, label]) => (
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => ask(action)} key={action}>{label}</Button>
        ))}
      </div>
      <label>
        Objection to handle
        <textarea rows="2" value={objection} onChange={(event) => setObjection(event.target.value)} placeholder="Paste the objection here without adding sensitive personal information." />
      </label>
      <Button type="button" size="sm" variant="outline" disabled={loading || !objection.trim()} onClick={() => ask("handle_objection")}>Handle Objection</Button>
      {loading ? <p role="status">Sales Agent is preparing a recommendation…</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {result?.output ? (
        <article className="sales-agent-result">
          <strong>AI recommendation</strong>
          {result.output.summary ? <p>{result.output.summary}</p> : null}
          {result.output.recommendedNextAction ? <><b>Recommended next action</b><p>{result.output.recommendedNextAction}</p></> : null}
          {result.output.suggestedOutreach ? <><b>Suggested outreach draft</b><p>{result.output.suggestedOutreach}</p><Button type="button" size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(result.output.suggestedOutreach)}>Copy draft</Button></> : null}
          {result.output.objectionGuidance ? <><b>Objection guidance</b><p>{result.output.objectionGuidance}</p></> : null}
          {result.output.followUpRecommendation ? <><b>Follow-up recommendation</b><p>{result.output.followUpRecommendation}</p></> : null}
          <small>Review this AI-generated recommendation before using it.</small>
        </article>
      ) : null}
    </section>
  );
}
