import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { FiCheck } from "react-icons/fi";
import {
  fetchPublicApplication,
  submitPublicApplication,
} from "../services/api.js";
import { PublicLayout } from "./PublicSite.jsx";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { cloudinaryImage } from "../utils/cloudinaryImage.js";
import { trackSiteEvent } from "../utils/siteTracking.js";
import "./PublicApplication.css";

const initial = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  coachingProgramId: "",
  professionOrBusiness: "",
  investingExperience: "",
  currentSituation: "",
  goals: "",
  desiredStartTimeline: "",
  capitalReadiness: "",
  biggestObstacle: "",
  whyNow: "",
  willingnessToInvest: "",
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
  const started = useRef(false);
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
      trackSiteEvent("application_submit", {
        program_id: form.coachingProgramId,
        referral_present: Boolean(form.referralCode || attribution.referralCode),
      });
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
  // Prefers a logo uploaded specifically for this page (Settings ->
  // Applications -> Application page logo); falls back to the same
  // light-background site logo used in the public site header if none is
  // set. This panel is no longer a dark card, so the light-background
  // variant is the right default now, not the dark one.
  const heroLogo =
    config?.logoUrl || site?.branding?.publicSiteLogoUrl || site?.branding?.publicSiteLogoDarkUrl || "";
  const embedded = embeddedOverride ?? new URLSearchParams(search).get("embed") === "1";

  const content = (
      /* public-inner is what every other public page's main wrapper uses to
         sit above .public-sticky-background (position: relative; z-index: 1
         in PublicSite.css) — this page was missing it, so its content was
         fully present and correctly styled in the DOM (confirmed live) but
         painted underneath the fixed background photo, appearing blank. */
      <main className={`public-inner application-page ${embedded ? "application-page--embedded" : ""}`}>
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
          <form
            onSubmit={submit}
            className="application-form"
            onFocusCapture={() => {
              if (started.current) return;
              started.current = true;
              trackSiteEvent("application_start", { embedded });
            }}
          >
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
                      {
                        set("coachingProgramId", event.target.value);
                        trackSiteEvent("program_select", { program_id: event.target.value });
                      }
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
                  {config?.questionLabels?.professionOrBusiness ||
                    "What do you do for work / your business?"}
                  <textarea
                    value={form.professionOrBusiness}
                    onChange={(event) =>
                      set("professionOrBusiness", event.target.value)
                    }
                  />
                </label>
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
                <label>
                  {config?.questionLabels?.capitalReadiness ||
                    "How ready are you to invest capital right now?"}
                  <input
                    value={form.capitalReadiness}
                    onChange={(event) =>
                      set("capitalReadiness", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  {config?.questionLabels?.biggestObstacle ||
                    "What's the biggest obstacle in your way?"}
                  <textarea
                    value={form.biggestObstacle}
                    onChange={(event) =>
                      set("biggestObstacle", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  {config?.questionLabels?.whyNow ||
                    "Why is now the right time for you?"}
                  <textarea
                    value={form.whyNow}
                    onChange={(event) => set("whyNow", event.target.value)}
                  />
                </label>
                <label>
                  {config?.questionLabels?.willingnessToInvest ||
                    "Are you ready to invest in coaching to reach these goals?"}
                  <input
                    value={form.willingnessToInvest}
                    onChange={(event) =>
                      set("willingnessToInvest", event.target.value)
                    }
                  />
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
