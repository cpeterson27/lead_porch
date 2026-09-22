import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Modal from "./Modal.jsx";
import { fetchWorkspaceConfig } from "../services/api.js";
import "./CampaignModal.css";

// Every campaign starts blank — logo, website URL, and a flyer are all
// handled directly in the email design page instead (drop a logo in,
// insert a button linking anywhere, generate a flyer there), so none of
// that belongs on this form too. Offering a template/starting-point choice
// here was also just one more decision in the way; it's always blank now.
const BLANK_TEMPLATE_KEY = "blank";

const PROGRAM_AUDIENCES = [
  "Prospective members",
  "Existing community members",
  "Qualified buyers",
  "Affiliate and referral partners",
];

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "draft", label: "Draft" },
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
  brand: { logoUrl: "", flyerUrl: "", websiteUrl: "", accentColor: "#173f36" },
  templateKey: BLANK_TEMPLATE_KEY,
  status: "active",
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
  const [newAudience, setNewAudience] = useState("");

  const availableAudiences = form.campaignKind === "program"
    ? [...new Set([...PROGRAM_AUDIENCES, ...audienceOptions])]
    : audienceOptions;

  useEffect(() => {
    if (!isOpen) return;
    const resetForm = window.setTimeout(() => {
      if (initialData) {
        const campaignKind = initialData.campaignKind || "event";
        setForm({
          name: initialData.name || "",
          campaignKind,
          programName: initialData.programName || "",
          startDate: initialData.startDate ? initialData.startDate.split("T")[0] : "",
          ticketPrice: initialData.ticketPrice ?? "",
          ticketGoal: initialData.ticketGoal ?? "",
          audience: initialData.audience || [],
          description: initialData.description || "",
          brand: { logoUrl: initialData.brand?.logoUrl || "", flyerUrl: initialData.brand?.flyerUrl || "", websiteUrl: initialData.brand?.websiteUrl || "", accentColor: initialData.brand?.accentColor || "#173f36" },
          templateKey: initialData.templateKey || BLANK_TEMPLATE_KEY,
          status: initialData.status || "active",
        });
      } else {
        setForm(createEmptyForm(defaultCampaignKind));
        fetchWorkspaceConfig()
          .then((config) => {
            const accentColor = config.branding?.accentColor;
            if (accentColor) setForm((current) => ({ ...current, brand: { ...current.brand, accentColor } }));
          })
          .catch(() => {});
      }
      setError("");
    }, 0);
    return () => window.clearTimeout(resetForm);
  }, [isOpen, initialData, defaultCampaignKind]);

  const handleChange = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const setCampaignKind = (campaignKind) => {
    setForm((current) => ({
      ...current,
      campaignKind,
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

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    const isProgram = form.campaignKind === "program";

    if (!form.name || !form.audience.length || (!isProgram && (!form.startDate || form.ticketPrice === "" || form.ticketPrice === null || form.ticketPrice === undefined))) {
      setError(isProgram
        ? "Add a campaign name and at least one audience."
        : "Add the event details and at least one audience.");
      return;
    }

    try {
      await onSubmit({
        ...form,
        contentBriefId: null,
        ticketPrice: Number(form.ticketPrice || 0),
        ticketGoal: form.ticketGoal === "" || form.ticketGoal === null || form.ticketGoal === undefined ? null : Number(form.ticketGoal),
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Unable to save campaign");
    }
  };

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
          <div className={initialData ? "form-field" : "form-field span-2"}>
            <label htmlFor="campaign-name">Campaign name <span>*</span></label>
            <input id="campaign-name" type="text" placeholder={isProgram ? "e.g. Elite Operator Program — Fall Enrollment" : "e.g. Deal to Close Bootcamp — September"} value={form.name} onChange={handleChange("name")} />
          </div>

          {initialData ? (
            <div className="form-field">
              <label htmlFor="campaign-status">Status</label>
              <select id="campaign-status" value={form.status} onChange={handleChange("status")}>
                {STATUS_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : null}

          {isProgram ? (
            <div className="form-field span-2">
              <label htmlFor="program-name">What are you promoting?</label>
              <input id="program-name" type="text" placeholder="e.g. Multifamily Mentorship on Skool" value={form.programName} onChange={handleChange("programName")} />
            </div>
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
                <label htmlFor="campaign-goal">Registration goal <small>(optional)</small></label>
                <input id="campaign-goal" type="number" min="0" placeholder="100" value={form.ticketGoal} onChange={handleChange("ticketGoal")} />
              </div>
            </>
          )}
        </div>

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
