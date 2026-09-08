import { useState } from "react";
import { FaThumbsUp, FaRegThumbsUp } from "react-icons/fa6";
import { manageFacebookComment } from "../services/api.js";
import "./FacebookCommentActions.css";

function actionKey() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `action_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

export default function FacebookCommentActions({ thread, replies = [], onChanged }) {
  const [body, setBody] = useState(""),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
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
      if (action === "delete") setConfirmDelete(false);
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
  // A Facebook reply is itself a real, independently deletable comment —
  // deleting it removes only that reply, leaving the commenter's original
  // comment untouched. Instagram replies are sent as a private message, not
  // a public comment, so Meta has no endpoint to delete one.
  const ownDeletableReplies = instagram
    ? []
    : replies.filter(
        (reply) => reply.metadata?.publicCommentReply && reply.providerMessageId,
      );
  const deleteReply = (reply) => {
    if (
      !window.confirm(
        "Delete this reply from Facebook? This only removes your reply — the commenter's original comment stays up. This cannot be undone.",
      )
    )
      return;
    run("delete", { targetCommentId: reply.providerMessageId });
  };
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
        {!instagram && (
          <>
            <button
              className="facebook-comment-actions__like"
              disabled={Boolean(busy)}
              onClick={() => run("like")}
            >
              <FaThumbsUp aria-hidden="true" /> Like as Page
            </button>
            <button
              className="facebook-comment-actions__unlike"
              disabled={Boolean(busy)}
              onClick={() => run("unlike")}
            >
              <FaRegThumbsUp aria-hidden="true" /> Remove Page like
            </button>
          </>
        )}
        {ownDeletableReplies.map((reply) => (
          <button
            key={reply.providerMessageId}
            className="is-destructive"
            disabled={Boolean(busy)}
            onClick={() => deleteReply(reply)}
          >
            {ownDeletableReplies.length > 1
              ? `Delete our reply (${new Date(reply.createdAt).toLocaleDateString()})`
              : "Delete our reply"}
          </button>
        ))}
        <button
          className="is-destructive"
          disabled={Boolean(busy)}
          onClick={() => setConfirmDelete(true)}
        >
          Delete their comment
        </button>
      </div>
      {confirmDelete ? (
        <div
          className="facebook-comment-actions__confirmation"
          role="alertdialog"
          aria-labelledby="delete-facebook-comment-title"
        >
          <strong id="delete-facebook-comment-title">
            Delete this comment from {instagram ? "Instagram" : "Facebook"}?
          </strong>
          <p>
            This removes the commenter's original comment
            {!instagram && " and any replies nested under it"}
            . This cannot be undone.
            {!instagram &&
              ownDeletableReplies.length > 0 &&
              " To remove only your own reply and leave their comment up, use Delete our reply above instead."}
          </p>
          <div>
            <button
              disabled={Boolean(busy)}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              className="is-destructive"
              disabled={Boolean(busy)}
              onClick={() => run("delete")}
            >
              Delete their comment
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
