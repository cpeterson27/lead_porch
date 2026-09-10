import { useEffect, useState } from "react";
import {
  createSocialContactLabel,
  fetchSocialContactLabels,
  recommendSocialAutomation,
} from "../services/api.js";
import Button from "./Button.jsx";
import "./SocialAutomationFields.css";

export function PostAutomationSection({ value, onChange, campaigns, onError, contentBriefId, provider }) {
  const set = (values) => onChange({ ...value, ...values });
  const [recommendation, setRecommendation] = useState(null);
  const [recommendBusy, setRecommendBusy] = useState(false);
  const getRecommendation = async () => {
    if (!provider) { onError?.("Select a destination (Facebook or Instagram) before asking for a recommendation."); return; }
    setRecommendBusy(true);
    try {
      const result = await recommendSocialAutomation({ contentBriefId, provider });
      setRecommendation(result);
      const rec = result.recommendation;
      set({
        configured: true,
        triggerType: rec.triggerType,
        keywords: (rec.keywords || []).join(", "),
        qualification: (rec.crmActions?.qualificationSignals || []).join(", "),
        responseTemplate: rec.privateMessage || "",
        tags: rec.crmActions?.tags || value.tags,
      });
    } catch (err) {
      onError?.(err.response?.data?.error || "Content Agent could not prepare a recommendation.");
    } finally {
      setRecommendBusy(false);
    }
  };
  return (
    <details className="post-automation" open={value.configured}>
      <summary>
        <strong>Automate responses to this post</strong>
        <span>Optional · uses Social Automation</span>
      </summary>
      <div className="post-automation__ai">
        <Button type="button" size="sm" variant="outline" loading={recommendBusy} onClick={getRecommendation}>
          Get AI recommendation
        </Button>
        <small>Content Agent proposes a complete automation plan; Social Agent checks whether it's actually executable today. Nothing is created or activated until you save below.</small>
        {recommendation ? (
          <div className={`post-automation__validation post-automation__validation--${recommendation.validation.status}`}>
            <strong>{recommendation.validation.status === "executable" ? "Ready to execute" : "Not executable yet"}</strong>
            <span>{recommendation.validation.reason}</span>
            {recommendation.recommendation.rationale ? <p>{recommendation.recommendation.rationale}</p> : null}
            {recommendation.recommendation.stopConditions?.length ? <p>Stops on: {recommendation.recommendation.stopConditions.join(", ").replaceAll("_", " ")}</p> : null}
            {recommendation.recommendation.publicAcknowledgement ? <p><b>Public reply:</b> {recommendation.recommendation.publicAcknowledgement}</p> : null}
            {recommendation.recommendation.optOutHandling ? <p><b>Opt-out handling:</b> {recommendation.recommendation.optOutHandling}</p> : null}
            {recommendation.recommendation.humanHandoff ? <p><b>Human handoff:</b> {recommendation.recommendation.humanHandoff}</p> : null}
          </div>
        ) : null}
      </div>
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
              <option value="dm_keyword">Direct message contains keyword</option>
              <option value="dm_any">Any new direct message</option>
              <option value="story_reply">Instagram Story reply</option>
            </select>
            {value.triggerType === "story_reply" && (
              <small>
                Story replies only exist on Instagram — this won't apply to a
                Facebook destination even if one is selected.
              </small>
            )}
          </label>
          {["comment_keyword", "dm_keyword"].includes(value.triggerType) && (
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
          <label>
            Qualification signals <small>Optional</small>
            <input
              placeholder="ready-to-buy, price-sensitive"
              value={value.qualification}
              onChange={(event) => set({ qualification: event.target.value })}
            />
            <small>
              Notes added to this contact's record when this automation fires
              — separate multiple signals with commas.
            </small>
          </label>
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
              This sends immediately and automatically the moment someone
              matches the trigger above — no one reviews it first. That's
              different from the Social Agent tools in your Inbox, which
              always wait for you to click send.
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
