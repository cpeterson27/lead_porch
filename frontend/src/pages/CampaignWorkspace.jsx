import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import UnlayerEmailEditor from "../components/UnlayerEmailEditor.jsx";
import {
  approveCampaignEmailTemplate,
  fetchCampaign,
  fetchCampaignEmailTemplate,
  previewCampaignAudience,
  fetchWorkspaceConfig,
  generateCampaignEmailIdeas,
  generateCampaignAudienceTemplates,
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
const PERSONALIZATION_TOKENS = [
  ["First name", "{{firstName}}"],
  ["Company", "{{company}}"],
  ["Campaign name", "{{campaignName}}"],
  ["Event date", "{{eventDate}}"],
  ["Registration link", "{{eventLink}}"],
];

export default function CampaignWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleNotice, setScheduleNotice] = useState("");
  const [emailTemplate, setEmailTemplate] = useState(null);
  const [templateVersions, setTemplateVersions] = useState([]);
  const [templateHistoryOpen, setTemplateHistoryOpen] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [ideaGenerating, setIdeaGenerating] = useState(false);
  const [audienceIdeasGenerating, setAudienceIdeasGenerating] = useState(false);
  const [ideaPrompt, setIdeaPrompt] = useState("");
  const [ideaImages, setIdeaImages] = useState([]);
  const [workspaceDefaultLogoUrl, setWorkspaceDefaultLogoUrl] = useState("");
  const [workspaceDefaultAccentColor, setWorkspaceDefaultAccentColor] = useState("");
  const [logoSaving, setLogoSaving] = useState(false);
  const [audienceTagsSaving, setAudienceTagsSaving] = useState(false);
  const [audienceMatch, setAudienceMatch] = useState(null);
  const [newAudienceTag, setNewAudienceTag] = useState("");
  const [templateDirty, setTemplateDirty] = useState(false);
  const [templateNotice, setTemplateNotice] = useState("");
  const [copiedToken, setCopiedToken] = useState("");
  const [emailPreview, setEmailPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [templateAudience, setTemplateAudience] = useState("general");
  // Unlayer only loads its `design` prop once, on mount — bumping this key
  // forces a clean remount (and re-load) when restoring a historical
  // version, since the editor has no supported "swap design mid-session"
  // event of its own.
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);
  const autosaveRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
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
    previewCampaignAudience(id).then(setAudienceMatch).catch(() => {});
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
    fetchWorkspaceConfig()
      .then((config) => {
        setWorkspaceDefaultLogoUrl(config.organizationLogoUrl || "");
        setWorkspaceDefaultAccentColor(config.branding?.accentColor || "");
      })
      .catch(() => {});
  }, []);

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

  const saveAccentColor = async (accentColor) => {
    setError("");
    try {
      setCampaign(normalizeBrandAssets(await updateCampaignBrand(id, { accentColor })));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the accent color.");
    }
  };

  // Drops the chosen logo in as a normal, editable image block instead of
  // auto-placing it anywhere — once it's in the canvas the user drags it
  // wherever they want (header, footer, centered), resizes or realigns it
  // with Unlayer's own image controls, or deletes the block entirely if
  // they decide against it.
  const insertLogoBlock = async () => {
    const logoUrl = campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl;
    if (!logoUrl) {
      setError("Upload a logo below (or set a default in Knowledge Center) before inserting it.");
      return;
    }
    try {
      const current = await messageRef.current.exportHtml();
      const base = current?.design?.body ? current.design : { body: { rows: [], values: {} } };
      const logoRow = {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: "image",
                values: {
                  containerPadding: "16px",
                  src: { url: logoUrl, width: 160 },
                  textAlign: "center",
                  altText: "Logo",
                },
              },
            ],
            values: {},
          },
        ],
        values: {},
      };
      const nextDesign = {
        ...base,
        body: { ...base.body, rows: [logoRow, ...(base.body.rows || [])] },
      };
      await messageRef.current.loadDesign(nextDesign);
      const exported = await messageRef.current.exportHtml();
      handleDesignChange(exported);
      setTemplateNotice("Logo added — drag it, resize it, or delete it like any other block.");
    } catch (err) {
      setError(err.message || "Unable to insert the logo right now.");
    }
  };

  const insertLogoWithTextBlock = async () => {
    const logoUrl = campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl;
    if (!logoUrl) {
      setError("Upload a logo below (or set a default in Knowledge Center) before inserting it.");
      return;
    }
    try {
      const current = await messageRef.current.exportHtml();
      const base = current?.design?.body ? current.design : { body: { rows: [], values: {} } };
      const sideBySideRow = {
        cells: [1, 2],
        columns: [
          {
            contents: [
              {
                type: "image",
                values: {
                  containerPadding: "12px",
                  src: { url: logoUrl, width: 150 },
                  textAlign: "center",
                  altText: "Logo",
                },
              },
            ],
            values: { padding: "0px" },
          },
          {
            contents: [
              {
                type: "text",
                values: {
                  containerPadding: "12px",
                  text: "<p style=\"font-size:16px;line-height:1.5;margin:0;\"><strong>Your name</strong><br>Your title or message</p>",
                },
              },
            ],
            values: { padding: "0px" },
          },
        ],
        values: { columns: false, doNotStackOnMobile: true },
      };
      const nextDesign = {
        ...base,
        body: { ...base.body, rows: [...(base.body.rows || []), sideBySideRow] },
      };
      await messageRef.current.loadDesign(nextDesign);
      const exported = await messageRef.current.exportHtml();
      handleDesignChange(exported);
      setTemplateNotice("Logo + text added side by side. Click either side to edit its size, spacing, or content.");
    } catch (err) {
      setError(err.message || "Unable to insert the side-by-side layout right now.");
    }
  };

  const insertArrowButton = async () => {
    try {
      const current = await messageRef.current.exportHtml();
      const base = current?.design?.body ? current.design : { body: { rows: [], values: {} } };
      const buttonRow = {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: "button",
                values: {
                  text: "Button text →",
                  textAlign: "center",
                  containerPadding: "16px",
                  backgroundColor: campaign.brand?.accentColor || "#173f36",
                  color: "#ffffff",
                  borderRadius: "999px",
                  href: { name: "web", values: { href: "{{eventLink}}", target: "_blank" } },
                },
              },
            ],
            values: {},
          },
        ],
        values: {},
      };
      const nextDesign = {
        ...base,
        body: { ...base.body, rows: [...(base.body.rows || []), buttonRow] },
      };
      await messageRef.current.loadDesign(nextDesign);
      const exported = await messageRef.current.exportHtml();
      handleDesignChange(exported);
      setTemplateNotice("Arrow button added. Click it to change its wording, link, color, or arrow character.");
    } catch (err) {
      setError(err.message || "Unable to insert the arrow button right now.");
    }
  };

  // A real, already-resolved Google Calendar link (never a {{token}}) — the
  // event date/time/location is the same for every recipient, so unlike
  // {{firstName}} it doesn't need per-contact substitution at send time.
  const addToCalendarUrl = (() => {
    const event = campaign?.eventId;
    if (!event?.startDate) return "";
    const start = new Date(event.startDate);
    if (Number.isNaN(start.getTime())) return "";
    const end = event.endDate && !Number.isNaN(new Date(event.endDate).getTime())
      ? new Date(event.endDate)
      : new Date(start.getTime() + 60 * 60 * 1000);
    const stamp = (date) => date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: event.name || campaign.name || "Event",
      dates: `${stamp(start)}/${stamp(end)}`,
      location: event.locationType === "venue" ? event.location || "" : event.onlineUrl || event.location || "",
    });
    return `https://calendar.google.com/calendar/render?${params}`;
  })();

  const insertAddToCalendarButton = async () => {
    if (!addToCalendarUrl) {
      setError("This campaign's linked event needs a start date before an “add to calendar” button can be created.");
      return;
    }
    try {
      const current = await messageRef.current.exportHtml();
      const base = current?.design?.body ? current.design : { body: { rows: [], values: {} } };
      const buttonRow = {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: "button",
                values: {
                  text: "Add to Calendar",
                  textAlign: "center",
                  containerPadding: "16px",
                  backgroundColor: campaign.brand?.accentColor || "#173f36",
                  color: "#ffffff",
                  borderRadius: "999px",
                  href: { name: "web", values: { href: addToCalendarUrl, target: "_blank" } },
                },
              },
            ],
            values: {},
          },
        ],
        values: {},
      };
      const nextDesign = {
        ...base,
        body: { ...base.body, rows: [...(base.body.rows || []), buttonRow] },
      };
      await messageRef.current.loadDesign(nextDesign);
      const exported = await messageRef.current.exportHtml();
      handleDesignChange(exported);
      setTemplateNotice("“Add to Calendar” button added, linked to this campaign's event date. Recipients tap it to add the event straight to their own calendar.");
    } catch (err) {
      setError(err.message || "Unable to insert the add-to-calendar button right now.");
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
  const copyPersonalizationToken = async (token) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedToken(token);
      window.setTimeout(() => setCopiedToken(""), 1800);
    } catch {
      setTemplateNotice(`Copy ${token}, then paste it where you want it in the subject or message.`);
    }
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
        inspirationImages: ideaImages.map((image) => image.dataUrl),
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
  const audienceDefinitions = () => {
    const definitions = [
      ...RESEARCH_EMAIL_AUDIENCES,
      ...(campaign.audience || []).map((label, index) => ({
        key: `audience-${index}`,
        label,
      })),
    ];
    const seenLabels = new Set();
    return definitions.filter(({ label }) => {
      const normalized = String(label || "").trim().toLowerCase();
      if (!normalized || seenLabels.has(normalized)) return false;
      seenLabels.add(normalized);
      return true;
    });
  };
  const generateAllAudienceTemplates = async () => {
    if (templateAudience !== "general") {
      setError("Switch to the main email before creating all audience drafts.");
      return;
    }
    const audiences = audienceDefinitions();
    if (!audiences.length) {
      setError("Add at least one target audience before creating audience drafts.");
      return;
    }
    const existingCount = Object.keys(campaign.emailAudienceTemplates || {}).filter((key) =>
      audiences.some((audience) => audience.key === key),
    ).length;
    if (existingCount && !window.confirm(`Create fresh AI drafts for ${audiences.length} audiences? This will replace ${existingCount} existing audience draft${existingCount === 1 ? "" : "s"}; approved history and sent emails stay unchanged.`)) return;
    try {
      setAudienceIdeasGenerating(true);
      setError("");
      setTemplateNotice("");
      const current = await exportCurrentTemplate();
      if (!String(current.subject || "").trim() || !String(current.body || "").trim()) {
        setError("Finish the main email subject and message before creating audience versions.");
        return;
      }
      if (templateDirty) {
        const savedMain = await saveCampaignEmailTemplate(id, {
          ...current,
          audienceKey: "general",
          audienceLabel: "All campaign contacts",
        });
        setEmailTemplate(savedMain);
        setTemplateDirty(false);
      }
      const result = await generateCampaignAudienceTemplates(id, {
        audiences,
        direction: ideaPrompt,
      });
      const refreshedCampaign = normalizeBrandAssets(await fetchCampaign(id));
      setCampaign(refreshedCampaign);
      setTemplateNotice(`${result.generatedCount} personalized audience draft${result.generatedCount === 1 ? "" : "s"} created. Choose any audience above to review and edit its version before approving it.`);
    } catch (err) {
      setError(err.response?.data?.error || "OpenAI could not create the audience drafts right now.");
    } finally {
      setAudienceIdeasGenerating(false);
    }
  };
  const addIdeaImages = async (files) => {
    const available = Math.max(0, 3 - ideaImages.length);
    const selected = Array.from(files || []).slice(0, available);
    if (!selected.length) return;
    const invalid = selected.find((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2.5 * 1024 * 1024);
    if (invalid) {
      setError("Choose JPG, PNG, or WEBP inspiration images no larger than 2.5 MB each.");
      return;
    }
    try {
      const loaded = await Promise.all(selected.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, dataUrl: reader.result });
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })));
      setIdeaImages((current) => [...current, ...loaded.filter((next) => !current.some((image) => image.id === next.id))].slice(0, 3));
      setError("");
    } catch {
      setError("One of those inspiration images could not be read.");
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
      const current = await exportCurrentTemplate();
      await previewTemplate({ template: current });
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
      setTemplateNotice(
        result.refreshedOutreachCount
          ? `Template approved. ${result.refreshedOutreachCount} pending draft${result.refreshedOutreachCount === 1 ? "" : "s"} already in the queue ${result.refreshedOutreachCount === 1 ? "was" : "were"} refreshed to match.`
          : "Template approved.",
      );
      setTemplateVersions((current) => [result.version, ...current]);
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to approve the campaign email.",
      );
    } finally {
      setTemplateSaving(false);
    }
  };
  const previewTemplate = async ({ silent = false, template = emailTemplate } = {}) => {
    const revision = ++previewRevisionRef.current;
    const hasDesignedContent = Boolean(template?.designJson?.body?.rows?.length);
    if (!String(template?.subject || "").trim() && !hasDesignedContent) {
      setEmailPreview(null);
      setPreviewError("");
      setPreviewLoading(false);
      return;
    }
    try {
      if (!silent) setTemplateSaving(true);
      setPreviewLoading(true);
      setPreviewError("");
      const nextPreview = await previewCampaignEmailTemplate(id, {
          ...template,
          logoUrl: campaign.brand?.logoUrl || "",
          flyerUrl: campaign.brand?.flyerUrl || "",
          accentColor: campaign.brand?.accentColor || "#173f36",
        });
      if (previewRevisionRef.current === revision) setEmailPreview(nextPreview);
    } catch (err) {
      if (previewRevisionRef.current === revision) {
        setPreviewError(
          err.response?.data?.error || "The live preview could not be refreshed.",
        );
      }
    } finally {
      if (!silent) setTemplateSaving(false);
      if (previewRevisionRef.current === revision) setPreviewLoading(false);
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
  useEffect(() => {
    if (!id || !emailTemplate || !templateDirty) return undefined;
    const revision = ++autosaveRevisionRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const exported = await messageRef.current?.exportHtml();
        if (!exported) return;
        const audienceLabel = selectedAudienceLabel();
        await saveCampaignEmailTemplate(id, {
          ...emailTemplate,
          body: exported.html,
          designJson: exported.design,
          audienceKey: templateAudience,
          audienceLabel,
        });
        if (autosaveRevisionRef.current === revision) {
          setEmailTemplate((current) => ({
            ...current,
            body: exported.html,
            designJson: exported.design,
          }));
          setTemplateDirty(false);
          setTemplateNotice("Draft autosaved.");
        }
      } catch (err) {
        if (autosaveRevisionRef.current === revision) {
          setTemplateNotice(err.response?.data?.error || "Autosave paused — use Save draft before leaving.");
        }
      }
    }, 1200);
    return () => window.clearTimeout(timer);
    // selectedAudienceLabel is derived from the same campaign/template state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, emailTemplate, templateAudience, templateDirty]);
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
          <Button
            variant="outline"
            onClick={() => navigate(`/discovery?tab=people&campaignId=${campaign._id}`)}
          >
            Find people
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

        <details className="campaign-collapsible">
          <summary>
            <span>Target audience</span>
            <small>
              {campaign.audience?.length
                ? `${campaign.audience.length} group${campaign.audience.length === 1 ? "" : "s"} configured`
                : "No target groups yet"}
            </small>
          </summary>
          <DashboardCard title="Choose who this email is for">
            <p className="campaign-audience-intro">
              Keep these groups broad — Lead Porch matches contacts to this
              campaign by comparing their title, industry, and company
              against the groups below. Find and add contacts from the{" "}
              <button type="button" className="campaign-inline-link" onClick={() => navigate(`/discovery?tab=people&campaignId=${campaign._id}`)}>
                Discovery
              </button>{" "}
              page.
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
                <div className="campaign-audience-database-actions">
                  <div><strong>{audienceMatch?.matched || 0} matching CRM contacts</strong><small>{audienceMatch?.alreadyAssigned || 0} already connected · only eligible contacts matching these groups are included</small></div>
                  <Button variant="outline" size="sm" onClick={() => navigate("/crm/contacts")}>Choose contacts manually</Button>
                </div>
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
                {templateAudience === "general" ? (
                  <section className="campaign-audience-ai-action">
                    <div>
                      <strong>Build every audience version from this design</strong>
                      <small>
                        AI keeps this template&rsquo;s layout, images, links, and buttons, then adapts the subject and message for each target audience. Every version remains a draft until you review and approve it.
                      </small>
                    </div>
                    <Button
                      type="button"
                      loading={audienceIdeasGenerating}
                      disabled={templateSaving || ideaGenerating}
                      onClick={generateAllAudienceTemplates}
                    >
                      Create all audience drafts with AI
                    </Button>
                  </section>
                ) : null}
                <div className="campaign-personalization" aria-label="Email personalization fields">
                  <div>
                    <strong>Personalize your email</strong>
                    <small>
                      Click a field to copy it, then paste it exactly where you want it in the subject or message.
                    </small>
                  </div>
                  <div className="campaign-personalization__tokens">
                    {PERSONALIZATION_TOKENS.map(([label, token]) => (
                      <button
                        type="button"
                        key={token}
                        onClick={() => copyPersonalizationToken(token)}
                        title={`Copy ${token}`}
                      >
                        <span>{label}</span>
                        <code>{copiedToken === token ? "Copied" : token}</code>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="campaign-email-logo">
                  <img
                    src={campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl}
                    alt=""
                    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!(campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl)}
                    onClick={insertLogoBlock}
                  >
                    Insert logo
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!(campaign.brand?.emailLogoUrl || workspaceDefaultLogoUrl)}
                    onClick={insertLogoWithTextBlock}
                  >
                    Insert logo + text
                  </Button>
                  <label className="campaign-accent-color">
                    <span>Accent color</span>
                    <input
                      type="color"
                      value={campaign.brand?.accentColor || workspaceDefaultAccentColor || "#173f36"}
                      onChange={(event) => saveAccentColor(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={insertArrowButton}
                  >
                    Insert arrow button
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!addToCalendarUrl}
                    title={addToCalendarUrl ? "" : "This campaign's linked event needs a start date first"}
                    onClick={insertAddToCalendarButton}
                  >
                    Insert &ldquo;Add to Calendar&rdquo; button
                  </Button>
                  <small>
                    Add the logo by itself or beside editable words. Both
                    options stay movable and resizable.
                  </small>
                  <label className="campaign-email-logo__change">
                    {logoSaving ? "Saving…" : "Change"}
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
                    <button
                      type="button"
                      className="campaign-email-logo__reset"
                      disabled={logoSaving}
                      onClick={resetEmailLogoToDefault}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="campaign-email-workspace">
                <div className="campaign-email-workspace__editor">
                  <UnlayerEmailEditor
                    key={editorInstanceKey}
                    ref={messageRef}
                    design={emailTemplate.designJson}
                    accentColor={campaign.brand?.accentColor || "#173f36"}
                    onDesignChange={handleDesignChange}
                    onUploadImage={uploadInlineImage}
                  />
                  <small>
                    Drag in blocks, images, and buttons; every element has
                    its own size, alignment, and font controls when
                    selected. You can also select a text block and use its
                    {" { } "} menu to insert the same personalization fields.
                    To wire a button to the real registration
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
                      Start with a blank email, add a row, and your preview will appear here.
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
                <div className="campaign-idea-images">
                  <div>
                    <strong>Inspiration images (optional)</strong>
                    <small>Add up to 3 screenshots, flyers, photos, or design references. AI will study them for ideas; they are not automatically inserted into the email.</small>
                  </div>
                  <label className="campaign-idea-images__upload">
                    Add images
                    <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={ideaImages.length >= 3 || ideaGenerating} onChange={(event) => { addIdeaImages(event.target.files); event.target.value = ""; }} />
                  </label>
                  {ideaImages.length ? (
                    <div className="campaign-idea-images__previews">
                      {ideaImages.map((image) => (
                        <figure key={image.id}>
                          <img src={image.dataUrl} alt={`${image.name} inspiration preview`} />
                          <figcaption title={image.name}>{image.name}</figcaption>
                          <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setIdeaImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
                        </figure>
                      ))}
                    </div>
                  ) : null}
                </div>
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
