import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FaFacebookF, FaInstagram, FaLinkedinIn, FaTiktok, FaXTwitter } from "react-icons/fa6";
import { publishingBlocker } from "../utils/socialPublishingReadiness.js";
import SocialContentDetail from "../components/SocialContentDetail.jsx";
import SocialReplyComposer from "../components/SocialReplyComposer.jsx";
import SocialStudio from "./SocialStudio.jsx";
import Button from "../components/Button.jsx";
import Modal from "../components/Modal.jsx";
import {
  fetchSocialWorkspace,
  mutateSocialWorkspace,
  approveSocialContent,
  cancelSocialContent,
  createContentBrief,
  duplicateSocialContent,
  fetchContentBriefs,
  fetchSocialPublishingCapabilities,
  rejectSocialContent,
  requestSocialApproval,
  retrySocialContent,
  scheduleSocialContent,
  publishSocialContentNow,
  deleteSocialContent,
  updateContentBrief,
} from "../services/api.js";
import "./Content.css";
const empty = {
  title: "",
  type: "social",
  body: "",
  callToAction: "",
  source: "human",
  social: { destinations: [], media: [], cta: { label: "", url: "" } },
};
const labels = {
  api: "Official API",
  human_assisted: "Human-assisted",
  unavailable: "Unavailable",
};
const platformIcons = {
  facebook: FaFacebookF,
  instagram: FaInstagram,
  linkedin: FaLinkedinIn,
  tiktok: FaTiktok,
  x: FaXTwitter,
};
const platformNames = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  x: "X",
};
function EmptyImage() {
  return <div className="preview-card__image preview-card__image--empty">Add a photo to preview it here</div>;
}
function PlatformPreview({ platform, draft }) {
  const image = draft.social.media[0]?.url;
  const caption = draft.body || "Your caption will appear here as you type.";
  const ctaLine = draft.social.cta.url
    ? `${draft.social.cta.label || "Learn more"}: ${draft.social.cta.url}`
    : "";
  if (platform === "instagram")
    return (
      <div className="preview-card preview-card--instagram">
        <div className="preview-card__head">
          <span className="preview-card__avatar">L</span>
          <strong>leadporch</strong>
          <span className="preview-card__dots">•••</span>
        </div>
        {image ? (
          <img src={image} alt="" className="preview-card__image preview-card__image--square" />
        ) : (
          <EmptyImage />
        )}
        <div className="preview-card__icons">
          <span>♡</span>
          <span>💬</span>
          <span>➤</span>
        </div>
        <p className="preview-card__caption">
          <strong>leadporch</strong> {caption}
        </p>
        {ctaLine && <p className="preview-card__cta-text">{ctaLine}</p>}
      </div>
    );
  if (platform === "facebook")
    return (
      <div className="preview-card preview-card--facebook">
        <div className="preview-card__head">
          <span className="preview-card__avatar">L</span>
          <div>
            <strong>Lead Porch</strong>
            <small>Just now · 🌐</small>
          </div>
        </div>
        <p className="preview-card__caption">
          {caption}
          {ctaLine && (
            <>
              <br />
              <br />
              {ctaLine}
            </>
          )}
        </p>
        {image ? (
          <img src={image} alt="" className="preview-card__image preview-card__image--wide" />
        ) : (
          <EmptyImage />
        )}
        <div className="preview-card__reactions">
          <span>👍❤️ 12</span>
          <span>3 comments</span>
        </div>
        <div className="preview-card__actions">
          <span>👍 Like</span>
          <span>💬 Comment</span>
          <span>↪ Share</span>
        </div>
      </div>
    );
  if (platform === "linkedin")
    return (
      <div className="preview-card preview-card--linkedin">
        <div className="preview-card__head">
          <span className="preview-card__avatar">L</span>
          <div>
            <strong>Lead Porch</strong>
            <small>Company · Just now</small>
          </div>
        </div>
        <p className="preview-card__caption">
          {caption}
          {ctaLine && (
            <>
              <br />
              <br />
              {ctaLine}
            </>
          )}
        </p>
        {image ? (
          <img src={image} alt="" className="preview-card__image preview-card__image--wide" />
        ) : (
          <EmptyImage />
        )}
        <div className="preview-card__actions">
          <span>👍 Like</span>
          <span>💬 Comment</span>
          <span>↪ Repost</span>
          <span>➤ Send</span>
        </div>
      </div>
    );
  if (platform === "x")
    return (
      <div className="preview-card preview-card--x">
        <div className="preview-card__head">
          <span className="preview-card__avatar">L</span>
          <div>
            <strong>Lead Porch</strong>
            <small>@leadporch · now</small>
          </div>
        </div>
        <p className="preview-card__caption">
          {caption}
          {ctaLine && (
            <>
              <br />
              <br />
              {ctaLine}
            </>
          )}
        </p>
        {image ? (
          <img src={image} alt="" className="preview-card__image preview-card__image--wide" />
        ) : null}
        <div className="preview-card__actions">
          <span>💬</span>
          <span>🔁</span>
          <span>♡</span>
          <span>📤</span>
        </div>
      </div>
    );
  if (platform === "tiktok")
    return (
      <div className="preview-card preview-card--tiktok">
        {image ? (
          <img src={image} alt="" className="preview-card__image preview-card__image--full" />
        ) : (
          <EmptyImage />
        )}
        <div className="preview-card__tiktok-side">
          <span className="preview-card__avatar">L</span>
          <span>♥</span>
          <span>💬</span>
          <span>↪</span>
        </div>
        <div className="preview-card__tiktok-caption">
          <strong>@leadporch</strong>
          <p>{caption}</p>
          {ctaLine && <p>{ctaLine}</p>}
        </div>
      </div>
    );
  return <p className="preview-card__none">Choose a destination to preview the post.</p>;
}
function PostPreview({ draft }) {
  const providers = draft.social.destinations.map((row) => row.provider);
  const [tab, setTab] = useState(providers[0] || "");
  const active = providers.includes(tab) ? tab : providers[0] || "";
  return (
    <div className="post-preview-phone">
      <div className="post-preview-phone__island" />
      {providers.length > 1 && (
        <div className="preview-tabs" role="tablist">
          {providers.map((provider) => {
            const Icon = platformIcons[provider];
            return (
              <button
                key={provider}
                type="button"
                role="tab"
                aria-selected={active === provider}
                className={active === provider ? "preview-tabs__item preview-tabs__item--active" : "preview-tabs__item"}
                onClick={() => setTab(provider)}
              >
                {Icon ? <Icon /> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="post-preview-screen">
        {active ? (
          <PlatformPreview platform={active} draft={draft} />
        ) : (
          <p className="preview-card__none">Choose a destination to preview the post.</p>
        )}
      </div>
    </div>
  );
}
function publishedDestinations(item) {
  return (item.social?.publications || []).filter(
    (row) => ["facebook", "instagram"].includes(row.provider) && row.providerPostId,
  );
}
function PostPerformance({ item }) {
  const destinations = publishedDestinations(item);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let active = true;
    if (!destinations.length) return undefined;
    fetchSocialWorkspace(`content/${item._id}/insights`)
      .then((result) => {
        if (active) setRows(result.destinations || []);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item._id]);
  if (!destinations.length) return null;
  return (
    <div className="social-post-performance">
      {destinations.map((destination) => {
        const Icon = platformIcons[destination.provider];
        const row = rows?.find((r) => r.provider === destination.provider);
        const engagement = row?.engagement;
        return (
          <div
            key={destination.provider}
            className={`social-post-performance__stat social-post-performance__stat--${destination.provider}`}
          >
            <span className="social-post-performance__icon">
              {Icon ? <Icon /> : null}
            </span>
            <div className="social-post-performance__body">
              <strong>{platformNames[destination.provider]}</strong>
              {!rows ? (
                <span className="social-post-performance__loading">
                  Loading…
                </span>
              ) : engagement ? (
                <span className="social-post-performance__numbers">
                  <b>{engagement.likes ?? "—"}</b> likes
                  <b>{engagement.comments ?? "—"}</b> comments
                  {engagement.shares !== null && engagement.shares !== undefined ? (
                    <>
                      <b>{engagement.shares}</b> shares
                    </>
                  ) : null}
                </span>
              ) : (
                <span className="social-post-performance__unavailable">
                  Live stats unavailable
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}
function when(value) {
  if (!value) return "";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}
function CommentGroups({ threads, destinations, onReload }) {
  const [expandedId, setExpandedId] = useState(null);
  const deleteMessage = async (threadId, messageId) => {
    if (
      !window.confirm(
        "Delete this from Lead Porch? This does not remove it from Facebook or Instagram.",
      )
    )
      return;
    try {
      await mutateSocialWorkspace(
        `inbox/${threadId}/messages/${messageId}/delete`,
        {},
      );
      onReload();
    } catch {
      window.alert("Could not delete this.");
    }
  };
  // Groups come from the caller's known destinations when there is a fixed
  // list to show (a specific post's platforms, always shown even if empty);
  // otherwise fall back to whatever channels actually turned up.
  const groups =
    destinations || [...new Set(threads.map((row) => row.thread.channel))];
  if (!groups.length) return <p className="social-comment-group__empty">No comments yet.</p>;
  return groups.map((provider) => {
    const Icon = platformIcons[provider];
    const groupThreads = threads.filter((row) => row.thread.channel === provider);
    return (
      <section
        key={provider}
        className={`social-comment-group social-comment-group--${provider}`}
      >
        <header className="social-comment-group__header">
          <span className="social-comment-group__icon">
            {Icon ? <Icon /> : null}
          </span>
          <strong>{platformNames[provider] || provider}</strong>
          <span className="social-comment-group__count">
            {groupThreads.length}
          </span>
        </header>
        {groupThreads.length ? (
          groupThreads.map(({ thread, messages }) => {
            const comment = messages.find(
              (message) => message.direction === "inbound",
            );
            const replies = messages.filter(
              (message) => message.direction === "outbound",
            );
            const commenterName =
              comment?.sender?.name ||
              thread.contactIds?.[0]?.name ||
              "Someone";
            const isExpanded = expandedId === thread._id;
            return (
              <article
                key={thread._id}
                className={`social-comment-thread-card${isExpanded ? " social-comment-thread-card--expanded" : ""}`}
              >
                <button
                  type="button"
                  className="social-comment-thread-card__summary"
                  onClick={() => setExpandedId(isExpanded ? null : thread._id)}
                >
                  <span className="social-comment-thread-card__avatar">
                    {initials(commenterName)}
                  </span>
                  <span className="social-comment-thread-card__summary-body">
                    <span className="social-comment-thread-card__summary-head">
                      <strong>{commenterName}</strong>
                      <span className="social-comment-thread-card__meta">
                        {thread.metadata?.interactionType === "mention"
                          ? "mentioned you"
                          : "commented"}{" "}
                        · {when(comment?.createdAt)}
                      </span>
                      {replies.length ? (
                        <span className="social-comment-thread-card__reply-count">
                          {replies.length} repl{replies.length === 1 ? "y" : "ies"}
                        </span>
                      ) : null}
                    </span>
                    <span className="social-comment-thread-card__snippet">
                      {comment?.body}
                    </span>
                  </span>
                  <span
                    className={`social-post-comments__chevron${isExpanded ? " social-post-comments__chevron--open" : ""}`}
                    aria-hidden="true"
                  >
                    ›
                  </span>
                </button>
                {isExpanded && (
                  <div className="social-comment-thread-card__detail">
                    <div className="social-comment-thread-card__head">
                      <strong>{commenterName}</strong>
                      <button
                        type="button"
                        className="social-message-delete"
                        onClick={() => deleteMessage(thread._id, comment._id)}
                      >
                        Delete
                      </button>
                    </div>
                    <p>{comment?.body}</p>
                    {replies.map((reply) => (
                      <div key={reply._id} className="social-comment-thread-card__reply">
                        <div>
                          <strong>
                            Your reply
                            {reply.metadata?.privateReply ? " (private)" : ""}
                          </strong>
                          <button
                            type="button"
                            className="social-message-delete"
                            onClick={() => deleteMessage(thread._id, reply._id)}
                          >
                            Delete
                          </button>
                        </div>
                        <p>{reply.body}</p>
                      </div>
                    ))}
                    <div className="social-composer-dock">
                      <SocialReplyComposer thread={thread} onSent={onReload} />
                    </div>
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="social-comment-group__empty">
            No {platformNames[provider] || provider} comments yet.
          </p>
        )}
      </section>
    );
  });
}
function PostComments({ item }) {
  const [open, setOpen] = useState(false),
    [threads, setThreads] = useState(null),
    [error, setError] = useState("");
  const destinations = publishedDestinations(item).map((row) => row.provider);
  const load = () => {
    fetchSocialWorkspace(`content/${item._id}/comments`)
      .then((result) => setThreads(result.threads || []))
      .catch(() => setError("Unable to load comments."));
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && threads === null) load();
  };
  const totalCount = threads?.length || 0;
  return (
    <div className="social-post-comments">
      <button
        type="button"
        className="social-post-comments__toggle"
        onClick={toggle}
      >
        <span
          className={`social-post-comments__chevron${open ? " social-post-comments__chevron--open" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
        Comments{threads !== null ? ` (${totalCount})` : ""}
      </button>
      {open && (
        <div className="social-post-comments__panel">
          {error ? <p className="form-error">{error}</p> : null}
          {threads === null ? (
            <p className="social-post-comments__loading">
              Loading comments…
            </p>
          ) : (
            <CommentGroups threads={threads} destinations={destinations} onReload={load} />
          )}
        </div>
      )}
    </div>
  );
}
function UnlinkedComments() {
  const [open, setOpen] = useState(false),
    [threads, setThreads] = useState(null);
  const load = () => {
    fetchSocialWorkspace("content/comments/unlinked")
      .then((result) => setThreads(result.threads || []))
      .catch(() => setThreads([]));
  };
  useEffect(() => {
    load();
  }, []);
  if (!threads || !threads.length) return null;
  return (
    <div className="social-unlinked-comments">
      <button
        type="button"
        className="social-post-comments__toggle social-unlinked-comments__toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={`social-post-comments__chevron${open ? " social-post-comments__chevron--open" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
        Other comments ({threads.length})
      </button>
      <p className="social-unlinked-comments__note">
        Comments on a post that isn't tracked below — published outside Lead
        Porch, or its record here was deleted. Nothing here is lost.
      </p>
      {open && (
        <div className="social-post-comments__panel">
          <CommentGroups threads={threads} destinations={null} onReload={load} />
        </div>
      )}
    </div>
  );
}
export default function Content() {
  const [params] = useSearchParams();
  const [publishingEnabled, setPublishingEnabled] = useState(false);
  const [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [items, setItems] = useState([]),
    [matrix, setMatrix] = useState([]),
    [draft, setDraft] = useState(empty),
    [editing, setEditing] = useState(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false),
    [publishAt, setPublishAt] = useState(""),
    [deleteTarget, setDeleteTarget] = useState(null),
    [uploading, setUploading] = useState(false),
    [publishedNotice, setPublishedNotice] = useState(null),
    [createOpen, setCreateOpen] = useState(false);
  const fileInputRef = useRef(null);
  const load = async () => {
    try {
      const [rows, caps, accounts] = await Promise.all([
        fetchContentBriefs("social"),
        fetchSocialPublishingCapabilities(),
        fetchSocialWorkspace("accounts"),
      ]);
      setItems(rows.data || []);
      setMatrix(caps);
      setPublishingEnabled(accounts.publishingEnabled === true);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to load social content.");
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const selectProvider = (provider, checked) => {
    const cap = matrix.find((row) => row.provider === provider),
      others = draft.social.destinations.filter(
        (row) => row.provider !== provider,
      );
    setDraft({
      ...draft,
      social: {
        ...draft.social,
        destinations: checked
          ? [
              ...others,
              {
                provider,
                assetId: cap?.asset?.id || "",
                mode: cap?.status || "unavailable",
              },
            ]
          : others,
      },
    });
  };
  const save = async () => {
    try {
      setSaving(true);
      if (editing) await updateContentBrief(editing._id, draft);
      else await createContentBrief(draft);
      setOpen(false);
      setDraft(empty);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save social content.");
    } finally {
      setSaving(false);
    }
  };
  const act = async (fn, id, ...args) => {
    try {
      setSaving(true);
      const result = await fn(id, ...args);
      if (fn === publishSocialContentNow) {
        setPublishedNotice(
          result?.status === "published"
            ? "Published! Check your connected accounts."
            : result?.status === "partially_published"
              ? `Published to some accounts, not all. ${result.social?.lastError || ""}`
              : `Could not publish: ${result?.social?.lastError || "Unknown error."}`,
        );
      } else {
        setMessage("Social content updated.");
      }
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update social content.");
    } finally {
      setSaving(false);
    }
  };
  const uploadImage = (file) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG, WEBP or GIF up to 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setUploading(true);
        const asset = await mutateSocialWorkspace("media", {
          file: reader.result,
          alt: file.name,
        });
        setDraft((value) => ({
          ...value,
          social: { ...value.social, media: [{ ...asset, type: "image" }] },
        }));
      } catch (err) {
        setError(err.response?.data?.error || "Unable to upload this photo.");
      } finally {
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };
  const confirmDelete = async () => {
    try {
      setSaving(true);
      await deleteSocialContent(deleteTarget._id);
      setDeleteTarget(null);
      setMessage("Post deleted.");
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to delete this post.");
    } finally {
      setSaving(false);
    }
  };
  const edit = (item) => {
    setEditing(item);
    setDraft({
      title: item.title,
      type: "social",
      body: item.body,
      callToAction: item.callToAction || "",
      source: item.source,
      social: {
        destinations: item.social?.destinations || [],
        media: item.social?.media || [],
        cta: item.social?.cta || { label: "", url: "" },
      },
    });
    setOpen(true);
  };
  return (
    <div className="page-dashboard social-content">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Social operations</p>
          <h1 className="page-title">Content approval & publishing</h1>
          <p className="page-subtitle">
            Write posts manually or with optional AI assistance. Review the
            caption, image, and destinations, then approve before publishing.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create post</Button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="discovery-notice">{message}</p> : null}
      {!publishingEnabled && (
        <p className="social-publishing-safety" role="status">
          Publishing is currently disabled. Draft creation and review remain
          available; nothing can publish until the server safety setting is
          enabled.
        </p>
      )}
      <section className="social-capabilities">
        {matrix.map((row) => {
          const Icon = platformIcons[row.provider];
          return (
            <article key={row.provider} className={`social-capabilities__card social-capabilities__card--${row.provider}`}>
              <span className="social-capabilities__icon" aria-hidden="true">
                {Icon ? <Icon /> : null}
              </span>
              <strong>{platformNames[row.provider] || row.provider}</strong>
              <span className={`status-${row.status}`}>{labels[row.status]}</span>
              <small>{row.asset?.name || row.reason}</small>
            </article>
          );
        })}
      </section>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit social content" : "New social draft"}
        size="workspace"
        className="social-editor-modal"
        footer={
          <Button
            loading={saving}
            disabled={!draft.title || !draft.body}
            onClick={save}
          >
            {editing ? "Save changes" : "Save draft"}
          </Button>
        }
      >
        {["published", "partially_published"].includes(editing?.status) && (
          <p className="social-publishing-safety" role="status">
            This post already went out. Saving here only updates your Lead
            Porch record (useful for notes or reusing it later) — it does not
            change the post already live on Facebook or Instagram.
          </p>
        )}
        <div className="social-editor__layout">
            <div className="social-editor__fields">
              <label>
                Internal title
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </label>
              <label>
                Caption
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </label>
              <label>
                CTA label
                <input
                  value={draft.social.cta.label}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      social: {
                        ...draft.social,
                        cta: { ...draft.social.cta, label: e.target.value },
                      },
                    })
                  }
                />
              </label>
              <label>
                CTA/link URL
                <input
                  type="url"
                  value={draft.social.cta.url}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      social: {
                        ...draft.social,
                        cta: { ...draft.social.cta, url: e.target.value },
                      },
                    })
                  }
                />
              </label>
              <label>
                Photo <small>Required for Instagram</small>
                <div className="social-editor__upload">
                  {draft.social.media[0]?.url ? (
                    <div className="social-editor__upload-preview">
                      <img src={draft.social.media[0].url} alt="" />
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({ ...draft, social: { ...draft.social, media: [] } })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={(e) => uploadImage(e.target.files?.[0])}
                        hidden
                      />
                      <Button
                        type="button"
                        variant="outline"
                        loading={uploading}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Upload photo
                      </Button>
                    </>
                  )}
                </div>
              </label>
              <fieldset>
                <legend>Destinations</legend>
                {matrix.map((row) => (
                  <label key={row.provider}>
                    <input
                      type="checkbox"
                      disabled={row.status !== "api" || !row.asset?.id}
                      checked={draft.social.destinations.some(
                        (item) => item.provider === row.provider,
                      )}
                      onChange={(e) =>
                        selectProvider(row.provider, e.target.checked)
                      }
                    />
                    {row.provider} · {labels[row.status]}
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="social-editor__preview">
              <span className="social-editor__preview-label">Preview</span>
              <PostPreview draft={draft} />
            </div>
        </div>
      </Modal>
      {params.get("content") && (
        <Link to="/social/content">Show all content</Link>
      )}
      <div className="social-filters">
        <label>
          Search content
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {[
              "draft",
              "pending_approval",
              "approved",
              "scheduled",
              "publishing",
              "published",
              "partially_published",
              "failed",
              "archived",
            ].map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <UnlinkedComments />
      <section className="social-queue">
        {items.length ? (
          items
            .filter(
              (item) =>
                (!params.get("content") ||
                  params.get("content") === item._id) &&
                (!statusFilter || item.status === statusFilter) &&
                `${item.title} ${item.body}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((item) => (
              <article
                key={item._id}
                id={`content-${item._id}`}
                className={
                  params.get("content") === item._id
                    ? "social-content--selected"
                    : ""
                }
              >
                <header>
                  <div>
                    <span className={`social-status-pill social-status-pill--${item.status}`}>
                      {item.status.replaceAll("_", " ")}
                    </span>
                    <h2>{item.title}</h2>
                    <small>
                      {item.source === "jarvis"
                        ? "Generated by Jarvis"
                        : item.source === "campaign"
                          ? "Campaign content"
                          : "Human draft"}
                      {item.campaignId?.name
                        ? ` · ${item.campaignId.name}`
                        : ""}
                    </small>
                  </div>
                  <div>
                    {item.social?.destinations?.map((row) => {
                      const Icon = platformIcons[row.provider];
                      return (
                        <em
                          key={`${row.provider}:${row.assetId}`}
                          className={`social-destination-badge social-destination-badge--${row.provider}`}
                        >
                          {Icon ? <Icon /> : null}
                          {platformNames[row.provider] || row.provider}
                        </em>
                      );
                    })}
                  </div>
                </header>
                <p>{item.body}</p>
                {item.social?.media?.[0]?.url ? (
                  <img
                    src={item.social.media[0].url}
                    alt={item.social.media[0].alt || "Social media preview"}
                  />
                ) : null}
                {item.social?.cta?.url ? (
                  <a
                    href={item.social.cta.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.social.cta.label || "CTA"}: {item.social.cta.url}
                  </a>
                ) : null}
                <PostPerformance item={item} />
                {item.social?.requestedPublishAt ? (
                  <small>
                    Requested:{" "}
                    {new Date(item.social.requestedPublishAt).toLocaleString()}
                  </small>
                ) : null}
                {item.social?.lastError ? (
                  <p className="form-error">{item.social.lastError}</p>
                ) : null}
                <footer>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={["scheduled", "publishing"].includes(item.status)}
                    title={
                      ["scheduled", "publishing"].includes(item.status)
                        ? "Cancel the schedule first to edit this post"
                        : undefined
                    }
                    onClick={() => edit(item)}
                  >
                    Edit
                  </Button>
                  {["draft", "rejected", "failed"].includes(item.status) ? (
                    <Button
                      size="sm"
                      onClick={() => act(requestSocialApproval, item._id)}
                    >
                      Request approval
                    </Button>
                  ) : null}
                  {item.status === "pending_approval" ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => act(approveSocialContent, item._id)}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const reason = window.prompt("Why is this rejected?");
                          if (reason)
                            act(rejectSocialContent, item._id, reason);
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {item.status === "approved" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={
                          saving ||
                          Boolean(
                            publishingBlocker(item, matrix, publishingEnabled),
                          )
                        }
                        onClick={() => act(publishSocialContentNow, item._id)}
                      >
                        Publish now
                      </Button>
                      <input
                        aria-label="Publish date and time"
                        type="datetime-local"
                        value={publishAt}
                        onChange={(e) => setPublishAt(e.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={
                          saving ||
                          !publishAt ||
                          Boolean(
                            publishingBlocker(item, matrix, publishingEnabled),
                          )
                        }
                        onClick={() =>
                          act(
                            scheduleSocialContent,
                            item._id,
                            new Date(publishAt).toISOString(),
                          )
                        }
                      >
                        Schedule
                      </Button>
                    </>
                  ) : null}
                  {item.status === "scheduled" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => act(cancelSocialContent, item._id)}
                    >
                      Cancel schedule
                    </Button>
                  ) : null}
                  {["failed", "partially_published"].includes(item.status) ? (
                    <Button
                      size="sm"
                      disabled={
                        saving ||
                        Boolean(
                          publishingBlocker(item, matrix, publishingEnabled),
                        )
                      }
                      onClick={() => act(retrySocialContent, item._id)}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => act(duplicateSocialContent, item._id)}
                  >
                    Duplicate
                  </Button>
                  {!["scheduled", "publishing"].includes(item.status) && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeleteTarget(item)}
                    >
                      Delete
                    </Button>
                  )}
                </footer>
                {["approved", "failed", "partially_published"].includes(
                  item.status,
                ) &&
                  publishingBlocker(item, matrix, publishingEnabled) && (
                    <p className="social-publishing-safety">
                      {publishingBlocker(item, matrix, publishingEnabled)}
                    </p>
                  )}
                {publishedDestinations(item).length ? (
                  <PostComments item={item} />
                ) : null}
                <SocialContentDetail content={item} />
                {item.social?.publications?.length ? (
                  <details className="social-receipts">
                    <summary>Publication receipts</summary>
                    {item.social.publications.map((row) => {
                      const Icon = platformIcons[row.provider];
                      return (
                        <p
                          key={`${row.provider}:${row.assetId}`}
                          className={`social-receipts__row social-receipts__row--${row.provider}`}
                        >
                          <span className="social-receipts__icon">
                            {Icon ? <Icon /> : null}
                          </span>
                          <strong>{platformNames[row.provider] || row.provider}</strong>
                          <span
                            className={`social-status-pill social-status-pill--${row.status}`}
                          >
                            {row.status.replaceAll("_", " ")}
                          </span>
                          <span className="social-receipts__id">
                            {row.providerPostId ||
                              row.attempts?.at(-1)?.error ||
                              "Pending"}
                          </span>
                        </p>
                      );
                    })}
                  </details>
                ) : null}
              </article>
            ))
        ) : (
          <p className="table-state table-state--empty">
            No posts yet. Select Create post to write a caption, choose
            accounts, attach an image, and save a draft. AI is optional.
          </p>
        )}
      </section>
      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete this post?"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button variant="danger" loading={saving} onClick={confirmDelete}>
              Delete post
            </Button>
          </>
        }
      >
        <p>
          This permanently removes "{deleteTarget?.title}" — this cannot be
          undone. Already-published posts on Facebook or Instagram are not
          affected; this only removes it from Lead Porch.
        </p>
      </Modal>
      <Modal
        isOpen={Boolean(publishedNotice)}
        onClose={() => setPublishedNotice(null)}
        title="Publish now"
        footer={
          <Button onClick={() => setPublishedNotice(null)}>Done</Button>
        }
      >
        <p>{publishedNotice}</p>
      </Modal>
      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false);
          load();
        }}
        title="Create post"
        size="workspace"
      >
        <SocialStudio />
      </Modal>
    </div>
  );
}
