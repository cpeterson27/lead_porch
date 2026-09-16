import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { FiCheck } from "react-icons/fi";
import {
  fetchPublicApplication,
  submitPublicApplication,
} from "../services/api.js";
import { PublicLayout } from "./PublicSite.jsx";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { cloudinaryImage } from "../utils/cloudinaryImage.js";
import "./PublicApplication.css";

const initial = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  coachingProgramId: "",
  investingExperience: "",
  currentSituation: "",
  goals: "",
  desiredStartTimeline: "",
  message: "",
  referralCode: "",
  smsConsent: false,
  marketingEmailConsent: false,
  privacyTermsAccepted: false,
};
const legacyHeading = "Apply for coaching";
const legacyIntro = "Tell us where you are and where you want to go.";

export default function PublicApplication({ embedded: embeddedOverride, search: searchOverride }) {
  const location = useLocation();
  const { code } = useParams();
  const search = searchOverride ?? location.search;
  const { site } = useWorkspaceTheme();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(() => {
    const query = new URLSearchParams(search);
    return {
      ...initial,
      referralCode: query.get("ref") || query.get("referral") || code || "",
    };
  });
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);
  const attribution = useMemo(() => {
    const query = new URLSearchParams(search);
    return {
      referralCode: query.get("ref") || query.get("referral") || code || "",
      trackedLinkToken: query.get("go_link") || "",
      utm: {
        source: query.get("utm_source") || "",
        medium: query.get("utm_medium") || "",
        campaign: query.get("utm_campaign") || "",
        content: query.get("utm_content") || "",
        term: query.get("utm_term") || "",
      },
    };
  }, [search, code]);

  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        fetchPublicApplication()
          .then((data) => {
            setConfig(data);
            const selected = new URLSearchParams(search).get(
              "program",
            );
            const matched = data.programs?.find(
              (program) =>
                String(program.id) === selected || program.slug === selected,
            );
            if (matched || data.programs?.length === 1)
              setForm((value) => ({
                ...value,
                coachingProgramId: matched?.id || data.programs[0].id,
              }));
          })
          .catch(() => setError("The application is temporarily unavailable.")),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  const set = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    try {
      setSaving(true);
      const idempotencyKey =
        window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const result = await submitPublicApplication({
        ...form,
        ...attribution,
        referralCode: form.referralCode || attribution.referralCode,
        idempotencyKey,
      });
      setDone(result.data.message);
    } catch (requestError) {
      setError(
        requestError.response?.data?.error ||
          "We could not submit the application. Please review the form and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const heading =
    !config?.heading || config.heading === legacyHeading
      ? "Apply to Join a Program"
      : config.heading;
  const intro =
    !config?.intro || config.intro === legacyIntro
      ? "Choose the program that fits your goals and tell us a little about where you are today."
      : config.intro;
  // The hero panel is always a dark surface, so it prefers the
  // dark-backgrounds logo — the same single light/dark logo pair used
  // everywhere else (public website header, dashboard sidebar).
  const heroLogo =
    site?.branding?.publicSiteLogoDarkUrl || site?.branding?.publicSiteLogoUrl || "";
  const embedded = embeddedOverride ?? new URLSearchParams(search).get("embed") === "1";

  const content = (
      <main className={`application-page ${embedded ? "application-page--embedded" : ""}`}>
        <section className="application-hero">
          <div className="application-hero__copy">
            <p className="public-kicker">Program application</p>
            <h1>{heading}</h1>
            <p className="public-lead">{intro}</p>
          </div>
          {heroLogo ? (
            <div className="application-hero__logo">
              <img
                src={cloudinaryImage(heroLogo, 800)}
                alt={site?.branding?.publicSiteName || "Site logo"}
              />
            </div>
          ) : null}
        </section>
        {done ? (
          <section className="application-success">
            <span className="application-success__badge" aria-hidden="true">
              <FiCheck />
            </span>
            <h2>Application received</h2>
            <p>{done}</p>
            {config?.nextStepCta?.url ? (
              <a className="public-button" href={config.nextStepCta.url}>
                {config.nextStepCta.label || "Next step"}
              </a>
            ) : null}
          </section>
        ) : config?.enabled === false ? (
          <p className="public-empty">
            Program applications are not currently open.
          </p>
        ) : (
          <form onSubmit={submit} className="application-form">
            <fieldset className="application-section">
              <legend>
                <span className="application-section__index">1</span>
                Your details
              </legend>
              <div className="application-grid">
                <label>
                  First name
                  <input
                    required
                    autoComplete="given-name"
                    value={form.firstName}
                    onChange={(event) => set("firstName", event.target.value)}
                  />
                </label>
                <label>
                  Last name
                  <input
                    required
                    autoComplete="family-name"
                    value={form.lastName}
                    onChange={(event) => set("lastName", event.target.value)}
                  />
                </label>
                <label>
                  Email
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(event) => set("email", event.target.value)}
                  />
                </label>
                <label>
                  Phone
                  <input
                    type="tel"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(event) => set("phone", event.target.value)}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="application-section">
              <legend>
                <span className="application-section__index">2</span>
                Your program
              </legend>
              <div className="application-grid">
                <label className="wide">
                  Choose a program
                  <select
                    required
                    value={form.coachingProgramId}
                    onChange={(event) =>
                      set("coachingProgramId", event.target.value)
                    }
                  >
                    <option value="">Select a program</option>
                    {config?.programs?.map((row) => (
                      <option value={row.id} key={row.id}>
                        {row.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide application-referral">
                  Referral code or referral link <span>(optional)</span>
                  <input
                    autoComplete="off"
                    placeholder="Enter the code or paste the link you received"
                    value={form.referralCode}
                    onChange={(event) => set("referralCode", event.target.value)}
                  />
                  <small>
                    If an ambassador or coach shared Ellie’s Coaching with you,
                    enter their code or link so we can give them credit.
                  </small>
                </label>
              </div>
            </fieldset>
            <fieldset className="application-section">
              <legend>
                <span className="application-section__index">3</span>
                Tell us about you
              </legend>
              <div className="application-grid">
                <label className="wide">
                  {config?.questionLabels?.investingExperience ||
                    "Investing experience"}
                  <textarea
                    value={form.investingExperience}
                    onChange={(event) =>
                      set("investingExperience", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  {config?.questionLabels?.currentSituation ||
                    "Current situation"}
                  <textarea
                    value={form.currentSituation}
                    onChange={(event) =>
                      set("currentSituation", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  {config?.questionLabels?.goals || "Goals"}
                  <textarea
                    value={form.goals}
                    onChange={(event) => set("goals", event.target.value)}
                  />
                </label>
                <label>
                  {config?.questionLabels?.desiredStartTimeline ||
                    "Desired start timeline"}
                  {config?.timelineOptions?.length ? (
                    <select
                      value={form.desiredStartTimeline}
                      onChange={(event) =>
                        set("desiredStartTimeline", event.target.value)
                      }
                    >
                      <option value="">Select</option>
                      {config.timelineOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={form.desiredStartTimeline}
                      onChange={(event) =>
                        set("desiredStartTimeline", event.target.value)
                      }
                    />
                  )}
                </label>
                <label className="wide">
                  {config?.questionLabels?.message ||
                    "Anything else we should know?"}
                  <textarea
                    value={form.message}
                    onChange={(event) => set("message", event.target.value)}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="application-section application-section--consent">
              <legend>
                <span className="application-section__index">4</span>
                Stay in touch
              </legend>
              <div className="application-consent">
                <label>
                  <input
                    type="checkbox"
                    checked={form.smsConsent}
                    onChange={(event) => set("smsConsent", event.target.checked)}
                  />
                  I agree to receive program-application text messages. Message
                  and data rates may apply. Reply STOP to opt out.
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.marketingEmailConsent}
                    onChange={(event) =>
                      set("marketingEmailConsent", event.target.checked)
                    }
                  />
                  I would like to receive Ellie Coaching news and program updates
                  by email.
                </label>
                <label>
                  <input
                    required
                    type="checkbox"
                    checked={form.privacyTermsAccepted}
                    onChange={(event) =>
                      set("privacyTermsAccepted", event.target.checked)
                    }
                  />
                  <span>I acknowledge the <a href={config?.privacyUrl || "/privacy"} target="_blank" rel="noreferrer">Privacy Policy</a> and <a href={config?.termsUrl || "/terms"} target="_blank" rel="noreferrer">Terms of Service</a>.</span>
                </label>
              </div>
            </fieldset>
            {error ? <p className="application-error">{error}</p> : null}
            <button
              className="public-button"
              disabled={saving || !config?.programs?.length}
            >
              {saving ? "Submitting…" : "Submit program application"}
            </button>
          </form>
        )}
      </main>
  );
  return embedded ? content : <PublicLayout>{content}</PublicLayout>;
} 
