import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { fetchDeliverabilityHistory } from "../services/api.js";
import "./DeliverabilityHealthPanel.css";

// day.date is a plain "YYYY-MM-DD" business-day key (see
// resendDeliverabilityService.js's businessDateKey) — not a UTC instant.
// Parsing it with `new Date("...T00:00:00Z")` and letting toLocaleDateString
// convert that to the viewer's local timezone shifted the displayed label
// back a day for anyone west of UTC (confirmed live: a batch correctly
// bucketed "Sep 24" was showing as "Sep 23" for a Pacific-timezone viewer).
// Building the Date from the parsed Y/M/D components directly, with no
// timezone conversion, keeps the label matching the key exactly.
function formatBusinessDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
              <span>Sent {deliverability.coveredFrom ? `(since ${formatBusinessDate(deliverability.coveredFrom)})` : "(7 days)"}</span>
              <strong>{deliverability.totals.total}</strong>
            </div>
            <div>
              <span>Delivered</span>
              <strong>{deliverability.totals.delivered}</strong>
            </div>
            <div>
              <span>Bounced</span>
              <strong className={deliverability.bounceRate > 2 ? "is-warning" : "is-good"}>
                {deliverability.totals.bounced}
              </strong>
            </div>
            <div>
              <span>Complained</span>
              <strong className={deliverability.complaintRate > 0.1 ? "is-warning" : "is-good"}>
                {deliverability.totals.complained}
              </strong>
            </div>
            <div>
              <span>Clicked</span>
              <strong>{deliverability.totals.clicked}</strong>
            </div>
          </div>
          {deliverability.daily.length ? (
            <div className="campaign-deliverability__days">
              {deliverability.daily.map((day) => (
                <div key={day.date} className="campaign-deliverability__day">
                  <span>{formatBusinessDate(day.date)}</span>
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
