import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { fetchDeliverabilityHistory } from "../services/api.js";
import "./DeliverabilityHealthPanel.css";

// Account-wide (every campaign combined) — moved here from the individual
// campaign page, where it read as "this campaign's health" even though the
// numbers were never scoped to one campaign. Bounce/complaint rate here are
// what Resend and mailbox providers actually use to judge sender
// reputation, so they matter at the account level regardless of which
// campaign you're looking at; see CampaignWorkspace's own panel for the
// per-campaign counts (sent/delivered/bounced/complained/clicked), which
// are tracked separately per campaign via Resend webhooks.
export default function DeliverabilityHealthPanel() {
  const [deliverability, setDeliverability] = useState(null);
  const [deliverabilityError, setDeliverabilityError] = useState("");
  const [deliverabilityLoading, setDeliverabilityLoading] = useState(false);

  const loadDeliverability = () => {
    setDeliverabilityLoading(true);
    setDeliverabilityError("");
    fetchDeliverabilityHistory(7)
      .then((result) => setDeliverability(result))
      .catch(() => setDeliverabilityError("Unable to load deliverability data from Resend right now."))
      .finally(() => setDeliverabilityLoading(false));
  };
  useEffect(() => {
    loadDeliverability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="campaign-deliverability" aria-label="Email deliverability health">
      <header>
        <div>
          <h3>Deliverability health</h3>
          <p>
            Real send data pulled directly from Resend — account-wide
            (every campaign combined). Bounce and complaint rate are the
            numbers that actually predict spam placement; a single test
            inbox is not.
          </p>
        </div>
        <Button variant="outline" size="sm" loading={deliverabilityLoading} onClick={loadDeliverability}>
          Refresh
        </Button>
      </header>
      {deliverabilityError ? (
        <p className="form-error">{deliverabilityError}</p>
      ) : deliverability ? (
        <>
          {deliverability.truncated ? (
            <p className="form-error">
              Send volume in this window is high enough that this only covers back to {deliverability.coveredFrom} so far, not the full requested window — not every recent email is counted below yet.
            </p>
          ) : null}
          <div className="campaign-deliverability__totals">
            <div>
              <span>Sent {deliverability.coveredFrom ? `(since ${deliverability.coveredFrom})` : "(7 days)"}</span>
              <strong>{deliverability.totals.total}</strong>
            </div>
            <div>
              <span>Bounce rate</span>
              <strong className={deliverability.bounceRate > 2 ? "is-warning" : "is-good"}>
                {deliverability.bounceRate}%
              </strong>
            </div>
            <div>
              <span>Complaint rate</span>
              <strong className={deliverability.complaintRate > 0.1 ? "is-warning" : "is-good"}>
                {deliverability.complaintRate}%
              </strong>
            </div>
            <div>
              <span>Click rate</span>
              <strong>{deliverability.clickRate}%</strong>
            </div>
          </div>
          {deliverability.daily.length ? (
            <div className="campaign-deliverability__days">
              {deliverability.daily.map((day) => (
                <div key={day.date} className="campaign-deliverability__day">
                  <span>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  <strong>{day.total} sent</strong>
                  <small>
                    {day.delivered} delivered · {day.clicked} clicked
                    {day.bounced ? ` · ${day.bounced} bounced` : ""}
                    {day.complained ? ` · ${day.complained} complained` : ""}
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <p>No sends in the last 7 days.</p>
          )}
        </>
      ) : (
        <p>Loading…</p>
      )}
    </section>
  );
}
