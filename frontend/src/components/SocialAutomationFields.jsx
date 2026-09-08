import { useEffect, useState } from "react";
import {
  createSocialContactLabel,
  fetchSocialContactLabels,
} from "../services/api.js";
import "./SocialAutomationFields.css";

export function PostAutomationSection({ value, onChange, campaigns, onError }) {
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
export function CampaignSelect({ campaigns, value, onChange }) {
  return (
    <label>
      Campaign (optional)
      <select value={value || ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">No campaign</option>
        {campaigns.map((campaign) => (
          <option key={campaign._id} value={campaign._id}>
            {campaign.programName || campaign.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ContactLabelsControl({ value = [], onChange, onError }) {
  const [labels, setLabels] = useState([]);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetchSocialContactLabels()
      .then((items) => {
        if (active) setLabels(Array.isArray(items) ? items : []);
      })
      .catch(() => onError?.("Contact labels could not be loaded."));
    return () => {
      active = false;
    };
  }, [onError]);

  const add = (label) => {
    if (!label || value.some((item) => item.toLocaleLowerCase() === label.toLocaleLowerCase())) return;
    onChange([...value, label]);
  };

  const create = async () => {
    const label = newLabel.trim().replace(/\s+/g, " ");
    if (!label || saving) return;
    setSaving(true);
    try {
      const saved = await createSocialContactLabel(label);
      setLabels((current) =>
        current.some((item) => item.toLocaleLowerCase() === saved.toLocaleLowerCase())
          ? current
          : [...current, saved].sort((a, b) => a.localeCompare(b)),
      );
      add(saved);
      setNewLabel("");
    } catch (error) {
      onError?.(error.response?.data?.error || "Contact label could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="contact-label-picker">
      <legend>Contact labels <span>(optional)</span></legend>
      <small>These labels are added to the Contact without removing existing labels.</small>
      {value.length ? (
        <div className="contact-label-chips" aria-label="Selected contact labels">
          {value.map((label) => (
            <span key={label.toLocaleLowerCase()}>
              {label}
              <button type="button" aria-label={`Remove ${label}`} onClick={() => onChange(value.filter((item) => item !== label))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <label>
        Select an existing label
        <select value="" onChange={(event) => add(event.target.value)}>
          <option value="">Choose a label…</option>
          {labels.filter((label) => !value.some((item) => item.toLocaleLowerCase() === label.toLocaleLowerCase())).map((label) => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
      </label>
      <div className="contact-label-create">
        <label>
          Create a new label
          <input value={newLabel} maxLength="80" placeholder="Freedom Lead" onChange={(event) => setNewLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); create(); } }} />
        </label>
        <button type="button" className="add-label-button" disabled={saving || !newLabel.trim()} onClick={create}>Add label</button>
      </div>
    </fieldset>
  );
}
