import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import UnlayerEmailEditor from "../components/UnlayerEmailEditor.jsx";
import {
  approveCampaignEmailTemplate,
  assignCampaignAudience,
  fetchCampaign,
  fetchCampaignEmailTemplate,
  fetchContacts,
  fetchImageUploadStatus,
  previewCampaignAudience,
  previewCampaignEmailTemplate,
  saveCampaignEmailTemplate,
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
  const [matchPage, setMatchPage] = useState(1);
  const [brandSaving, setBrandSaving] = useState(false);
  const [brandNotice, setBrandNotice] = useState("");
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [imageUpload, setImageUpload] = useState({
    configured: false,
    loaded: false,
  });
  const [emailTemplate, setEmailTemplate] = useState(null);
  const [templateVersions, setTemplateVersions] = useState([]);
  const [templateHistoryOpen, setTemplateHistoryOpen] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateDirty, setTemplateDirty] = useState(false);
  const [templateNotice, setTemplateNotice] = useState("");
  const [emailPreview, setEmailPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewContacts, setPreviewContacts] = useState([]);
  const [previewContactId, setPreviewContactId] = useState("");
  const [templateAudience, setTemplateAudience] = useState("general");
  const [activeSection, setActiveSection] = useState("email");
  const messageRef = useRef(null);

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
    fetchContacts({ campaignId: id, limit: 500 })
      .then((response) => {
        const contacts = response.data || [];
        setPreviewContacts(contacts);
        setPreviewContactId(
          (current) => current || String(contacts[0]?._id || ""),
        );
      })
      .catch(() => setPreviewContacts([]));
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
    fetchImageUploadStatus()
      .then((status) => setImageUpload({ ...status, loaded: true }))
      .catch(() => setImageUpload({ configured: false, loaded: true }));
  }, [id]);

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

  const updateBrandField = (field, value) =>
    setCampaign((current) => ({
      ...current,
      brand: { ...current.brand, [field]: value },
    }));

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

  const saveBrand = async () => {
    try {
      setBrandSaving(true);
      setBrandNotice("");
      setCampaign(
        normalizeBrandAssets(
          await updateCampaignBrand(id, campaign.brand || {}),
        ),
      );
      setBrandNotice(`${isProgram ? "Program" : "Event"} brand saved.`);
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to save the program brand.",
      );
    } finally {
      setBrandSaving(false);
    }
  };
  const saveSchedule = async () => {
    try {
      setScheduleSaving(true);
      setBrandNotice("");
      setCampaign(
        normalizeBrandAssets(
          await updateCampaignSchedule(id, campaign.startDate),
        ),
      );
      const refreshed = await fetchCampaignEmailTemplate(id, templateAudience);
      setEmailTemplate(refreshed.template);
      setBrandNotice(
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
  const updateAdditionalButton = (index, field, value) => {
    setEmailTemplate((current) => ({
      ...current,
      additionalButtons: (current.additionalButtons || []).map(
        (button, buttonIndex) =>
          buttonIndex === index ? { ...button, [field]: value } : button,
      ),
    }));
    setTemplateDirty(true);
    setTemplateNotice("");
  };
  const addEmailButton = () => {
    setEmailTemplate((current) => ({
      ...current,
      additionalButtons: [
        ...(current.additionalButtons || []),
        { label: "", url: "" },
      ],
    }));
    setTemplateDirty(true);
  };
  const removeEmailButton = (index) => {
    setEmailTemplate((current) => ({
      ...current,
      additionalButtons: (current.additionalButtons || []).filter(
        (_, buttonIndex) => buttonIndex !== index,
      ),
    }));
    setTemplateDirty(true);
  };
  const loadHistoricalTemplate = (version) => {
    setEmailTemplate({
      subject: version.subject || "",
      body: version.body || "",
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
          previewContactId,
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
  }, [id, emailTemplate, previewContactId, campaign?.brand]);
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
        ["Target groups", campaign.audience?.length || 0],
        ["Campaign type", "Program enrollment"],
      ]
    : [
        ["Event date", formatDate(campaign.startDate)],
        ["Ticket price", formatMoney(campaign.ticketPrice)],
        ["Registration goal", campaign.ticketGoal || "Not specified"],
        ["Target groups", campaign.audience?.length || 0],
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

      <nav
        className="campaign-workspace__tabs"
        aria-label="Campaign workspace sections"
      >
        <button
          className={activeSection === "email" ? "active" : ""}
          onClick={() => setActiveSection("email")}
        >
          Email design
        </button>
        <button
          className={activeSection === "audience" ? "active" : ""}
          onClick={() => setActiveSection("audience")}
        >
          Target audience
        </button>
        <button
          className={activeSection === "overview" ? "active" : ""}
          onClick={() => setActiveSection("overview")}
        >
          Campaign setup
        </button>
      </nav>

      <section className="campaign-workspace__grid">
        {activeSection === "overview" ? (
          <DashboardCard title="Campaign details">
            <div className="campaign-overview-list">
              {overview.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {campaign.description ? (
              <p className="campaign-workspace__description">
                {campaign.description}
              </p>
            ) : null}
          </DashboardCard>
        ) : null}

        {activeSection === "email" ? (
          <DashboardCard title="Email campaign studio">
            {emailTemplate ? (
              <div className="campaign-template-editor">
                <div className="campaign-email-controls">
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
                      Lead Porch chooses the approved template for each
                      contact.
                    </span>
                  </div>
                  <label aria-description="Individual overrides are optional.">
                    <span>Template you are editing</span>
                    <select
                      value={templateAudience}
                      onChange={(event) =>
                        setTemplateAudience(event.target.value)
                      }
                    >
                      <option value="general">
                        Main template · automatic fallback
                      </option>
                      <optgroup label="Research audiences">
                        {RESEARCH_EMAIL_AUDIENCES.map((audience) => (
                          <option value={audience.key} key={audience.key}>
                            {audience.label}
                          </option>
                        ))}
                      </optgroup>
                      {(campaign.audience || []).length ? (
                        <optgroup label="Campaign audiences">
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
                  <label>
                    <span>Message</span>
                    <UnlayerEmailEditor
                      ref={messageRef}
                      design={emailTemplate.designJson}
                      onDesignChange={handleDesignChange}
                      onUploadImage={uploadInlineImage}
                    />
                    <small>
                      Drag in blocks, images, and buttons; every element has
                      its own size, alignment, and font controls when
                      selected. Use the {"{ }"} icon in the text tool to
                      insert personalization like the recipient's first name.
                    </small>
                  </label>
                  <details className="campaign-email-buttons">
                    <summary>
                      <span>Links shown as buttons</span>
                      <small>{1 + (emailTemplate.additionalButtons || []).length} configured</small>
                    </summary>
                    <div className="campaign-email-buttons__content">
                      <p>Add the links readers can choose beneath the message.</p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          (emailTemplate.additionalButtons || []).length >= 4
                        }
                        onClick={addEmailButton}
                      >
                        + Add another link
                      </Button>
                    <div className="campaign-email-button-grid">
                      <article>
                        <strong>Registration link</strong>
                        <label>
                          <span>What it says</span>
                          <input
                            value={emailTemplate.callToAction || ""}
                            onChange={(event) =>
                              updateTemplateField(
                                "callToAction",
                                event.target.value,
                              )
                            }
                            placeholder="Register now"
                          />
                        </label>
                        <label>
                          <span>Where it goes</span>
                          <input
                            type="url"
                            value={emailTemplate.callToActionUrl || ""}
                            onChange={(event) =>
                              updateTemplateField(
                                "callToActionUrl",
                                event.target.value,
                              )
                            }
                            placeholder="https://"
                          />
                        </label>
                      </article>
                      {(emailTemplate.additionalButtons || []).map(
                        (button, index) => (
                          <article key={index}>
                            <header>
                              <strong>Additional link</strong>
                              <button
                                type="button"
                                onClick={() => removeEmailButton(index)}
                              >
                                Remove
                              </button>
                            </header>
                            <label>
                              <span>What it says</span>
                              <input
                                value={button.label || ""}
                                onChange={(event) =>
                                  updateAdditionalButton(
                                    index,
                                    "label",
                                    event.target.value,
                                  )
                                }
                                placeholder="View on Meetup"
                              />
                            </label>
                            <label>
                              <span>Where it goes</span>
                              <input
                                type="url"
                                value={button.url || ""}
                                onChange={(event) =>
                                  updateAdditionalButton(
                                    index,
                                    "url",
                                    event.target.value,
                                  )
                                }
                                placeholder="https://"
                              />
                            </label>
                          </article>
                        ),
                      )}
                    </div>
                    </div>
                  </details>
                  <label>
                    <span>Preview recipient</span>
                    <select
                      value={previewContactId}
                      onChange={(event) =>
                        setPreviewContactId(event.target.value)
                      }
                    >
                      <option value="">Example contact</option>
                      {previewContacts.map((contact) => (
                        <option key={contact._id} value={contact._id}>
                          {contact.name ||
                            [contact.firstName, contact.lastName]
                              .filter(Boolean)
                              .join(" ") ||
                            "Unnamed contact"}
                          {contact.company ? ` · ${contact.company}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
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
                </div>
                <aside className="campaign-live-preview">
                  <header>
                    <div>
                      <span>Live preview</span>
                      <strong>
                        {emailPreview?.subject || "Preparing preview…"}
                      </strong>
                    </div>
                    <small className={`campaign-preview-status ${previewLoading ? "is-loading" : ""}`}>
                      <i aria-hidden="true" />
                      {previewLoading ? "Updating preview" : "Preview updated"}
                    </small>
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
                </aside>
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
                            <pre>{version.body}</pre>
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
        ) : null}

        {activeSection === "email" ? (
          <DashboardCard title={isProgram ? "Program brand" : "Event brand"}>
            <div className="program-brand-editor">
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
                </section>
              ) : null}
              <p className="campaign-template-help">
                Add your flyer or logo directly in the Message editor above
                (Insert image) — that's the one place to place and size any
                image in this email now.
              </p>
              <div className="campaign-brand-fields">
                <label>
                  <span>Website</span>
                  <input
                    type="url"
                    value={campaign.brand?.websiteUrl || ""}
                    placeholder="https://"
                    onChange={(event) =>
                      updateBrandField("websiteUrl", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Accent color</span>
                  <input
                    type="color"
                    value={campaign.brand?.accentColor || "#173f36"}
                    onChange={(event) =>
                      updateBrandField("accentColor", event.target.value)
                    }
                  />
                </label>
              </div>
              {!imageUpload.configured ? (
                <p className="image-hosting-note">
                  Image upload is not configured for this workspace.
                </p>
              ) : null}
              <div className="campaign-brand-save">
                <Button loading={brandSaving} onClick={saveBrand}>
                  Save {isProgram ? "program" : "event"} brand
                </Button>
                {brandNotice ? <p role="status">{brandNotice}</p> : null}
              </div>
            </div>
          </DashboardCard>
        ) : null}

        {activeSection === "overview" && !isProgram && (
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

        {activeSection === "audience" ? (
          <DashboardCard title="Confirmed target audience">
            {audienceMatch ? (
              <>
                <div className="campaign-audience-source">
                  <div>
                    <strong>Source of truth</strong>
                    <p>
                      The confirmed target audience below is the audience Growth
                      Operator uses for matching, templates, and future
                      searches.
                    </p>
                  </div>
                  {eventId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate(`/events?eventId=${eventId}&tab=strategy`)
                      }
                    >
                      Edit target audience
                    </Button>
                  ) : null}
                </div>
                <div className="campaign-audience-groups">
                  {(campaign.audience || []).map((audience) => (
                    <span key={audience}>{audience}</span>
                  ))}
                </div>
                {campaign.eventId?.audienceSuggestions?.length ? (
                  <details className="campaign-audience-suggestions">
                    <summary>
                      Suggestions found in the Eventbrite listing
                    </summary>
                    <p>
                      These are suggestions only. They do not become active
                      unless you select and save them in Event strategy.
                    </p>
                    <div>
                      {campaign.eventId.audienceSuggestions.map((audience) => (
                        <span key={audience}>{audience}</span>
                      ))}
                    </div>
                  </details>
                ) : null}
                <div className="audience-flow">
                  <div>
                    <span>1</span>
                    <p>
                      <strong>Confirm the targeting brief</strong>Growth
                      Operator can suggest segments from the event, but you
                      decide the official audience for this campaign.
                    </p>
                  </div>
                  <div>
                    <span>2</span>
                    <p>
                      <strong>Use real contact sources</strong>Contacts come
                      from Lead Porch research, CRM records, CSV uploads,
                      manual entry, and future approved integrations.
                    </p>
                  </div>
                  <div>
                    <span>3</span>
                    <p>
                      <strong>Match safely</strong>Lead Porch compares the
                      brief with titles, industries, tags, keywords, companies,
                      lists, and notes. Nothing is emailed automatically.
                    </p>
                  </div>
                </div>
                {eventId ? (
                  <div className="audience-strategy-action">
                    <p>
                      <strong>Targeting brief</strong>
                      <span>
                        {campaign.audience?.join(", ") || "Not approved yet"}
                      </span>
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate(`/events?eventId=${eventId}&tab=strategy`)
                      }
                    >
                      Review targeting brief
                    </Button>
                  </div>
                ) : null}
                <div className="campaign-audience-counts">
                  <div>
                    <strong>{audienceMatch.matched || 0}</strong>
                    <span>safe matches</span>
                  </div>
                  <div>
                    <strong>{audienceMatch.alreadyAssigned || 0}</strong>
                    <span>already assigned</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        "/contacts?allCampaigns=true&researchStatus=needs_research",
                      )
                    }
                  >
                    <strong>{audienceMatch.needsResearch || 0}</strong>
                    <span>need research</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        "/contacts?allCampaigns=true&researchStatus=ready_for_review",
                      )
                    }
                  >
                    <strong>{audienceMatch.readyForReview || 0}</strong>
                    <span>ready for review</span>
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
                </div>
              </>
            ) : (
              <p>Checking qualified contacts…</p>
            )}
          </DashboardCard>
        ) : null}
      </section>
    </div>
  );
}
