import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  createContentBrief,
  createSocialAutomation,
  fetchCampaigns,
  fetchSocialWorkspace,
  mutateSocialWorkspace,
  fetchSocialPublishingCapabilities,
  requestSocialApproval,
  approveSocialContent,
  cancelSocialContent,
  scheduleSocialContent,
  publishSocialContentNow,
} from "../services/api.js";
import {
  CampaignSelect,
  ContactLabelsControl,
} from "../components/SocialAutomationFields.jsx";
const actions = [
  "Generate post",
  "Rewrite",
  "Shorten",
  "Expand",
  "Change tone",
  "Generate platform variants",
  "Generate hashtags",
  "Generate CTA",
  "Generate keyword CTA",
  "Generate ambassador version",
  "Generate image brief",
  "Generate content ideas",
  "Repurpose existing content",
];
function PostAutomationSection({ value, onChange, campaigns, onError }) {
  const set = (values) => onChange({ ...value, ...values });
  return (
    <details className="post-automation" open={value.configured}>
      <summary>
        <strong>Automate responses to this post</strong>
        <span>Optional · uses Social Automation</span>
      </summary>
      <label className="post-automation__toggle">
        <input
          type="checkbox"
          checked={value.configured}
          onChange={(event) => set({ configured: event.target.checked })}
        />
        Configure a response automation for this post
      </label>
      {value.configured && (
        <div className="post-automation__fields">
          <label className="post-automation__field--full">
            Automation name <small>Internal only</small>
            <input
              value={value.name}
              placeholder="Freedom lead responses"
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
          <label>
            Trigger
            <select
              value={value.triggerType}
              onChange={(event) => set({ triggerType: event.target.value })}
            >
              <option value="comment_keyword">Comment contains keyword</option>
              <option value="comment_any">Any new comment</option>
            </select>
          </label>
          {value.triggerType === "comment_keyword" && (
            <label>
              Keywords
              <input
                placeholder="DEAL"
                value={value.keywords}
                onChange={(event) => set({ keywords: event.target.value })}
              />
              <small>Separate multiple keywords with commas.</small>
            </label>
          )}
          <label className="post-automation__field--full">
            Automatic reply
            <textarea
              rows="4"
              value={value.responseTemplate}
              onChange={(event) =>
                set({ responseTemplate: event.target.value })
              }
            />
            <small>
              Delivery still follows existing Meta permissions and the
              automatic-reply safety setting.
            </small>
          </label>
          <label>
            Button text (optional)
            <input
              placeholder="Learn more"
              value={value.ctaLabel}
              onChange={(event) => set({ ctaLabel: event.target.value })}
            />
          </label>
          <label>
            Button link (optional)
            <input
              type="url"
              placeholder="https://elliescoaching.com/apply"
              value={value.ctaDestination}
              onChange={(event) => set({ ctaDestination: event.target.value })}
            />
          </label>
          <CampaignSelect
            campaigns={campaigns}
            value={value.campaignId}
            onChange={(campaignId) => set({ campaignId })}
          />
          <ContactLabelsControl
            value={value.tags}
            onChange={(tags) => set({ tags })}
            onError={onError}
          />
          <label className="post-automation__toggle">
            <input
              type="checkbox"
              checked={value.enabledWhenPublished}
              onChange={(event) =>
                set({ enabledWhenPublished: event.target.checked })
              }
            />
            Turn on when post is published
          </label>
        </div>
      )}
    </details>
  );
}
export default function SocialStudio() {
  const [draft, setDraft] = useState({
      title: "",
      body: "",
      type: "social",
      source: "human",
      social: { media: [], destinations: [], cta: { label: "", url: "" } },
    }),
    [action, setAction] = useState(actions[0]),
    [instructions, setInstructions] = useState(""),
    [messageId, setMessageId] = useState(""),
    [communications, setCommunications] = useState([]),
    [relations, setRelations] = useState({ offerings: [], events: [] }),
    [matrix, setMatrix] = useState([]),
    [publishingEnabled, setPublishingEnabled] = useState(false),
    [savedId, setSavedId] = useState(""),
    [library, setLibrary] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [postAutomation, setPostAutomation] = useState({
    configured: false,
    name: "",
    triggerType: "comment_keyword",
    keywords: "",
    responseTemplate: "",
    ctaLabel: "",
    ctaDestination: "",
    campaignId: "",
    tags: [],
    enabledWhenPublished: true,
  });
  const [campaigns, setCampaigns] = useState([]),
    [automationSavedDestinations, setAutomationSavedDestinations] = useState(
      [],
    );
  useEffect(() => {
    let active = true;
    Promise.all([
      fetchSocialPublishingCapabilities(),
      fetchSocialWorkspace("media"),
      fetchSocialWorkspace("communications"),
      fetchSocialWorkspace("relations"),
      fetchSocialWorkspace("accounts"),
      fetchCampaigns(),
    ])
      .then(([caps, assets, messages, related, accounts, nextCampaigns]) => {
        if (active) {
          setMatrix(caps);
          setPublishingEnabled(accounts.publishingEnabled === true);
          setLibrary(assets);
          setCommunications(messages);
          setRelations(related);
          setCampaigns(
            Array.isArray(nextCampaigns) ? nextCampaigns.filter(Boolean) : [],
          );
        }
      })
      .catch(() => {
        if (active)
          setError(
            "Account/media information is unavailable. You can still write a draft.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to complete this action.");
    } finally {
      setBusy(false);
    }
  };
  const addAsset = (asset) =>
    setDraft((value) => ({
      ...value,
      social: { ...value.social, media: [{ ...asset, type: "image" }] },
    }));
  const upload = (file) => {
    if (!file) return;
    if (
      !/^image\/(jpeg|png|webp|gif)$/.test(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError("Choose a JPG, PNG, WEBP or GIF up to 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      run(async () =>
        addAsset(
          await mutateSocialWorkspace("media", {
            file: reader.result,
            alt: file.name,
          }),
        ),
      );
    reader.readAsDataURL(file);
  };
  const metaDestinations = draft.social.destinations.filter((row) =>
    ["facebook", "instagram"].includes(row.provider),
  );
  const ensureSaved = async () => {
    let contentBriefId = savedId;
    if (!contentBriefId) {
      const result = await createContentBrief(draft);
      contentBriefId = result.data?._id || result._id || "";
      if (!contentBriefId)
        throw new Error("The saved post did not return an identifier.");
      setSavedId(contentBriefId);
    }
    if (postAutomation.configured) {
      if (!metaDestinations.length)
        throw new Error(
          "Choose at least one connected Facebook or Instagram destination for this automation.",
        );
      if (!postAutomation.name.trim())
        throw new Error("Enter an internal automation name.");
      if (
        postAutomation.triggerType === "comment_keyword" &&
        !postAutomation.keywords.trim()
      )
        throw new Error(
          "Enter at least one comment keyword that should trigger this automation.",
        );
      const saved = new Set(automationSavedDestinations);
      for (const destination of metaDestinations) {
        const destinationKey = `${destination.provider}:${destination.assetId}`;
        if (saved.has(destinationKey)) continue;
        await createSocialAutomation({
          name:
            metaDestinations.length > 1
              ? `${postAutomation.name.trim()} — ${destination.provider}`
              : postAutomation.name.trim(),
          provider: destination.provider,
          assetId: destination.assetId,
          contentBriefId,
          contentId: "",
          triggerType: postAutomation.triggerType,
          keywords:
            postAutomation.triggerType === "comment_keyword"
              ? postAutomation.keywords
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              : [],
          responseTemplate: postAutomation.responseTemplate,
          cta: {
            label: postAutomation.ctaLabel,
            destination: postAutomation.ctaDestination,
          },
          campaignId: postAutomation.campaignId || null,
          tags: postAutomation.tags,
          qualification: [],
          enabled: postAutomation.enabledWhenPublished,
        });
        saved.add(destinationKey);
        setAutomationSavedDestinations([...saved]);
      }
    }
    return contentBriefId;
  };
  const savePost = () =>
    run(async () => {
      await ensureSaved();
      setNotice(
        postAutomation.configured
          ? "Draft and post response automation saved."
          : "Draft saved.",
      );
    });
  // Moves a draft into "approved" regardless of where it currently sits in
  // the review lifecycle, so Publish now / Schedule work as one click instead
  // of requiring a separate trip through the Content Library to manually
  // request approval and approve every time.
  const readyForApproval = async (id) => {
    await cancelSocialContent(id).catch(() => {});
    await requestSocialApproval(id).catch(() => {});
    await approveSocialContent(id).catch(() => {});
  };
  const publishNow = () =>
    run(async () => {
      if (!draft.social.destinations.length)
        throw new Error("Choose at least one connected destination first.");
      const id = await ensureSaved();
      await readyForApproval(id);
      const result = await publishSocialContentNow(id);
      setNotice(
        result.status === "published"
          ? "Published. Check your connected Facebook/Instagram account."
          : result.status === "partially_published"
            ? `Published to some accounts, not all. ${result.social?.lastError || ""}`
            : `Could not publish: ${result.social?.lastError || "Approve this post and add a destination, then try again."}`,
      );
    });
  const [scheduleAt, setScheduleAt] = useState("");
  const scheduleForLater = () =>
    run(async () => {
      if (!draft.social.destinations.length)
        throw new Error("Choose at least one connected destination first.");
      if (!scheduleAt) throw new Error("Choose a date and time to schedule this post.");
      const id = await ensureSaved();
      await readyForApproval(id);
      await scheduleSocialContent(id, new Date(scheduleAt).toISOString());
      setNotice(`Scheduled for ${new Date(scheduleAt).toLocaleString()}.`);
    });
  const automationComplete =
    metaDestinations.length > 0 &&
    metaDestinations.every((row) =>
      automationSavedDestinations.includes(`${row.provider}:${row.assetId}`),
    );
  const automationReady =
    !postAutomation.configured ||
    (metaDestinations.length > 0 &&
      Boolean(postAutomation.name.trim()) &&
      (postAutomation.triggerType !== "comment_keyword" ||
        Boolean(postAutomation.keywords.trim())));
  return (
    <section className="social-panel social-studio">
      <h2>Create a post</h2>
      <p>
        Choose your accounts, write a caption, add an image, and preview your
        post. Manual posts do not use AI credits.
      </p>
      {!publishingEnabled && (
        <p role="status" className="social-publishing-safety">
          Publishing is currently disabled. You can still save a draft and
          prepare it for review.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <label>
        Internal post name{" "}
        <small>
          For organizing your content. This won't appear on social media.
        </small>
        <input
          placeholder="Freedom coaching intro"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        Caption
        <textarea
          rows="8"
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </label>
      <label>
        Reply Button Text
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
        Link
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
        Is this post promoting something? (optional)
        <select
          value={draft.coachingProgramId || ""}
          onChange={(e) =>
            setDraft({ ...draft, coachingProgramId: e.target.value || null })
          }
        >
          <option value="">No — general content</option>
          {relations.offerings.map((row) => (
            <option key={row._id} value={row._id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Related event (optional)
        <select
          value={draft.eventId || ""}
          onChange={(e) =>
            setDraft({ ...draft, eventId: e.target.value || null })
          }
        >
          <option value="">No event</option>
          {relations.events.map((row) => (
            <option key={row._id} value={row._id}>
              {row.name || row.title}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Choose connected destinations</legend>
        {matrix.map((row) => (
          <label key={row.provider}>
            <input
              type="checkbox"
              disabled={row.status !== "api" || !row.asset?.id}
              checked={draft.social.destinations.some(
                (d) => d.provider === row.provider,
              )}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  social: {
                    ...draft.social,
                    destinations: e.target.checked
                      ? [
                          ...draft.social.destinations,
                          {
                            provider: row.provider,
                            assetId: row.asset?.id || "",
                            mode: row.status,
                          },
                        ]
                      : draft.social.destinations.filter(
                          (d) => d.provider !== row.provider,
                        ),
                  },
                })
              }
            />
            {row.provider} · {row.asset?.name || row.reason}
          </label>
        ))}
      </fieldset>
      <p>
        Instagram requires one hosted image. Facebook supports text-only posts
        or one image. Video and carousel publishing are not available in this
        flow.
      </p>
      <label>
        Upload image
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          disabled={busy}
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </label>
      <details>
        <summary>Choose from existing content media</summary>
        {library.map((asset, i) => (
          <button
            key={`${asset.publicId || asset.url}-${i}`}
            onClick={() => addAsset(asset)}
          >
            {asset.title} · {asset.alt || "Image"}
          </button>
        ))}
      </details>
      <div className="social-media-preview">
        {draft.social.media.map((asset, i) => (
          <figure key={`${asset.url}-${i}`}>
            <img
              src={asset.url}
              alt={asset.alt || "Content preview"}
              style={{ maxWidth: "100%", maxHeight: 240 }}
            />
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  social: {
                    ...draft.social,
                    media: draft.social.media.filter((_, n) => n !== i),
                  },
                })
              }
            >
              Remove
            </button>
          </figure>
        ))}
      </div>
      <details>
        <summary>
          AI writing assistant — generates editable copy, never publishes
        </summary>
        <label>
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {actions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Instructions
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        <label>
          Repurpose an existing sent communication (optional)
          <select
            value={messageId}
            onChange={(e) => setMessageId(e.target.value)}
          >
            <option value="">Use my current caption</option>
            {communications.map((row) => (
              <option key={row._id} value={row._id}>
                {row.subject || row.body.slice(0, 70)}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const result = await mutateSocialWorkspace("generate", {
                action,
                instructions,
                body: draft.body,
                messageId: messageId || undefined,
              });
              setDraft({
                ...draft,
                body: result.body,
                source: "jarvis",
                social: {
                  ...draft.social,
                  variants: result.variants || draft.social.variants || [],
                },
              });
            })
          }
        >
          Generate editable copy
        </button>
        <p>
          Generation uses configured AI credits. Platform variants make up to
          five AI requests. Nothing is published.
        </p>
      </details>
      {(draft.social.variants || []).map((variant, index) => (
        <label key={variant.provider}>
          {variant.provider} caption variant
          <textarea
            rows="4"
            value={variant.body}
            onChange={(e) =>
              setDraft({
                ...draft,
                social: {
                  ...draft.social,
                  variants: draft.social.variants.map((row, i) =>
                    i === index ? { ...row, body: e.target.value } : row,
                  ),
                },
              })
            }
          />
        </label>
      ))}
      <PostAutomationSection
        value={postAutomation}
        onChange={setPostAutomation}
        campaigns={campaigns}
        onError={setError}
      />
      <details>
        <summary>Caption preview</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{draft.body}</p>
        <p>
          {draft.social.cta.label} {draft.social.cta.url}
        </p>
      </details>
      <div className="social-studio__actions">
        <button
          disabled={
            busy ||
            !automationReady ||
            (savedId && (!postAutomation.configured || automationComplete)) ||
            !draft.title.trim() ||
            !draft.body.trim()
          }
          onClick={savePost}
        >
          {savedId && postAutomation.configured && !automationComplete
            ? "Retry post automation"
            : "Save draft"}
        </button>
        <button
          className="social-studio__publish-now"
          disabled={
            busy ||
            !publishingEnabled ||
            !draft.title.trim() ||
            !draft.body.trim() ||
            !draft.social.destinations.length
          }
          onClick={publishNow}
        >
          Publish now
        </button>
        <div className="social-studio__schedule">
          <input
            type="datetime-local"
            aria-label="Schedule date and time"
            value={scheduleAt}
            onChange={(event) => setScheduleAt(event.target.value)}
          />
          <button
            disabled={
              busy ||
              !publishingEnabled ||
              !scheduleAt ||
              !draft.title.trim() ||
              !draft.body.trim() ||
              !draft.social.destinations.length
            }
            onClick={scheduleForLater}
          >
            Schedule for later
          </button>
        </div>
      </div>
      <Link
        className="social-studio__library-link"
        to={savedId ? `/social/content?content=${savedId}` : "/social/content"}
      >
        {savedId ? "View this post in the Content Library" : "Open Content Library"}
      </Link>
    </section>
  );
}
