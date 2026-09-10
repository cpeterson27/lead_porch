import { useCallback, useEffect, useState } from "react";
import {
  createAmbassadorPayout,
  fetchAmbassadorPayouts,
  fetchAmbassadorReferrals,
  fetchAmbassadors,
  updateAmbassadorPayoutStatus,
  updateAmbassadorProfile,
  updateAmbassadorReferralIdentity,
  updateAmbassadorReferralState,
  updateAmbassadorStatus,
} from "../services/api.js";
import { Link } from "react-router-dom";
import Button from "../components/Button.jsx";
import {
  communityUrlError,
  copyReferralLink,
} from "../utils/ambassadorReferralFields.js";
import "./AmbassadorPortal.css";
const money = (amount, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    (amount || 0) / 100,
  );
export default function AmbassadorAdmin() {
  const [profiles, setProfiles] = useState([]),
    [selected, setSelected] = useState(""),
    [referrals, setReferrals] = useState([]),
    [payouts, setPayouts] = useState([]),
    [error, setError] = useState("");
  const [draft, setDraft] = useState({
    referralAttributionId: "",
    grossAmount: "",
    commissionAmount: "",
    notes: "",
  });
  const [identityDraft, setIdentityDraft] = useState({
      referralCode: "",
      communityUrl: "",
    }),
    [identitySaving, setIdentitySaving] = useState(false),
    [identityNotice, setIdentityNotice] = useState(""),
    [identityError, setIdentityError] = useState(""),
    [copyNotice, setCopyNotice] = useState(""),
    [confirmedChange, setConfirmedChange] = useState(false);
  const loadProfiles = useCallback(
    () =>
      fetchAmbassadors()
        .then((rows) => {
          setProfiles(rows);
          setSelected((current) => current || rows[0]?._id || "");
        })
        .catch((err) =>
          setError(err.response?.data?.error || "Unable to load ambassadors."),
        ),
    [],
  );
  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);
  useEffect(() => {
    if (!selected) return;
    Promise.all([
      fetchAmbassadorReferrals(selected),
      fetchAmbassadorPayouts(selected),
    ])
      .then(([a, b]) => {
        setReferrals(a);
        setPayouts(b);
      })
      .catch((err) =>
        setError(
          err.response?.data?.error || "Unable to load ambassador records.",
        ),
      );
  }, [selected]);
  const profile = profiles.find((row) => row._id === selected);
  useEffect(() => {
    // A selected server record intentionally resets this editable form draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIdentityDraft({
      referralCode: profile?.referralCode || "",
      communityUrl: profile?.communityUrl || "",
    });
    setIdentityNotice("");
    setIdentityError("");
    setCopyNotice("");
    setConfirmedChange(false);
  }, [profile?._id, profile?.referralCode, profile?.communityUrl]);
  const refresh = async () => {
    const [a, b] = await Promise.all([
      fetchAmbassadorReferrals(selected),
      fetchAmbassadorPayouts(selected),
    ]);
    setReferrals(a);
    setPayouts(b);
  };
  const refreshProfile = async (id, changes = {}) => {
    setProfiles((rows) =>
      rows.map((row) => (row._id === id ? { ...row, ...changes } : row)),
    );
  };
  const codeChanged = Boolean(
    profile &&
      identityDraft.referralCode.trim().toLowerCase() !==
        String(profile.referralCode || "").toLowerCase(),
  );
  const saveIdentity = async (regenerate = false) => {
    if (!profile || ((regenerate || codeChanged) && !confirmedChange)) return;
    const urlError = communityUrlError(identityDraft.communityUrl);
    if (urlError) return setIdentityError(urlError);
    setIdentitySaving(true);
    setIdentityError("");
    setIdentityNotice("");
    try {
      let identity = null;
      if (regenerate || codeChanged)
        identity = await updateAmbassadorReferralIdentity(
          profile._id,
          regenerate
            ? { regenerate: true }
            : { referralCode: identityDraft.referralCode },
        );
      const updated = await updateAmbassadorProfile(profile._id, {
        communityUrl: identityDraft.communityUrl,
      });
      const next = {
        ...updated,
        referralCode: identity?.profile?.referralCode || updated.referralCode,
        referralSlug: identity?.profile?.referralSlug || updated.referralSlug,
        referralUrl:
          identity?.referralUrl || updated.referralUrl || profile.referralUrl,
      };
      await refreshProfile(profile._id, next);
      setIdentityDraft({
        referralCode: next.referralCode,
        communityUrl: next.communityUrl || "",
      });
      setConfirmedChange(false);
      setIdentityNotice(
        regenerate
          ? "New referral code generated and saved."
          : "Ambassador referral settings saved.",
      );
    } catch (err) {
      setIdentityError(
        err.response?.data?.error ||
          "Unable to save ambassador referral settings.",
      );
    } finally {
      setIdentitySaving(false);
    }
  };
  const copyLink = async () => {
    try {
      await copyReferralLink(profile?.referralUrl);
      setCopyNotice("Referral link copied.");
    } catch {
      setCopyNotice("Copy failed. Select and copy the referral link manually.");
    }
  };
  const createPayout = async (event) => {
    event.preventDefault();
    try {
      await createAmbassadorPayout({
        referralAttributionId: draft.referralAttributionId,
        grossAmountMinor: Math.round((Number(draft.grossAmount) || 0) * 100),
        commissionAmountMinor: Math.round(
          (Number(draft.commissionAmount) || 0) * 100,
        ),
        notes: draft.notes,
      });
      setDraft({
        referralAttributionId: "",
        grossAmount: "",
        commissionAmount: "",
        notes: "",
      });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to create payout record.");
    }
  };
  return (
    <div className="ambassador-page">
      <header>
        <p>Workspace administration</p>
        <h1>Brand Ambassadors</h1>
        <span>
          Manage referral status and payout tracking. No money is sent from this
          screen.
        </span>
        <Link
          className="btn btn--primary btn--md"
          to="/settings/team?role=ambassador#add-team-person"
        >
          + Add ambassador
        </Link>
        <nav aria-label="Ambassador sections">
          <a href="#ambassador-people">Ambassadors</a>
          <a href="#ambassador-referrals">Referrals</a>
          <a href="#ambassador-payouts">Commissions / Payouts</a>
          <Link to="/ambassadors/resources">Resource Center</Link>
          <Link to="/automations">Follow-up automations</Link>
        </nav>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      <section id="ambassador-people" className="ambassador-panel">
        {!profiles.length && (
          <p>
            Add an ambassador, review their invitation, and let them activate
            their own account. Their referrals and payouts will appear here.
          </p>
        )}
        <label>
          Ambassador
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {profiles.map((row) => (
              <option value={row._id} key={row._id}>
                {row.displayName} · {row.status}
              </option>
            ))}
          </select>
        </label>
        {profile ? (
          <div className="ambassador-referral-settings">
            <header>
              <div>
                <h2>Referral identity</h2>
                <p>
                  The link is generated automatically. Existing codes remain
                  stable when a name changes.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await updateAmbassadorStatus(
                    profile._id,
                    profile.status === "active" ? "inactive" : "active",
                  );
                  await loadProfiles();
                }}
              >
                {profile.status === "active" ? "Deactivate" : "Activate"}
              </Button>
            </header>
            <label>
              Referral code
              <input
                value={identityDraft.referralCode}
                maxLength="70"
                pattern="[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"
                onChange={(event) => {
                  setIdentityDraft({
                    ...identityDraft,
                    referralCode: event.target.value,
                  });
                  setIdentityNotice("");
                }}
              />
              <small>
                3–70 letters, numbers, and single hyphens. Codes are
                case-insensitive.
              </small>
            </label>
            <label>
              Referral link
              <div className="ambassador-copy-row">
                <input
                  readOnly
                  value={
                    profile.referralUrl || "Save to generate the referral link"
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!profile.referralUrl}
                  onClick={copyLink}
                >
                  Copy referral link
                </Button>
              </div>
              {copyNotice ? <small role="status">{copyNotice}</small> : null}
            </label>
            <label>
              Community or group URL (optional)
              <input
                type="url"
                aria-invalid={Boolean(
                  identityError &&
                    communityUrlError(identityDraft.communityUrl),
                )}
                value={identityDraft.communityUrl}
                onChange={(event) => {
                  setIdentityDraft({
                    ...identityDraft,
                    communityUrl: event.target.value,
                  });
                  setIdentityError(communityUrlError(event.target.value));
                }}
                placeholder="https://..."
              />
              <small>
                Optional: a Facebook Group, Skool community, Meetup group,
                LinkedIn Group, or another community managed by this ambassador.
              </small>
            </label>
            <aside className={codeChanged ? "is-visible" : ""}>
              <strong>
                Changing the referral code may invalidate previously shared
                links.
              </strong>
              <label>
                <input
                  type="checkbox"
                  checked={confirmedChange}
                  onChange={(event) => setConfirmedChange(event.target.checked)}
                />{" "}
                I understand and want to change or regenerate this code.
              </label>
            </aside>
            {identityError ? (
              <p className="form-error" role="alert">
                {identityError}
              </p>
            ) : null}
            {identityNotice ? (
              <p className="discovery-notice" role="status">
                {identityNotice}
              </p>
            ) : null}
            <footer>
              <Button
                loading={identitySaving}
                disabled={
                  (codeChanged && !confirmedChange) ||
                  Boolean(communityUrlError(identityDraft.communityUrl))
                }
                onClick={() => saveIdentity(false)}
              >
                Save referral settings
              </Button>
              <Button
                variant="outline"
                loading={identitySaving}
                disabled={!confirmedChange}
                onClick={() => saveIdentity(true)}
              >
                Generate a new code
              </Button>
            </footer>
            <small>
              Commission method: {profile.commissionConfig?.mode || "manual"}
            </small>
          </div>
        ) : null}
      </section>
      <section id="ambassador-referrals" className="ambassador-panel">
        <h2>Referred people and conversion status</h2>
        {!referrals.length && (
          <p>
            No referrals yet. Once someone uses this ambassador’s referral link,
            track their progress here.
          </p>
        )}
        {referrals.map((row) => (
          <article className="ambassador-row" key={row._id}>
            <span>
              <strong>{row.contactId?.name || "Referred Contact"}</strong>
              <small>
                Referred {row.attributedAt ? new Date(row.attributedAt).toLocaleDateString() : "date unavailable"}
                {row.applicationId ? ` · Application ${row.applicationId.status || "linked"}` : " · No application yet"}
                {row.enrollmentId ? ` · Enrollment ${row.enrollmentId.status || "linked"}` : ""}
              </small>
            </span>
            <select
              value={row.state}
              onChange={async (event) => {
                await updateAmbassadorReferralState(
                  row._id,
                  event.target.value,
                );
                await refresh();
              }}
            >
              {[
                "referred",
                "applied",
                "qualified",
                "enrolled",
                "converted",
                "cancelled",
                "refunded",
              ].map((state) => (
                <option key={state}>{state}</option>
              ))}
            </select>
          </article>
        ))}
      </section>
      <section id="ambassador-payouts" className="ambassador-panel">
        <h2>Record a commission</h2>
        <p>
          Select an attributed referral and record the commission owed. Approval
          and marking a payout as paid only update your records; no money is
          transferred.
        </p>
        {!referrals.length ? (
          <p>A referral is needed before a commission can be recorded.</p>
        ) : (
          <form onSubmit={createPayout}>
            <label>
              Referral
              <select
                required
                value={draft.referralAttributionId}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    referralAttributionId: event.target.value,
                  })
                }
              >
                <option value="">Select referral</option>
                {referrals.map((row) => (
                  <option value={row._id} key={row._id}>
                    {row.contactId?.name || row._id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Gross conversion amount
              <input
                min="0"
                step="0.01"
                type="number"
                value={draft.grossAmount}
                onChange={(event) =>
                  setDraft({ ...draft, grossAmount: event.target.value })
                }
              />
            </label>
            {profile?.commissionConfig?.mode === "manual" ? (
              <label>
                Commission amount
                <input
                  required
                  min="0"
                  step="0.01"
                  type="number"
                  value={draft.commissionAmount}
                  onChange={(event) =>
                    setDraft({ ...draft, commissionAmount: event.target.value })
                  }
                />
              </label>
            ) : null}
            <label>
              Notes
              <input
                value={draft.notes}
                onChange={(event) =>
                  setDraft({ ...draft, notes: event.target.value })
                }
              />
            </label>
            <Button type="submit">Create pending payout</Button>
          </form>
        )}
      </section>
      <section className="ambassador-panel">
        <h2>Payout history</h2>
        {!payouts.length && <p>No payouts recorded for this ambassador.</p>}
        {payouts.map((row) => (
          <article className="ambassador-row" key={row._id}>
            <span>
              <strong>
                {row.contactId?.name || "Referral"} ·{" "}
                {money(row.commissionAmountMinor, row.currency)}
              </strong>
              <small>
                {row.productLabel || "Qualifying referral"} · Gross {money(row.grossAmountMinor, row.currency)} · Commission method {row.ruleSnapshot?.mode || profile?.commissionConfig?.mode || "manual"} · Recorded {row.calculatedAt ? new Date(row.calculatedAt).toLocaleDateString() : "date unavailable"}
                {row.approvedAt ? ` · Approved ${new Date(row.approvedAt).toLocaleDateString()}` : ""}
                {row.paidAt ? ` · Paid ${new Date(row.paidAt).toLocaleDateString()}` : ""}
                {row.payoutNotes ? ` · ${row.payoutNotes}` : ""}
              </small>
            </span>
            <span>
              <em>{row.status}</em>
              {row.status === "pending" ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    await updateAmbassadorPayoutStatus(row._id, "approved");
                    await refresh();
                  }}
                >
                  Approve
                </Button>
              ) : null}
              {row.status === "approved" ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    await updateAmbassadorPayoutStatus(row._id, "paid");
                    await refresh();
                  }}
                >
                  Mark paid
                </Button>
              ) : null}
              {row.status !== "void" ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    const notes = window.prompt(
                      "Reason / audit note for voiding this payout",
                    );
                    if (notes === null) return;
                    await updateAmbassadorPayoutStatus(row._id, "void", notes);
                    await refresh();
                  }}
                >
                  Void
                </Button>
              ) : null}
            </span>
          </article>
        ))}
      </section>
    </div>
  );
}
