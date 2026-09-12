import { useEffect, useMemo, useState } from "react";
import Button from "./Button.jsx";
import Modal from "./Modal.jsx";
import { fetchContentBriefs, generateAiImage, uploadEventImage } from "../services/api.js";
import "./CampaignModal.css";

const EVENT_TEMPLATES = [
  { key: "event_investor", name: "Investor invitation", description: "A direct invitation for qualified real-estate investors." },
  { key: "event_operator", name: "Operator invitation", description: "For property managers, operators, and multifamily leaders." },
  { key: "event_partner", name: "Partner invitation", description: "For affiliates and referral partners who can share the event." },
];

const PROGRAM_TEMPLATES = [
  { key: "program_enrollment", name: "Program enrollment", description: "Invite qualified people to join a course, membership, coaching program, or community." },
  { key: "program_operator", name: "Direct offer", description: "Promote a service or offer directly to the people most likely to need it." },
  { key: "program_partner", name: "Partner referral", description: "Ask affiliates and strategic partners to refer the right people." },
];

const PROGRAM_AUDIENCES = [
  "Prospective members",
  "Existing community members",
  "Qualified buyers",
  "Affiliate and referral partners",
];

const createEmptyForm = (campaignKind = "event") => ({
  name: "",
  campaignKind,
  programName: "",
  startDate: "",
  ticketPrice: "",
  ticketGoal: "",
  audience: [],
  description: "",
  brand: { logoUrl: "", websiteUrl: "", accentColor: "#173f36" },
  templateKey: campaignKind === "program" ? PROGRAM_TEMPLATES[0].key : EVENT_TEMPLATES[0].key,
});

export default function CampaignModal({
  isOpen,
  onClose,
  onSubmit,
  audienceOptions = [],
  initialData = null,
  submitting = false,
  defaultCampaignKind = "event",
}) {
  const [form, setForm] = useState(() => createEmptyForm(defaultCampaignKind));
  const [error, setError] = useState("");
  const [savedTemplates, setSavedTemplates] = useState([]);
  const [newAudience, setNewAudience] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [flyerPrompt, setFlyerPrompt] = useState("");
  const [flyerGenerating, setFlyerGenerating] = useState(false);
  const [flyerUrl, setFlyerUrl] = useState("");
  const [flyerError, setFlyerError] = useState("");

  const generateFlyer = async () => {
    if (!flyerPrompt.trim() || flyerGenerating) return;
    setFlyerGenerating(true);
    setFlyerError("");
    try {
      const result = await generateAiImage({ prompt: flyerPrompt, campaignId: initialData?._id || null });
      setFlyerUrl(result.url);
    } catch (err) {
      setFlyerError(err.response?.data?.code === "IMAGE_GENERATION_DISABLED" ? "Image generation isn't turned on for this workspace yet." : (err.response?.data?.error || "Unable to generate that image."));
    } finally {
      setFlyerGenerating(false);
    }
  };

  const templateOptions = useMemo(
    () => (form.campaignKind === "program" ? PROGRAM_TEMPLATES : EVENT_TEMPLATES),
    [form.campaignKind],
  );
  const availableAudiences = form.campaignKind === "program"
    ? [...new Set([...PROGRAM_AUDIENCES, ...audienceOptions])]
    : audienceOptions;

  useEffect(() => {
    if (!isOpen) return;
    const resetForm = window.setTimeout(() => {
      if (initialData) {
        const campaignKind = initialData.campaignKind || "event";
        const choices = campaignKind === "program" ? PROGRAM_TEMPLATES : EVENT_TEMPLATES;
        setForm({
          name: initialData.name || "",
          campaignKind,
          programName: initialData.programName || "",
          startDate: initialData.startDate ? initialData.startDate.split("T")[0] : "",
          ticketPrice: initialData.ticketPrice ?? "",
          ticketGoal: initialData.ticketGoal ?? "",
          audience: initialData.audience || [],
          description: initialData.description || "",
          brand: { logoUrl: initialData.brand?.logoUrl || "", websiteUrl: initialData.brand?.websiteUrl || "", accentColor: initialData.brand?.accentColor || "#173f36" },
          templateKey: initialData.templateKey || choices[0].key,
        });
      } else {
        setForm(createEmptyForm(defaultCampaignKind));
      }
      setError("");
    }, 0);
    return () => window.clearTimeout(resetForm);
  }, [isOpen, initialData, defaultCampaignKind]);

  useEffect(() => {
    if (!isOpen) return;
    fetchContentBriefs("email_template")
      .then((response) => setSavedTemplates(response.data || []))
      .catch(() => setSavedTemplates([]));
  }, [isOpen]);

  const handleChange = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const setCampaignKind = (campaignKind) => {
    const choices = campaignKind === "program" ? PROGRAM_TEMPLATES : EVENT_TEMPLATES;
    setForm((current) => ({
      ...current,
      campaignKind,
      templateKey: choices[0].key,
      audience: [],
    }));
  };

  const toggleAudience = (value) => {
    setForm((current) => ({
      ...current,
      audience: current.audience.includes(value)
        ? current.audience.filter((item) => item !== value)
        : [...current.audience, value],
    }));
  };

  const addAudience = () => {
    const value = newAudience.trim();
    if (!value) return;
    setForm((current) => ({ ...current, audience: [...new Set([...current.audience, value])] }));
    setNewAudience("");
  };

  const uploadLogo = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
      setError("Choose a PNG, JPG, or WEBP logo smaller than 8 MB.");
      return;
    }
    try {
      setLogoUploading(true);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const uploaded = await uploadEventImage({ file: dataUrl, filename: file.name });
      setForm((current) => ({ ...current, brand: { ...current.brand, logoUrl: uploaded.url } }));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload the program logo.");
    } finally {
      setLogoUploading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    const isProgram = form.campaignKind === "program";

    if (!form.name || !form.audience.length || (!isProgram && (!form.startDate || !form.ticketPrice || !form.ticketGoal))) {
      setError(isProgram
        ? "Add a campaign name and at least one audience."
        : "Add the event details and at least one audience.");
      return;
    }

    try {
      await onSubmit({
        ...form,
        contentBriefId: form.templateKey.startsWith("content:") ? form.templateKey.slice("content:".length) : null,
        ticketPrice: Number(form.ticketPrice || 0),
        ticketGoal: Number(form.ticketGoal || 0),
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Unable to save campaign");
    }
  };

  const selectedTemplate = templateOptions.find((template) => template.key === form.templateKey);
  const isProgram = form.campaignKind === "program";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initialData ? "Edit campaign" : "Create campaign"}
      footer={(
        <div className="campaign-modal__footer">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" form="campaign-form" variant="primary" loading={submitting}>
            {initialData ? "Save changes" : "Create campaign"}
          </Button>
        </div>
      )}
    >
      <form id="campaign-form" className="campaign-form" onSubmit={handleSubmit}>
        <p className="campaign-form__intro">Choose the business goal first. An event campaign promotes a dated registration. An offer campaign promotes an ongoing program, service, membership, or community such as Skool.</p>

        <div className="campaign-kind-picker" role="group" aria-label="Campaign type">
          <button type="button" className={form.campaignKind === "event" ? "is-selected" : ""} onClick={() => setCampaignKind("event")}>
            <span>Event campaign</span><small>Sell tickets or registrations</small>
          </button>
          <button type="button" className={form.campaignKind === "program" ? "is-selected" : ""} onClick={() => setCampaignKind("program")}>
            <span>Offer / program campaign</span><small>Enroll people in a program, service, membership, or Skool community</small>
          </button>
        </div>

        <div className="campaign-form-grid">
          <div className="form-field span-2">
            <label htmlFor="campaign-name">Campaign name <span>*</span></label>
            <input id="campaign-name" type="text" placeholder={isProgram ? "e.g. Elite Operator Program — Fall Enrollment" : "e.g. Deal to Close Bootcamp — September"} value={form.name} onChange={handleChange("name")} />
          </div>

          {isProgram ? (
            <>
              <div className="form-field span-2">
                <label htmlFor="program-name">What are you promoting?</label>
                <input id="program-name" type="text" placeholder="e.g. Multifamily Mentorship on Skool" value={form.programName} onChange={handleChange("programName")} />
              </div>
              <div className="form-field">
                <label htmlFor="program-logo">Program logo</label>
                <input id="program-logo" type="file" accept="image/*" onChange={(event) => uploadLogo(event.target.files?.[0])} />
                <small>{logoUploading ? "Uploading…" : "Used in the workspace and program emails."}</small>
              </div>
              <div className="form-field">
                <label htmlFor="program-site">Program website</label>
                <input id="program-site" type="url" placeholder="https://" value={form.brand.websiteUrl} onChange={(event) => setForm((current) => ({ ...current, brand: { ...current.brand, websiteUrl: event.target.value } }))} />
              </div>
              {form.brand.logoUrl ? <div className="program-logo-preview span-2"><img src={form.brand.logoUrl} alt="Program logo preview" /><button type="button" onClick={() => setForm((current) => ({ ...current, brand: { ...current.brand, logoUrl: "" } }))}>Remove logo</button></div> : null}

              <div className="form-field span-2 ai-flyer-generator">
                <label htmlFor="ai-flyer-prompt">Generate a flyer with AI</label>
                <div className="ai-flyer-generator__row">
                  <input id="ai-flyer-prompt" type="text" placeholder="e.g. A bold flyer announcing early enrollment for the Multifamily Mentorship program" value={flyerPrompt} onChange={(event) => setFlyerPrompt(event.target.value)} />
                  <Button type="button" size="sm" variant="outline" loading={flyerGenerating} disabled={!flyerPrompt.trim()} onClick={generateFlyer}>Generate</Button>
                </div>
                <small>Real OpenAI image generation — a rough draft to react to, not final artwork. Nothing is posted anywhere.</small>
                {flyerError ? <p className="form-error">{flyerError}</p> : null}
                {flyerUrl ? (
                  <div className="program-logo-preview span-2">
                    <img src={flyerUrl} alt="Generated flyer draft" />
                    <a href={flyerUrl} target="_blank" rel="noreferrer">Open full size</a>
                    <button type="button" onClick={() => setForm((current) => ({ ...current, brand: { ...current.brand, logoUrl: flyerUrl } }))}>Use as program logo</button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="form-field">
                <label htmlFor="campaign-start">Event date <span>*</span></label>
                <input id="campaign-start" type="date" value={form.startDate} onChange={handleChange("startDate")} />
              </div>
              <div className="form-field">
                <label htmlFor="campaign-price">Ticket price <span>*</span></label>
                <input id="campaign-price" type="number" min="0" step="0.01" placeholder="0.00" value={form.ticketPrice} onChange={handleChange("ticketPrice")} />
              </div>
              <div className="form-field">
                <label htmlFor="campaign-goal">Registration goal <span>*</span></label>
                <input id="campaign-goal" type="number" min="1" placeholder="100" value={form.ticketGoal} onChange={handleChange("ticketGoal")} />
              </div>
            </>
          )}

          <div className="form-field span-2">
            <label htmlFor="campaign-description">Campaign brief</label>
            <textarea id="campaign-description" rows="3" placeholder="What is the offer, why now, and what should the audience do next?" value={form.description} onChange={handleChange("description")} />
          </div>
        </div>

        <section className="campaign-template-panel" aria-labelledby="template-title">
          <div>
            <p className="eyebrow">Email starting point</p>
            <h4 id="template-title">Template for this audience</h4>
          </div>
          <div className="template-choice-list">
            {templateOptions.map((template) => (
              <label className={form.templateKey === template.key ? "template-choice is-selected" : "template-choice"} key={template.key}>
                <input type="radio" name="templateKey" value={template.key} checked={form.templateKey === template.key} onChange={handleChange("templateKey")} />
                <span><strong>{template.name}</strong><small>{template.description}</small></span>
              </label>
            ))}
            {savedTemplates.map((template) => (
              <label className={form.templateKey === `content:${template._id}` ? "template-choice is-selected" : "template-choice"} key={template._id}>
                <input type="radio" name="templateKey" value={`content:${template._id}`} checked={form.templateKey === `content:${template._id}`} onChange={handleChange("templateKey")} />
                <span><strong>{template.title}</strong><small>Saved Jarvis or AI Content email template</small></span>
              </label>
            ))}
          </div>
          {selectedTemplate ? <p className="template-help">Selected: {selectedTemplate.description}</p> : null}
        </section>

        <fieldset className="audience-panel">
          <legend>Target audience <span>*</span></legend>
          <p>Select the people this message is for. Contacts remain campaign-specific when you import or associate them.</p>
          <div className="audience-grid">
            {availableAudiences.map((option) => (
              <label key={option} className="audience-item">
                <input type="checkbox" checked={form.audience.includes(option)} onChange={() => toggleAudience(option)} />
                <span>{option}</span>
              </label>
            ))}
          </div>
          <div className="audience-custom-entry">
            <input type="text" value={newAudience} placeholder="Add a client-specific audience" onChange={(event) => setNewAudience(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addAudience(); } }} />
            <Button type="button" variant="outline" size="sm" onClick={addAudience}>Add audience</Button>
          </div>
        </fieldset>

        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  );
}
