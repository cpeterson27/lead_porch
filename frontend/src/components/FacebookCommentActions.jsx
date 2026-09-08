import { useState } from "react";
import { manageFacebookComment } from "../services/api.js";
import "./FacebookCommentActions.css";

function actionKey() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `action_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

export default function FacebookCommentActions({ thread, onChanged }) {
  const [body, setBody] = useState(""),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const run = async (action, values = {}) => {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const result = await manageFacebookComment(thread._id, {
        action,
        approved: true,
        idempotencyKey: actionKey(),
        ...values,
      });
      setNotice(
        result.duplicate
          ? "This action was already received."
          : `${action === "reply" ? "Reply" : "Comment action"} confirmed by Meta.`,
      );
      if (action === "reply") {
        setBody("");
        setApproved(false);
      }
      onChanged?.();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          "Meta could not confirm this action. Review the Page before trying again.",
      );
    } finally {
      setBusy("");
    }
  };
  const instagram = thread.channel === "instagram";
  return (
    <section
      className="facebook-comment-actions"
      aria-labelledby="facebook-comment-actions-title"
    >
      <header>
        <h3 id="facebook-comment-actions-title">
          Manage {instagram ? "Instagram" : "Facebook"} comment
        </h3>
        <p>
          {instagram
            ? "Sent as an approved private reply (a DM), since Instagram has no public reply-to-comment API."
            : "These are manual Page actions. Automatic replies remain disabled."}
        </p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("reply", { body });
        }}
      >
        <label>
          {instagram ? "Private reply" : "Public reply"}
          <textarea
            maxLength="2000"
            rows="3"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
        </label>
        <label className="social-approval">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />
          I approve sending this exact reply
        </label>
        <button disabled={Boolean(busy) || !approved || !body.trim()}>
          {instagram ? "Send private reply" : "Post public reply"}
        </button>
      </form>
      <div
        className="facebook-comment-actions__toolbar"
        aria-label={`${instagram ? "Instagram" : "Facebook"} comment moderation`}
      >
        <button disabled={Boolean(busy)} onClick={() => run("hide")}>
          Hide
        </button>
        <button disabled={Boolean(busy)} onClick={() => run("unhide")}>
          Unhide
        </button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
