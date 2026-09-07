import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { publishingBlocker } from "../utils/socialPublishingReadiness.js";
import SocialContentDetail from "../components/SocialContentDetail.jsx";
import Button from "../components/Button.jsx";
import {
  fetchSocialWorkspace,
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
function PostPreview({ draft }) {
  const providers = draft.social.destinations.map((row) => row.provider);
  const platform = providers.includes("instagram")
    ? "Instagram"
    : providers.includes("facebook")
      ? "Facebook"
      : providers[0]
        ? providers[0][0].toUpperCase() + providers[0].slice(1)
        : "Preview";
  const image = draft.social.media[0]?.url;
  return (
    <div className="post-preview-phone">
      <div className="post-preview-phone__notch" />
      <div className="post-preview-card">
        <div className="post-preview-card__head">
          <span className="post-preview-card__avatar">L</span>
          <div>
            <strong>Lead Porch</strong>
            <small>{platform}</small>
          </div>
        </div>
        {image ? (
          <img src={image} alt="" className="post-preview-card__image" />
        ) : (
          <div className="post-preview-card__image post-preview-card__image--empty">
            Add an image URL to preview it here
          </div>
        )}
        <div className="post-preview-card__icons" aria-hidden="true">
          <span>♡</span>
          <span>💬</span>
          <span>↗</span>
        </div>
        <p className="post-preview-card__caption">
          {draft.body || "Your caption will appear here as you type."}
        </p>
        {draft.social.cta.label && (
          <a className="post-preview-card__cta" href={draft.social.cta.url || "#"}>
            {draft.social.cta.label}
          </a>
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
    [publishAt, setPublishAt] = useState("");
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
      await fn(id, ...args);
      setMessage("Social content updated.");
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update social content.");
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
        {matrix.map((row) => (
          <article key={row.provider}>
            <strong>{row.provider}</strong>
            <span className={`status-${row.status}`}>{labels[row.status]}</span>
            <small>{row.asset?.name || row.reason}</small>
          </article>
        ))}
      </section>
      {open ? (
        <section className="social-editor social-editor--split">
          <header>
            <h2>{editing ? "Edit social content" : "New social draft"}</h2>
            <button onClick={() => setOpen(false)}>Close</button>
          </header>
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
                Public image URL (required for Instagram)
                <input
                  type="url"
                  value={draft.social.media[0]?.url || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      social: {
                        ...draft.social,
                        media: e.target.value
                          ? [{ type: "image", url: e.target.value, alt: "" }]
                          : [],
                      },
                    })
                  }
                />
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
              <Button
                loading={saving}
                disabled={!draft.title || !draft.body}
                onClick={save}
              >
                {editing ? "Save and return to approval" : "Save draft"}
              </Button>
            </div>
            <div className="social-editor__preview">
              <span className="social-editor__preview-label">Preview</span>
              <PostPreview draft={draft} />
            </div>
          </div>
        </section>
      ) : null}
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
                    <span>{item.status.replaceAll("_", " ")}</span>
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
    </div>
  );
}
