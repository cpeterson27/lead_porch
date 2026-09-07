import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FaFacebookF, FaInstagram, FaLinkedinIn, FaTiktok, FaXTwitter } from "react-icons/fa6";
import { publishingBlocker } from "../utils/socialPublishingReadiness.js";
import SocialContentDetail from "../components/SocialContentDetail.jsx";
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
    [publishedNotice, setPublishedNotice] = useState(null);
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
        <Link className="btn btn--primary" to="/social/create">
          Create post
        </Link>
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
                    {item.social?.destinations?.map((row) => (
                      <em key={`${row.provider}:${row.assetId}`}>
                        {row.provider} · {labels[row.mode]}
                      </em>
                    ))}
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
                    disabled={["scheduled", "publishing", "published"].includes(
                      item.status,
                    )}
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
                <SocialContentDetail content={item} />
                {item.social?.publications?.length ? (
                  <details>
                    <summary>Publication receipts</summary>
                    {item.social.publications.map((row) => (
                      <p key={`${row.provider}:${row.assetId}`}>
                        {row.provider} · {row.status} ·{" "}
                        {row.providerPostId ||
                          row.attempts?.at(-1)?.error ||
                          "Pending"}
                      </p>
                    ))}
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
    </div>
  );
}
