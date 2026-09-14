import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import UnlayerEmailEditor from "../components/UnlayerEmailEditor.jsx";
import {
  approveCampaignEmailTemplate,
  approveCampaignAudienceRouting,
  assignCampaignAudience,
  fetchCampaign,
  fetchCampaignEmailTemplate,
  fetchWorkspaceConfig,
  generateCampaignEmailIdeas,
  previewCampaignAudience,
  previewCampaignEmailTemplate,
  saveCampaignEmailTemplate,
  updateCampaignAudienceTags,
  updateCampaignBrand,
  updateCampaignSchedule,
  uploadEventImage,
} from "../services/api.js";
import "./CampaignWorkspace.css";
import "./CampaignAudience.css";
import "./CampaignRegistration.css";

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "Evergreen";
const formatMoney = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
const dateInputValue = (value) =>
  value ? new Date(value).toISOString().slice(0, 10) : "";
const normalizeBrandAssets = (row) => {
  const brand = row?.brand || {};
  return {
    ...row,
    brand: brand.flyerUrl
      ? brand
      : { ...brand, flyerUrl: brand.logoUrl || "", logoUrl: "" },
  };
};
const RESEARCH_EMAIL_AUDIENCES = [
  {
    key: "research-qualified-investor",
    label: "Qualified professional / investor",
  },
  { key: "research-sec-fund-executive", label: "SEC fund executive" },
  { key: "research-community-partner", label: "Community partner" },
  { key: "research-ticket-buyer", label: "Individual ticket buyer" },
];

export default function CampaignWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [audienceMatch, setAudienceMatch] = useState(null);
  const [matchingAudience, setMatchingAudience] = useState(false);
  const [approvingRouting, setApprovingRouting] = useState(false);
  const [matchPage, setMatchPage] = useState(1);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleNotice, setScheduleNotice] = useState("");
  const [emailTemplate, setEmailTemplate] = useState(null);
  const [templateVersions, setTemplateVersions] = useState([]);
  const [templateHistoryOpen, setTemplateHistoryOpen] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [ideaGenerating, setIdeaGenerating] = useState(false);
  const [ideaPrompt, setIdeaPrompt] = useState("");
  const [workspaceDefaultLogoUrl, setWorkspaceDefaultLogoUrl] = useState("");
  const [logoSaving, setLogoSaving] = useState(false);
  const [audienceTagsSaving, setAudienceTagsSaving] = useState(false);
  const [newAudienceTag, setNewAudienceTag] = useState("");
  const [templateDirty, setTemplateDirty] = useState(false);
  const [templateNotice, setTemplateNotice] = useState("");
  const [emailPreview, setEmailPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [templateAudience, setTemplateAudience] = useState("general");
  // Unlayer only loads its `design` prop once, on mount — bumping this key
  // forces a clean remount (and re-load) when restoring a historical
  // version, since the editor has no supported "swap design mid-session"
  // event of its own.
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);
  const messageRef = useRef(null);
  const audienceDetailsRef = useRef(null);

  useEffect(() => {
    if (!id) {
      const missingId = window.setTimeout(() => {
        setError("Campaign ID missing.");
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(missingId);
    }
    fetchCampaign(id)
      .then((row) => setCampaign(normalizeBrandAssets(row)))
      .catch((err) =>
        setError(err.response?.data?.error || "Unable to load campaign."),
      )
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    fetchCampaignEmailTemplate(id, templateAudience)
      .then(({ template, versions }) => {
        setEmailTemplate(template);
        setTemplateDirty(false);
        setTemplateNotice("");
        setTemplateVersions(versions || []);
      })
      .catch(() => {});
  }, [id, templateAudience]);

  useEffect(() => {
    if (!id) return;
    previewCampaignAudience(id)
      .then(setAudienceMatch)
      .catch(() => setAudienceMatch(null));
  }, [id]);

  useEffect(() => {
    fetchWorkspaceConfig()
      .then((config) => setWorkspaceDefaultLogoUrl(config.organizationLogoUrl || ""))
      .catch(() => {});
  }, []);

  const refreshAudience = async () => {
    try {
      setMatchingAudience(true);
      setError("");
      await assignCampaignAudience(id);
      setAudienceMatch(await previewCampaignAudience(id));
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to match campaign contacts.",
      );
    } finally {
      setMatchingAudience(false);
    }
  };

  const approveRouting = async () => {
    try {
      setApprovingRouting(true);
      setError("");
      await approveCampaignAudienceRouting(id);
      setAudienceMatch(await previewCampaignAudience(id));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to approve recipient routing.");
    } finally {
      setApprovingRouting(false);
    }
  };

  const handleDesignChange = ({ html, design }) => {
    setEmailTemplate((current) => ({ ...current, body: html, designJson: design }));
    setTemplateDirty(true);
    setTemplateNotice("");
  };

  const uploadInlineImage = async (file) => {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const uploaded = await uploadEventImage({ file: dataUrl, filename: file.name });
      return uploaded.url;
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload that image.");
      return null;
    }
  };

  const chooseEmailLogo = async (file) => {
    if (!file) return;
    setLogoSaving(true);
    setError("");
    try {
      const url = await uploadInlineImage(file);
      if (!url) return;
      setCampaign(normalizeBrandAssets(await updateCampaignBrand(id, { emailLogoUrl: url })));
    } finally {
      setLogoSaving(false);
    }
  };

  const resetEmailLogoToDefault = async () => {
    setLogoSaving(true);
    setError("");
    try {
      setCampaign(normalizeBrandAssets(await updateCampaignBrand(id, { emailLogoUrl: "" })));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to reset the logo.");
    } finally {
      setLogoSaving(false);
    }
  };

  const saveAudienceTags = async (nextAudience) => {
    setAudienceTagsSaving(true);
    setError("");
    try {
      setCampaign(normalizeBrandAssets(await updateCampaignAudienceTags(id, nextAudience)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update the target audience.");
    } finally {
      setAudienceTagsSaving(false);
    }
  };

  const addAudienceTag = () => {
    const value = newAudienceTag.trim();
    if (!value) return;
    if ((campaign.audience || []).some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setNewAudienceTag("");
      return;
    }
    setNewAudienceTag("");
    saveAudienceTags([...(campaign.audience || []), value]);
  };

  const removeAudienceTag = (tag) => {
    saveAudienceTags((campaign.audience || []).filter((item) => item !== tag));
  };

  const saveSchedule = async () => {
    try {
      setScheduleSaving(true);
      setScheduleNotice("");
      setCampaign(
        normalizeBrandAssets(
          await updateCampaignSchedule(id, campaign.startDate),
        ),
      );
      const refreshed = await fetchCampaignEmailTemplate(id, templateAudience);
      setEmailTemplate(refreshed.template);
      setScheduleNotice(
        "Event date saved. Every campaign template now uses the updated date.",
      );
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the event date.");
    } finally {
      setScheduleSaving(false);
    }
  };

  const updateTemplateField = (field, value) => {
    setEmailTemplate((current) => ({ ...current, [field]: value }));
    setTemplateDirty(true);
    setTemplateNotice("");
  };
  const openAudienceDetails = () => {
    const node = audienceDetailsRef.current;
    if (!node) return;
    node.open = true;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const selectedAudienceLabel = () =>
    templateAudience === "general"
      ? "All campaign contacts"
      : RESEARCH_EMAIL_AUDIENCES.find((item) => item.key === templateAudience)?.label ||
        campaign.audience?.[Number(templateAudience.replace("audience-", ""))] ||
        "Selected audience";

  const generateIdeas = async () => {
    if (templateDirty && !window.confirm("Replace the current unsaved canvas with a new AI draft?")) return;
    try {
      setIdeaGenerating(true);
      setError("");
      const generated = await generateCampaignEmailIdeas(id, {
        audienceLabel: selectedAudienceLabel(),
        prompt: ideaPrompt,
      });
      setEmailTemplate((current) => ({ ...current, ...generated, status: "draft" }));
      setTemplateDirty(true);
      setTemplateNotice("OpenAI created an editable draft. Review it, then save or approve it when ready.");
      setEditorInstanceKey((current) => current + 1);
    } catch (err) {
      setError(err.response?.data?.error || "OpenAI could not generate ideas right now.");
    } finally {
      setIdeaGenerating(false);
    }
  };
  const loadHistoricalTemplate = (version) => {
    setEmailTemplate({
      subject: version.subject || "",
      body: version.body || "",
      designJson: version.designJson || null,
      callToAction: version.callToAction || "",
      callToActionUrl: version.callToActionUrl || "",
      additionalButtons: version.additionalButtons || [],
      topic: version.topic || emailTemplate?.topic || "event_invitations",
      status: "draft",
      currentVersion: emailTemplate?.currentVersion || 0,
    });
    setTemplateHistoryOpen(false);
    setEmailPreview(null);
    setTemplateDirty(true);
    setEditorInstanceKey((current) => current + 1);
  };
  // The live editor debounces its own auto-sync into `emailTemplate` (see
  // UnlayerEmailEditor's onDesignUpdated), so state is usually fresh — but
  // "usually" isn't good enough right before a save. Force an immediate
  // export first so a save/approve click right after typing never captures
  // a stale body from before the debounce fired.
  const exportCurrentTemplate = async () => {
    const { html, design } = await messageRef.current.exportHtml();
    const next = { ...emailTemplate, body: html, designJson: design };
    setEmailTemplate(next);
    return next;
  };

  // Manual fallback for the preview panel's "Refresh" button — the
  // automatic live-sync (UnlayerEmailEditor's onDesignUpdated -> this
  // effect's 450ms debounce) should keep the preview current on its own,
  // but this gives a reliable, immediate way to force it regardless.
  const refreshPreviewNow = async () => {
    try {
      await exportCurrentTemplate();
      await previewTemplate();
    } catch (err) {
      setPreviewError(err.message || "Unable to refresh the preview.");
    }
  };

  const saveTemplate = async () => {
    try {
      setTemplateSaving(true);
      setError("");
      const current = await exportCurrentTemplate();
      const audienceLabel =
        templateAudience === "general"
          ? "All Deal to Close contacts"
          : RESEARCH_EMAIL_AUDIENCES.find(
              (item) => item.key === templateAudience,
            )?.label ||
            campaign.audience?.[
              Number(templateAudience.replace("audience-", ""))
            ] ||
            "";
      setEmailTemplate(
        await saveCampaignEmailTemplate(id, {
          ...current,
          audienceKey: templateAudience,
          audienceLabel,
        }),
      );
      setTemplateDirty(false);
      setTemplateNotice("Draft saved.");
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to save the campaign email.",
      );
    } finally {
      setTemplateSaving(false);
    }
  };
  const approveTemplate = async () => {
    try {
      setTemplateSaving(true);
      setError("");
      const current = await exportCurrentTemplate();
      const audienceLabel =
        templateAudience === "general"
          ? "All Deal to Close contacts"
          : RESEARCH_EMAIL_AUDIENCES.find(
              (item) => item.key === templateAudience,
            )?.label ||
            campaign.audience?.[
              Number(templateAudience.replace("audience-", ""))
            ] ||
            "";
      await saveCampaignEmailTemplate(id, {
        ...current,
        audienceKey: templateAudience,
        audienceLabel,
      });
      const result = await approveCampaignEmailTemplate(id, templateAudience);
      setEmailTemplate(result.template);
      setTemplateDirty(false);
      setTemplateNotice("Template approved.");
      setTemplateVersions((current) => [result.version, ...current]);
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to approve the campaign email.",
      );
    } finally {
      setTemplateSaving(false);
    }
  };
  const previewTemplate = async ({ silent = false } = {}) => {
    try {
      if (!silent) setTemplateSaving(true);
      setPreviewLoading(true);
      setPreviewError("");
      setEmailPreview(
        await previewCampaignEmailTemplate(id, {
          ...emailTemplate,
          logoUrl: campaign.brand?.logoUrl || "",
          flyerUrl: campaign.brand?.flyerUrl || "",
          accentColor: campaign.brand?.accentColor || "#173f36",
        }),
      );
    } catch (err) {
      setPreviewError(
        err.response?.data?.error || "The live preview could not be refreshed.",
      );
    } finally {
      if (!silent) setTemplateSaving(false);
      setPreviewLoading(false);
    }
  };
  useEffect(() => {
    if (!id || !emailTemplate || !campaign) return undefined;
    const timer = window.setTimeout(
      () => previewTemplate({ silent: true }),
      450,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, emailTemplate, campaign?.brand]);
  if (loading)
    return (
      <div className="page-dashboard">
        <p>Loading campaign…</p>
      </div>
    );
  if (error || !campaign)
    return (
      <div className="page-dashboard">
        <p className="form-error">{error || "Campaign not found."}</p>
        <Button variant="outline" onClick={() => navigate("/campaigns")}>
          Back to Campaigns
        </Button>
      </div>
    );

  const isProgram = campaign.campaignKind === "program";
  const metrics = campaign.metrics || {};
  const overview = isProgram
    ? [
        ["Offer", campaign.programName || "Premium program"],
        [
          "Target audience segments",
          campaign.audience?.length || 0,
          "The groups you chose to target when this campaign was created — see and edit them on the Target audience step.",
        ],
        ["Campaign type", "Program enrollment"],
      ]
    : [
        ["Event date", formatDate(campaign.startDate)],
        ["Ticket price", formatMoney(campaign.ticketPrice)],
        ["Registration goal", campaign.ticketGoal || "Not specified"],
        [
          "Target audience segments",
          campaign.audience?.length || 0,
          "The groups you chose to target when this campaign was created — see and edit them on the Target audience step.",
        ],
      ];
  const registrationLinks = [
    ["Eventbrite", campaign.registrationLinks?.eventbrite],
    ["Meetup", campaign.registrationLinks?.meetup],
  ].filter(([, link]) => link?.enabled && link?.url);
  const eventId = String(campaign.eventId?._id || campaign.eventId || "");
  const matchedContacts = audienceMatch?.contacts || [];
  const matchPageSize = 5;
  const matchPageCount = Math.max(
    1,
    Math.ceil(matchedContacts.length / matchPageSize),
  );
  const visibleMatches = matchedContacts.slice(
    (matchPage - 1) * matchPageSize,
    matchPage * matchPageSize,
  );

  return (
    <div className="page-dashboard campaign-workspace">
      <header className="campaign-workspace__header">
        <div>
          <button
            className="campaign-workspace__back"
            onClick={() => navigate("/campaigns")}
          >
            ← All campaigns
          </button>
          <p className="campaign-workspace__eyebrow">
            {isProgram ? "Program campaign" : "Event campaign"}
          </p>
          <h1 className="page-title">{campaign.name}</h1>
          <div className="campaign-workspace__meta">
            <span
              className={`campaign-status campaign-status--${campaign.status}`}
            >
              {campaign.status}
            </span>
            <span>
              {isProgram
                ? "Evergreen campaign"
                : formatDate(campaign.startDate)}
            </span>
          </div>
        </div>
        <div className="campaign-workspace__actions">
          <Button variant="outline" onClick={() => navigate("/contacts")}>
            Manage contacts
          </Button>
          <Button
            onClick={() => navigate(`/outreach?campaignId=${campaign._id}`)}
          >
            Open outreach
          </Button>
        </div>
      </header>

      <section
        className="campaign-workspace__metrics"
        aria-label="Campaign metrics"
      >
        {[
          ["Sent", metrics.sent],
          ["Delivered", metrics.delivered],
          ["Opened", metrics.opened],
          ["Converted", metrics.converted],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value || 0}</strong>
          </div>
        ))}
      </section>

      <section className="campaign-workspace__grid">
        <details className="campaign-collapsible">
          <summary>
            <span>Campaign setup</span>
            <small>Event date, description, and registration channels</small>
          </summary>
          <DashboardCard title="Campaign details">
            <div className="campaign-overview-list">
              {overview.map(([label, value, hint]) =>
                hint ? (
                  <button
                    type="button"
                    key={label}
                    className="campaign-overview-list__linked"
                    onClick={openAudienceDetails}
                  >
                    <span>{label}</span>
                    <strong>{value}</strong>
                    <small>{hint}</small>
                  </button>
                ) : (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ),
              )}
            </div>
            {campaign.description ? (
              <p className="campaign-workspace__description">
                {campaign.description}
              </p>
            ) : null}
            {!isProgram ? (
              <section className="campaign-date-card">
                <div>
                  <span>Event date</span>
                  <strong>{formatDate(campaign.startDate)}</strong>
                </div>
                <input
                  aria-label="Event date"
                  type="date"
                  value={dateInputValue(campaign.startDate)}
                  onChange={(event) =>
                    setCampaign((current) => ({
                      ...current,
                      startDate: `${event.target.value}T12:00:00.000Z`,
                    }))
                  }
                />
                <Button
                  variant="outline"
                  loading={scheduleSaving}
                  onClick={saveSchedule}
                >
                  Save date
                </Button>
                {scheduleNotice ? <p role="status">{scheduleNotice}</p> : null}
              </section>
            ) : null}
          </DashboardCard>
          {!isProgram && (
            <DashboardCard title="Registration channels">
              {registrationLinks.length ? (
                <div className="campaign-registration-links">
                  {registrationLinks.map(([provider, link], index) => (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      key={provider}
                    >
                      <span>
                        {index === 0
                          ? "Primary registration"
                          : "Additional listing"}
                      </span>
                      <strong>{provider}</strong>
                      <small>
                        {index === 0
                          ? "Ticket checkout and main email button"
                          : "Meetup discovery and RSVPs"}{" "}
                        ↗
                      </small>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="campaign-workspace__empty">
                  No registration channels connected yet.
                </p>
              )}
            </DashboardCard>
          )}
        </details>

        <details className="campaign-collapsible" ref={audienceDetailsRef}>
          <summary>
            <span>Target audience</span>
            <small>
              {campaign.audience?.length
                ? `${campaign.audience.length} group${campaign.audience.length === 1 ? "" : "s"} configured`
                : "No target groups yet"}
            </small>
          </summary>
          <DashboardCard title="Target audience">
            {audienceMatch ? (
              <>
                <p className="campaign-audience-intro">
                  Lead Porch matches your contacts against the groups below —
                  add or remove groups any time, then use{" "}
                  <strong>Refresh and assign safe matches</strong> to re-run
                  matching.
                </p>
                <div className="campaign-audience-groups campaign-audience-groups--editable">
                  {(campaign.audience || []).map((audience) => (
                    <span key={audience}>
                      {audience}
                      <button
                        type="button"
                        aria-label={`Remove ${audience}`}
                        disabled={audienceTagsSaving}
                        onClick={() => removeAudienceTag(audience)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {!(campaign.audience || []).length ? (
                    <em>No target groups yet — add at least one below.</em>
                  ) : null}
                </div>
                <div className="campaign-audience-add">
                  <input
                    value={newAudienceTag}
                    onChange={(event) => setNewAudienceTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addAudienceTag();
                      }
                    }}
                    placeholder="e.g. Real estate investors"
                    disabled={audienceTagsSaving}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    loading={audienceTagsSaving}
                    disabled={!newAudienceTag.trim()}
                    onClick={addAudienceTag}
                  >
                    Add group
                  </Button>
                </div>
                {eventId ? (
                  <p className="campaign-template-help">
                    This event may also have its own targeting notes in
                    Eventbrite strategy.{" "}
                    <button
                      type="button"
                      className="campaign-inline-link"
                      onClick={() =>
                        navigate(`/events?eventId=${eventId}&tab=strategy`)
                      }
                    >
                      Open event targeting brief
                    </button>
                  </p>
                ) : null}
                {campaign.eventId?.audienceSuggestions?.length ? (
                  <details className="campaign-audience-suggestions">
                    <summary>
                      Suggestions found in the Eventbrite listing
                    </summary>
                    <p>
                      These are suggestions only. They do not become active
                      unless you add them above.
                    </p>
                    <div>
                      {campaign.eventId.audienceSuggestions.map((audience) => (
                        <button
                          type="button"
                          key={audience}
                          disabled={audienceTagsSaving || (campaign.audience || []).includes(audience)}
                          onClick={() => saveAudienceTags([...(campaign.audience || []), audience])}
                        >
                          + {audience}
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
                <details className="campaign-audience-how">
                  <summary>How Lead Porch matches your audience</summary>
                  <ol>
                    <li>You decide the official target groups above.</li>
                    <li>
                      Contacts come from Lead Porch research, CRM records, CSV
                      uploads, manual entry, and approved integrations.
                    </li>
                    <li>
                      Lead Porch compares your groups against each contact's
                      title, industry, tags, keywords, companies, lists, and
                      notes. Nothing is emailed automatically — you always
                      review and send from Outreach.
                    </li>
                  </ol>
                </details>

                <h3 className="campaign-audience-stats-heading">
                  This campaign's matches
                </h3>
                <div className="campaign-audience-counts">
                  <div className="campaign-stat-tile">
                    <strong>{audienceMatch.matched || 0}</strong>
                    <span>Safe matches</span>
                    <small>
                      Fit your target groups, have a verified email, and are
                      approved to receive campaign email.
                    </small>
                  </div>
                  <div className="campaign-stat-tile">
                    <strong>{audienceMatch.alreadyAssigned || 0}</strong>
                    <span>Already assigned</span>
                    <small>
                      Of those safe matches, already linked to this campaign
                      from an earlier match run.
                    </small>
                  </div>
                  <div className="campaign-stat-tile">
                    <strong>{audienceMatch.routedToMain || 0}</strong>
                    <span>Using the main template</span>
                    <small>
                      Matched, but no specific group's template fit better —
                      they'll get your default template.
                    </small>
                  </div>
                  <div className="campaign-stat-tile">
                    <strong>{audienceMatch.ambiguousRouting || 0}</strong>
                    <span>Need routing review</span>
                    <small>
                      Fit two templates equally well — review the table below
                      and choose one manually.
                    </small>
                  </div>
                </div>

                <h3 className="campaign-audience-stats-heading">
                  Across your whole CRM
                </h3>
                <div className="campaign-audience-counts">
                  <button
                    type="button"
                    className="campaign-stat-tile campaign-stat-tile--link"
                    onClick={() =>
                      navigate(
                        "/contacts?allCampaigns=true&researchStatus=needs_research",
                      )
                    }
                  >
                    <strong>{audienceMatch.needsResearch || 0}</strong>
                    <span>Need research</span>
                    <small>
                      Not scoped to this campaign — every contact in your CRM
                      without enough info yet to confirm a fit. Click to
                      review them.
                    </small>
                  </button>
                  <button
                    type="button"
                    className="campaign-stat-tile campaign-stat-tile--link"
                    onClick={() =>
                      navigate(
                        "/contacts?allCampaigns=true&researchStatus=ready_for_review",
                      )
                    }
                  >
                    <strong>{audienceMatch.readyForReview || 0}</strong>
                    <span>Ready for review</span>
                    <small>
                      Not scoped to this campaign — research finished and
                      waiting on a human to confirm the profile. Click to
                      review them.
                    </small>
                  </button>
                </div>
                {matchedContacts.length ? (
                  <>
                    <div className="campaign-match-table">
                      <div className="campaign-match-table__head">
                        <span>Contact</span>
                        <span>Why they match</span>
                      </div>
                      {visibleMatches.map((contact) => (
                        <div
                          className="campaign-match-table__row"
                          key={contact._id}
                        >
                          <p>
                            <strong>{contact.name}</strong>
                            <span>{contact.company || contact.email}</span>
                          </p>
                          <small>
                            {contact.reasons
                              .flatMap((reason) => reason.terms)
                              .join(", ") || "Qualified audience profile"}
                            <b className={contact.routing?.ambiguous ? "is-warning" : ""}>
                              {contact.routing?.templateLabel || "Main template"}
                              {contact.routing?.mode === "fallback" ? " · fallback" : ""}
                              {contact.routing?.ambiguous ? ` · review overlap${contact.routing.alternatives?.length ? ` with ${contact.routing.alternatives.join(", ")}` : ""}` : ""}
                            </b>
                          </small>
                        </div>
                      ))}
                    </div>
                    <div className="campaign-match-pagination">
                      <span>
                        Showing {(matchPage - 1) * matchPageSize + 1}–
                        {Math.min(
                          matchPage * matchPageSize,
                          matchedContacts.length,
                        )}{" "}
                        of {matchedContacts.length}
                      </span>
                      <div>
                        <button
                          disabled={matchPage === 1}
                          onClick={() => setMatchPage((page) => page - 1)}
                        >
                          Previous
                        </button>
                        <button
                          disabled={matchPage === matchPageCount}
                          onClick={() => setMatchPage((page) => page + 1)}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="campaign-workspace__empty">
                    No safe matches yet. Add audience information to contacts,
                    then qualify them for outreach.
                  </p>
                )}
                <div className="campaign-audience-actions">
                  <Button
                    variant="outline"
                    onClick={() => navigate("/contacts")}
                  >
                    Review contacts
                  </Button>
                  <Button loading={matchingAudience} onClick={refreshAudience}>
                    Refresh and assign safe matches
                  </Button>
                  <Button
                    loading={approvingRouting}
                    disabled={Boolean(audienceMatch.ambiguousRouting) || Boolean(audienceMatch.routingApproval?.approvedAt)}
                    onClick={approveRouting}
                  >
                    {audienceMatch.routingApproval?.approvedAt ? "Routing approved" : "Approve recipient routing"}
                  </Button>
                </div>
              </>
            ) : (
              <p>Checking qualified contacts…</p>
            )}
          </DashboardCard>
        </details>

        <DashboardCard title="Email campaign studio" className="campaign-email-studio">
          {emailTemplate ? (
            <div className="campaign-template-editor">
              <div className="campaign-email-meta">
                <div className="campaign-template-editor__status">
                  <span
                    className={`campaign-status-dot ${!templateDirty && emailTemplate.status === "approved" ? "is-approved" : ""}`}
                  />{" "}
                  <strong>
                    {templateDirty
                      ? "Unsaved changes"
                      : emailTemplate.status === "approved"
                        ? `Approved · version ${emailTemplate.currentVersion}`
                        : "Draft saved"}
                  </strong>
                  {templateNotice ? (
                    <small role="status">{templateNotice}</small>
                  ) : null}
                </div>
                <div
                  className="campaign-routing-explainer"
                  aria-label="You do not assign contacts here. Lead Porch routes each contact automatically."
                >
                  <strong>Automatic recipient routing</strong>
                  <span>
                    Start with one main email. Audience versions are optional;
                    Lead Porch previews every routing decision before drafts are created.
                  </span>
                </div>
                <div className="campaign-email-meta__row">
                  <label aria-description="Individual overrides are optional.">
                    <span>Template you are editing</span>
                    <select
                      value={templateAudience}
                      onChange={(event) =>
                        setTemplateAudience(event.target.value)
                      }
                    >
                      <option value="general">
                        Main email · required fallback
                      </option>
                      <optgroup label="Optional research variations">
                        {RESEARCH_EMAIL_AUDIENCES.map((audience) => (
                          <option value={audience.key} key={audience.key}>
                            {audience.label}
                          </option>
                        ))}
                      </optgroup>
                      {(campaign.audience || []).length ? (
                        <optgroup label="Optional campaign variations">
                          {campaign.audience.map((audience, index) => (
                            <option
                              value={`audience-${index}`}
                              key={`${audience}-${index}`}
                            >
                              {audience}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </label>
                  <label>
                    <span>Subject</span>
                    <input
                      value={emailTemplate.subject}
                      onChange={(event) =>
                        updateTemplateField("subject", event.target.value)
                      }
                    />
                  </label>
                </div>
                <details className="campaign-email-logo">
                  <summary>
                    <img
                      src={campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl}
                      alt="Email logo"
                      onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                    />
                    <span>Email logo</span>
                    <small>
                      {campaign.brand?.emailLogoUrl ? "Custom" : "Default"}
                    </small>
                  </summary>
                  <div className="campaign-email-logo__panel">
                    <p>
                      {campaign.brand?.emailLogoUrl
                        ? "Using a logo chosen for this campaign."
                        : "Using your Knowledge Center default logo."}{" "}
                      This is only a reference image — nothing is added to
                      your email automatically. Drag the logo into the
                      editor yourself if you want it in the message, and
                      place it wherever you like.
                    </p>
                    <div className="campaign-email-logo__actions">
                      <label className="campaign-email-logo__upload">
                        {logoSaving ? "Saving…" : "Choose a different logo"}
                        <input
                          type="file"
                          accept="image/*"
                          disabled={logoSaving}
                          onChange={(event) => {
                            chooseEmailLogo(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                      </label>
                      {campaign.brand?.emailLogoUrl ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={logoSaving}
                          onClick={resetEmailLogoToDefault}
                        >
                          Reset to default
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </details>
              </div>
              <div className="campaign-email-workspace">
                <div className="campaign-email-workspace__editor">
                  <UnlayerEmailEditor
                    key={editorInstanceKey}
                    ref={messageRef}
                    design={emailTemplate.designJson}
                    onDesignChange={handleDesignChange}
                    onUploadImage={uploadInlineImage}
                  />
                  <small>
                    Drag in blocks, images, and buttons; every element has
                    its own size, alignment, and font controls when
                    selected. Use the {"{ }"} icon in the text tool to
                    insert personalization like the recipient's first
                    name — and to wire a button to the real registration
                    link, use {"{{eventLink}}"} as its URL.
                  </small>
                </div>
                <div className="campaign-email-workspace__preview">
                  <header>
                    <div>
                      <span>Live preview</span>
                      <strong>
                        {emailPreview?.subject || "Preparing preview…"}
                      </strong>
                    </div>
                    <small className={`campaign-preview-status ${previewLoading ? "is-loading" : ""}`}>
                      <i aria-hidden="true" />
                      {previewLoading ? "Updating" : "Updated"}
                    </small>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={previewLoading}
                      onClick={refreshPreviewNow}
                    >
                      Refresh
                    </Button>
                  </header>
                  {previewError ? (
                    <p className="form-error">{previewError}</p>
                  ) : null}
                  {emailPreview ? (
                    <iframe
                      title="Live campaign email preview"
                      srcDoc={emailPreview.html}
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                    />
                  ) : (
                    <div className="campaign-preview-placeholder">
                      Building your email preview…
                    </div>
                  )}
                </div>
              </div>
              <div className="campaign-idea-generator">
                <label>
                  <span>Tell AI what to focus on (optional)</span>
                  <input
                    value={ideaPrompt}
                    onChange={(event) => setIdeaPrompt(event.target.value)}
                    placeholder="e.g. Make it urgent about the early-bird deadline, keep it casual"
                  />
                </label>
                <Button
                  variant="outline"
                  loading={ideaGenerating}
                  onClick={generateIdeas}
                >
                  Generate ideas with AI
                </Button>
              </div>
              <div className="campaign-template-editor__actions">
                <Button
                  variant="outline"
                  loading={templateSaving}
                  onClick={saveTemplate}
                >
                  Save draft
                </Button>
                <Button loading={templateSaving} onClick={approveTemplate}>
                  Approve new version
                </Button>
              </div>
              {templateVersions.length ? (
                <section className="campaign-template-history">
                  <button
                    type="button"
                    className="campaign-template-history__toggle"
                    onClick={() => setTemplateHistoryOpen((open) => !open)}
                  >
                    <span>
                      <strong>Template history</strong>
                      <small>
                        {templateVersions.length} saved version
                        {templateVersions.length === 1 ? "" : "s"} · sent
                        copies are preserved
                      </small>
                    </span>
                    <b>{templateHistoryOpen ? "Hide" : "View all"}</b>
                  </button>
                  {templateHistoryOpen ? (
                    <div className="campaign-template-history__list">
                      {templateVersions.map((version) => (
                        <article key={version.version}>
                          <header>
                            <span>Version {version.version}</span>
                            <small>
                              {version.approvedAt
                                ? new Date(
                                    version.approvedAt,
                                  ).toLocaleString()
                                : "Approval date unavailable"}
                            </small>
                          </header>
                          <strong>{version.subject}</strong>
                          <small>
                            {version.audienceLabel ||
                              "Historical campaign template"}
                            {version.sentCount
                              ? ` · used for ${version.sentCount} sent email${version.sentCount === 1 ? "" : "s"}`
                              : " · never sent"}
                          </small>
                          <footer>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => loadHistoricalTemplate(version)}
                            >
                              Use as new draft
                            </Button>
                            {version.lastSentAt ? (
                              <small>
                                Last sent{" "}
                                {new Date(
                                  version.lastSentAt,
                                ).toLocaleString()}
                              </small>
                            ) : null}
                          </footer>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          ) : (
            <p>Loading the master template…</p>
          )}
        </DashboardCard>
      </section>
    </div>
  );
}
