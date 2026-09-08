import { useState } from "react";
import { mutateSocialWorkspace } from "../services/api.js";
import FacebookCommentActions from "./FacebookCommentActions.jsx";
const ACTIONS = [
  ["summarize", "Summarize"],
  ["identify_intent", "Identify intent"],
  ["suggest_reply", "Suggest reply"],
  ["program_question", "Answer program question"],
  ["handle_objection", "Handle objection"],
  ["qualify_lead", "Qualify lead"],
  ["next_step", "Recommend next step"],
];
const human = (value) => String(value || "").replaceAll("_", " ");
export default function SocialReplyComposer({
  thread,
  onSent,
  initialBody = "",
  initialAnalysis = null,
}) {
  const [body, setBody] = useState(initialBody),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [analysis, setAnalysis] = useState(initialAnalysis),
    [aiBusy, setAiBusy] = useState(""),
    [aiError, setAiError] = useState("");
  const ask = async (action, forceRegenerate = false) => {
    if (aiBusy) return;
    setAiBusy(action);
    setAiError("");
    try {
      const result = await mutateSocialWorkspace(
        `inbox/${thread._id}/ai-assist`,
        { action, forceRegenerate },
      );
      setAnalysis(result.analysis);
      if (result.analysis?.suggestedReply)
        setBody(result.analysis.suggestedReply);
    } catch (err) {
      setAiError(
        err.response?.status === 429
          ? "OpenAI credits are empty. Add API credits to generate Social Agent and Jarvis responses."
          : err.response?.data?.error ||
          "Social Agent could not prepare assistance.",
      );
    } finally {
      setAiBusy("");
    }
  };
  const aiPanel = (
    <section className="social-ai-assist" aria-label="Social Agent assistance">
      <div>
        <h3>Social Agent</h3>
        <p>
          Creates private recommendations and reply drafts. Nothing is sent
          automatically.
        </p>
      </div>
      <div className="social-ai-actions">
        {ACTIONS.map(([key, label]) => (
          <button
            type="button"
            key={key}
            disabled={Boolean(aiBusy)}
            onClick={() => ask(key, key === "suggest_reply" && Boolean(analysis?.suggestedReply))}
          >
            {aiBusy === key
              ? "Working…"
              : key === "suggest_reply" && analysis?.suggestedReply
                ? "Generate another"
                : label}
          </button>
        ))}
      </div>
      {aiError && (
        <p role="alert" className="form-error">
          {aiError}
        </p>
      )}
      {analysis && (
        <div className="social-ai-result" aria-live="polite">
          <strong>{human(analysis.intent || "unknown")}</strong>
          <span>
            {Math.round((analysis.confidence || 0) * 100)}% confidence ·{" "}
            {analysis.leadPotential || "no"} lead potential
          </span>
          {analysis.recommendedAction && <p>{analysis.recommendedAction}</p>}
          <small>
            {human(analysis.handoffState || "human_review_required")} · Human
            approval required
          </small>
        </div>
      )}
    </section>
  );
  if (
    ["facebook", "instagram"].includes(thread.channel) &&
    thread.metadata?.interactionType === "comment"
  )
    return (
      <>
        {aiPanel}
        <FacebookCommentActions thread={thread} onChanged={onSent} />
      </>
    );
  if (
    !["instagram", "facebook"].includes(thread.channel) ||
    thread.metadata?.interactionType === "comment"
  )
    return (
      <>
        {aiPanel}
        <p>
          Direct replies are unavailable for this interaction. A comment is not
          permission to initiate an unsolicited DM.
        </p>
      </>
    );
  return (
    <>
      {aiPanel}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await mutateSocialWorkspace(`inbox/${thread._id}/reply`, {
              body,
              approved,
            });
            setBody("");
            setApproved(false);
            onSent();
          } catch (err) {
            setError(
              err.response?.data?.error ||
                "Reply failed. Check delivery status before trying again.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Reply as your connected business account
          <textarea
            maxLength="2000"
            rows="4"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />
          I approve sending this exact reply
        </label>
        <p>
          The provider's customer messaging window is checked before sending.
        </p>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy || !approved || !body.trim()}>
          Send approved reply
        </button>
      </form>
    </>
  );
}
