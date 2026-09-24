import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  FiArrowRight,
  FiCheck,
  FiChevronLeft,
  FiChevronRight,
  FiExternalLink,
  FiMapPin,
  FiMenu,
  FiMoon,
  FiPlay,
  FiStar,
  FiSun,
  FiX,
} from "react-icons/fi";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import {
  beginPublicProgramCheckout,
  bookDiscoveryCall,
  fetchDiscoveryCallAvailability,
  fetchPublicProfile,
  fetchPublicProgram,
  fetchPublicTestimonials,
} from "../services/api.js";
import { cloudinaryImage } from "../utils/cloudinaryImage.js";
import { trackSiteEvent } from "../utils/siteTracking.js";
import TestimonialVideoPlayer from "../components/TestimonialVideoPlayer.jsx";
import { ModalPortal } from "../components/ModalLayer.jsx";
import useModalLayer from "../hooks/useModalLayer.js";
import "./PublicSite.css";
import "./PublicEnhancements.css";

// Render the application as a real in-page component so the modal has one
// document and one scroll region. The current app already owns the router;
// explicit props provide the modal query state without nesting another Router.
const PublicApplication = lazy(() => import("./PublicApplication.jsx"));

function EmbeddedApplication({ path }) {
  const search = new URL(path, window.location.origin).search;
  return (
    <div className="program-application-modal__scroll">
      <Suspense fallback={null}>
        <PublicApplication embedded search={search} />
      </Suspense>
    </div>
  );
}

const applyPath = "/apply";
function EditorialHeading({ text, accent }) {
  const value = String(text || "");
  const phrase = String(accent || "").trim();
  const index = phrase ? value.toLowerCase().indexOf(phrase.toLowerCase()) : -1;
  if (index < 0) return value;
  return (
    <>
      {value.slice(0, index)}
      <em>{value.slice(index, index + phrase.length)}</em>
      {value.slice(index + phrase.length)}
    </>
  );
}
// CHANGED: removed the isEllieWorkspace check and hardcoded logo paths.
// Logo now comes entirely from workspace branding data — set
// publicSiteLogoUrl (used by default / light theme) and, optionally,
// publicSiteLogoDarkUrl (used when the visitor is in dark theme) on the
// workspace record. For Ellie, set:
//   publicSiteLogoUrl:     "/elliescoachinglogo-dark.png"
//   publicSiteLogoDarkUrl: "/elliescoachinglogo-white.png"
// to preserve exactly what's live today.
function Brand({ site, theme }) {
  const workspaceName = String(
      site?.workspace?.name || site?.branding?.publicSiteName || "",
    ),
    logo =
      (theme === "dark" && site?.branding?.publicSiteLogoDarkUrl) ||
      site?.branding?.publicSiteLogoUrl;
  return (
    <a
      className="public-brand"
      href="/#home"
      aria-label={`${site?.branding?.publicSiteName || workspaceName || "Site"} home`}
    >
      {logo ? (
        <img
          src={cloudinaryImage(logo, 340)}
          alt={
            site?.branding?.publicSiteName || workspaceName || "Workspace logo"
          }
        />
      ) : (
        <span>{workspaceName || "Lead Porch"}</span>
      )}
    </a>
  );
}
function SmartLink({ to, className, children }) {
  return String(to || "").startsWith("/") ? (
    <Link className={className} to={to}>
      {children}
    </Link>
  ) : (
    <a className={className} href={to}>
      {children}
    </a>
  );
}
function ApplicationButton({
  className = "public-button",
  children = "Apply",
  program,
}) {
  const [open, setOpen] = useState(false),
    closeRef = useRef(null);
  useModalLayer(open);
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    document.body.classList.add("program-application-open");
    return () => {
      document.body.classList.remove("program-application-open");
    };
  }, [open]);

  const query = new URLSearchParams({
    embed: "1",
    ...(program ? { program } : {}),
  });
  return (
    <>
      <button type="button" className={className} onClick={() => {
        trackSiteEvent("application_open", { program_slug: program || "" });
        setOpen(true);
      }}>
        {children}
      </button>
      {open ? <ModalPortal>
        <div
          className="program-application-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Program application"
          onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
        >
          <div>
            <button
              ref={closeRef}
              type="button"
              className="program-application-modal__close"
              onClick={() => setOpen(false)}
              aria-label="Close application"
            >
              <FiX />
            </button>
            <EmbeddedApplication path={`/apply?${query}`} />
          </div>
        </div>
      </ModalPortal> : null}
    </>
  );
}
// "editorial" and "classic" used to resolve to the exact same font (no
// real distinction, despite the dropdown offering both), so there was
// effectively only one heading option and one body option to choose
// from. Each name now maps to a genuinely different loaded font.
const HEADING_FONT_STACKS = {
  editorial: '"Playfair Display",Georgia,serif',
  classic: '"Instrument Serif",Georgia,serif',
  modern: '"DM Sans",ui-sans-serif,system-ui,sans-serif',
  friendly: '"Poppins",ui-sans-serif,system-ui,sans-serif',
};
const BODY_FONT_STACKS = {
  modern: '"DM Sans",ui-sans-serif,system-ui,sans-serif',
  classic: '"Instrument Serif",Georgia,serif',
  friendly: '"Poppins",ui-sans-serif,system-ui,sans-serif',
};

export function PublicLayout({ children }) {
  const { site, loading } = useWorkspaceTheme();
  const configuredTheme =
    site?.branding?.surfaceMode === "light" ? "light" : "dark";
  const [open, setOpen] = useState(false),
    [visitorTheme, setVisitorTheme] = useState(null),
    theme = visitorTheme || configuredTheme;
  // CHANGED: workspaceName computed once and reused for loading text and
  // footer fallbacks, so nothing here is hardcoded to a specific client.
  const workspaceName =
    site?.branding?.publicSiteName || site?.workspace?.name || "";
  if (loading)
    return (
      <div className="public-loading">{`Opening ${workspaceName || "your"} site…`}</div>
    );
  const socials = site?.publicSite?.socialLinks || [],
    visibility = site?.publicSite?.sectionVisibility || {},
    showPrograms = visibility.programs !== false,
    showJourney = visibility.journey !== false,
    showTeam = visibility.team !== false,
    showTestimonials = visibility.testimonials !== false,
    showResults = visibility.results === true,
    close = () => setOpen(false);
  return (
    <div
      className={`public-site${site?.publicSite?.stickyBackgroundUrl ? " has-sticky-background" : ""}`}
      data-public-theme={theme}
      style={{
        "--public-base-size": `${site?.publicSite?.baseFontSize || 16}px`,
        "--public-heading-scale": site?.publicSite?.headingScale || 1,
        "--public-heading-font": HEADING_FONT_STACKS[site?.publicSite?.headingFont] || HEADING_FONT_STACKS.editorial,
        "--public-body-font": BODY_FONT_STACKS[site?.publicSite?.bodyFont] || BODY_FONT_STACKS.modern,
      }}
    >
      {site?.publicSite?.stickyBackgroundUrl ? (
        <div
          className="public-sticky-background"
          role="img"
          aria-label={site.publicSite.stickyBackgroundAlt || ""}
          style={{
            backgroundImage: `${theme === "dark" ? "linear-gradient(rgb(5 10 9 / 58%), rgb(5 10 9 / 72%))" : "linear-gradient(rgb(250 251 250 / 64%), rgb(250 251 250 / 76%))"}, url(${cloudinaryImage(site.publicSite.stickyBackgroundUrl, 2000)})`,
          }}
        />
      ) : null}
      <header className="public-header">
        <Brand site={site} theme={theme} />
        <button
          className="public-menu"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="public-navigation"
          aria-label="Toggle navigation"
        >
          {open ? <FiX /> : <FiMenu />}
        </button>
        <nav id="public-navigation" className={open ? "is-open" : ""}>
          <a onClick={close} href="/#about">
            Why us
          </a>
          {showPrograms ? (
            <a onClick={close} href="/#programs">
              Programs
            </a>
          ) : null}
          {showJourney ? (
            <a onClick={close} href="/#journey">
              The path
            </a>
          ) : null}
          {showTestimonials ? (
            <a onClick={close} href="/#results">
              Testimonials
            </a>
          ) : null}
          <Link onClick={close} to="/faq">
            FAQ
          </Link>
          <Link className="public-login" to="/login">
            Login
          </Link>
          {site?.publicSite?.allowThemeToggle ? (
            <button
              className="public-theme-toggle"
              type="button"
              onClick={() =>
                setVisitorTheme(theme === "light" ? "dark" : "light")
              }
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? <FiMoon /> : <FiSun />}
            </button>
          ) : null}
          <ApplicationButton className="public-apply-btn">
            Apply to join
          </ApplicationButton>
        </nav>
      </header>
      {children}
      <footer className="public-footer">
        <div className="public-footer-top">
          <div className="public-footer-brand">
            <Brand site={site} theme={theme} />
            <p>
              {site?.publicSite?.footerText ||
                "Practical support for people ready to take the next step."}
            </p>
          </div>
          <div className="public-footer-col">
            <div className="public-footer-label">EXPLORE</div>
            {showPrograms ? <a href="/#programs">Programs</a> : null}
            <a href="/#about">About</a>
            {showTeam ? <a href="/#team">Team</a> : null}
            {showResults ? <a href="/#results">Results</a> : null}
            <Link to="/faq">FAQ</Link>
          </div>
          <div className="public-footer-col">
            <div className="public-footer-label">CONNECT</div>
            <a href="/#contact">Contact</a>
            {showPrograms ? <a href="/#programs">Application</a> : null}
            {socials.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="public-footer-col">
            <div className="public-footer-label">COMPANY</div>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/data-deletion">Data deletion</Link>
            <Link to="/login">Staff login</Link>
          </div>
        </div>
        <div className="public-footer-bottom">
          <small>
            © {new Date().getFullYear()} {workspaceName || "Lead Porch"}.{" "}
            {site?.branding?.poweredByGrowthOperator
              ? "Powered by Lead Porch."
              : "All rights reserved."}
          </small>
        </div>
      </footer>
    </div>
  );
}

function ProgramCards({ programs = [] }) {
  const [expanded, setExpanded] = useState(""),
    [applying, setApplying] = useState(null),
    [buying, setBuying] = useState(null),
    [buyerForm, setBuyerForm] = useState({ firstName: "", lastName: "", email: "" }),
    [buyerBusy, setBuyerBusy] = useState(false),
    [buyerError, setBuyerError] = useState(""),
    closeRef = useRef(null);
  useModalLayer(Boolean(applying) || Boolean(buying));
  useEffect(() => {
    if (!applying) return undefined;
    closeRef.current?.focus();
    document.body.classList.add("program-application-open");
    return () => {
      document.body.classList.remove("program-application-open");
    };
  }, [applying]);
  const beginPurchase = (program) => {
    trackSiteEvent("instant_checkout_open", { program_slug: program.slug || String(program.id) });
    setBuyerError("");
    setBuyerForm({ firstName: "", lastName: "", email: "" });
    setBuying(program);
  };
  const submitPurchase = async (event) => {
    event.preventDefault();
    if (!buying || buyerBusy) return;
    setBuyerBusy(true);
    setBuyerError("");
    try {
      const result = await beginPublicProgramCheckout(buying.slug || buying.id, buyerForm);
      trackSiteEvent("instant_checkout_submit", { program_slug: buying.slug || String(buying.id) });
      window.location.href = result.publicPaymentUrl;
    } catch (err) {
      setBuyerError(err.response?.data?.error || "Unable to start checkout. Please try again.");
      setBuyerBusy(false);
    }
  };
  if (!programs.length)
    return <p className="public-empty">No programs are currently published.</p>;

  const orderedPrograms = [...programs].sort(
    (left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0),
  );
  const featured = orderedPrograms.filter(
    (program) =>
      program.section === "accelerator" ||
      (!program.section && Number(program.price?.amount || 0) >= 10000),
  );
  const featuredIds = new Set(featured.map((program) => String(program.id)));
  const intensive = orderedPrograms.filter(
    (program) => !featuredIds.has(String(program.id)),
  );
  const explicitlyPopular = featured.find((program) => program.isFeatured);
  const popularId = String(
    explicitlyPopular?.id ||
      featured[Math.floor(featured.length / 2)]?.id ||
      "",
  );
  const formatLabel = (program) => {
    if (program.coachingFormat) return program.coachingFormat;
    const text = `${program.title || ""} ${program.summary || ""}`;
    if (/one[- ]on[- ]one|1[- ]on[- ]1/i.test(text)) return "ONE-ON-ONE";
    if (/bootcamp/i.test(text)) return "BOOTCAMP";
    return "COACHING";
  };
  const money = (program) =>
    program.priceVisible !== false && program.price?.amount != null
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: program.price.currency || "USD",
          maximumFractionDigits: 0,
        }).format(program.price.amount)
      : "Talk with our team";
  const acceleratorStage = (program, index) => {
    if (program.tierLabel) return program.tierLabel;
    const amount = Number(program.price?.amount || 0);
    if (amount >= 20000) return "ALL-INCLUSIVE";
    if (amount >= 15000) return "ACQUIRE";
    if (amount >= 10000) return "IMPLEMENT";
    return ["IMPLEMENT", "ACQUIRE", "ALL-INCLUSIVE"][index] || "ACCELERATE";
  };
  const comparisonFeatures = [
    ...new Set(
      featured.flatMap((program) => program.highlights || []).filter(Boolean),
    ),
  ];

  return (
    <>
      <nav className="public-offer-path" aria-label="Coaching offer path">
        {[
          ["01", "LEARN", "Focused six-week programs"],
          ["02", "IMPLEMENT", "Build with guided support"],
          ["03", "ACQUIRE", "Move from strategy to assets"],
          ["04", "ALL-INCLUSIVE", "Highest-touch partnership"],
        ].map(([number, title, description]) => (
          <div key={title}>
            <span>{number}</span>
            <strong>{title}</strong>
            <small>{description}</small>
          </div>
        ))}
      </nav>
      <div className="public-curriculum-group">
        <div className="public-curriculum-label">
          ASSET ACQUISITION ACCELERATOR
        </div>
        {featured.length > 0 ? (
          <p className="public-offer-intro">
            Compare every level at a glance. The all-inclusive option is the
            highest-touch path; every application is reviewed before payment.
          </p>
        ) : null}
        <div
          className={`public-accelerator-row${featured.some((program) => expanded === String(program.id)) ? " has-expanded" : ""}`}
        >
          {featured.map((program) => (
            <article
              className={`public-accelerator-card${expanded === String(program.id) ? " is-expanded" : ""}${popularId === String(program.id) ? " is-featured" : ""}`}
              key={program.id}
            >
              <div className="public-accelerator-img-wrap">
                {program.imageUrl ? (
                  <img
                    className="public-accelerator-img"
                    src={cloudinaryImage(program.imageUrl, 760)}
                    alt={program.imageAlt || `${program.title} program`}
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="public-program-image-empty"
                    aria-hidden="true"
                  >
                    Program image
                  </div>
                )}
                {popularId === String(program.id) && (
                  <div className="public-accelerator-badge">MOST POPULAR</div>
                )}
              </div>
              <div className="public-accelerator-content">
                <div className="public-offer-stage">
                  {acceleratorStage(program, featured.indexOf(program))}
                </div>
                <div className="public-accelerator-meta">
                  {program.duration?.value || ""} {program.duration?.unit || ""}
                  {program.duration?.value ? " · " : ""}
                  {formatLabel(program)}
                </div>
                <div className="public-accelerator-title">{program.title}</div>
                <p className="public-accelerator-summary">
                  {program.summary || program.description || "Personalized support for your next stage of growth."}
                </p>
                {program.highlights?.length ? (
                  <ul className="public-offer-includes" aria-label={`${program.title} includes`}>
                    {program.highlights.slice(0, 5).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {expanded === String(program.id) && program.description ? (
                  <div
                    className="public-accelerator-desc"
                    id={`program-details-${program.id}`}
                  >
                    {program.description}
                  </div>
                ) : null}
                <div className="public-accelerator-footer">
                  <span className="public-accelerator-price">
                    {money(program)}
                  </span>
                  {program.description &&
                  program.description !== program.summary ? (
                    <button
                      type="button"
                      className="public-text-link"
                      aria-expanded={expanded === String(program.id)}
                      aria-controls={`program-details-${program.id}`}
                      onClick={() =>
                        setExpanded((current) =>
                          current === String(program.id)
                            ? ""
                            : String(program.id),
                        )
                      }
                    >
                      {expanded === String(program.id)
                        ? "Hide details"
                        : "Learn more"}
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="public-program-apply"
                  onClick={() => {
                    trackSiteEvent("application_open", { program_slug: program.slug || String(program.id) });
                    setApplying(program);
                  }}
                >
                  Apply to program <FiArrowRight />
                </button>
                {program.instantEnroll?.enabled ? (
                  <button
                    type="button"
                    className="public-program-buy"
                    onClick={() => beginPurchase(program)}
                  >
                    {program.instantEnroll.ctaLabel || "Enroll Now"} <FiArrowRight />
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        {featured.length > 1 ? (
          <div className="public-comparison-wrap">
            <table className="public-accelerator-comparison">
              <caption>Compare what is included</caption>
              <thead>
                <tr>
                  <th scope="col">Program feature</th>
                  {featured.map((program, index) => (
                    <th scope="col" key={program.id}>
                      <span>{acceleratorStage(program, index)}</span>
                      <strong>{program.comparisonPriceLabel || money(program)}</strong>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Program length</th>
                  {featured.map((program) => (
                    <td key={program.id}>
                      {program.comparisonDurationLabel || (program.duration?.value
                        ? `${program.duration.value} ${program.duration.unit || ""}`
                        : "Ask our team")}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Coaching format</th>
                  {featured.map((program) => (
                    <td key={program.id}>{formatLabel(program)}</td>
                  ))}
                </tr>
                {comparisonFeatures.map((feature) => (
                  <tr key={feature}>
                    <th scope="row">{feature}</th>
                    {featured.map((program) => {
                      const included = (program.highlights || []).includes(feature);
                      return (
                        <td key={program.id} aria-label={included ? "Included" : "Not included"}>
                          {included ? <FiCheck aria-hidden="true" /> : <span aria-hidden="true">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {intensive.length > 0 && (
        <div className="public-curriculum-group">
          <div className="public-curriculum-label">
            LEARN · SIX-WEEK PROGRAMS
          </div>
          <div
            className={`public-program-row${intensive.some((program) => expanded === String(program.id)) ? " has-expanded" : ""}`}
          >
            {intensive.map((program) => (
              <article
                className={`public-program-card${expanded === String(program.id) ? " is-expanded" : ""}`}
                key={program.id}
              >
                <div className="public-program-img-wrap">
                  {program.imageUrl ? (
                    <img
                      className="public-program-img"
                      src={cloudinaryImage(program.imageUrl, 760)}
                      alt={program.imageAlt || `${program.title} program`}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="public-program-image-empty"
                      aria-hidden="true"
                    >
                      Program image
                    </div>
                  )}
                </div>
                <div className="public-program-content">
                  <div className="public-program-title">{program.title}</div>
                  {expanded === String(program.id) ? (
                    <div
                      className="public-program-desc"
                      id={`program-details-${program.id}`}
                    >
                      {program.description || program.summary}
                    </div>
                  ) : null}
                  <div className="public-program-details">
                    <span className="public-program-price">
                      {money(program)}
                    </span>
                    <button
                      type="button"
                      className="public-text-link"
                      aria-expanded={expanded === String(program.id)}
                      aria-controls={`program-details-${program.id}`}
                      onClick={() =>
                        setExpanded((current) =>
                          current === String(program.id)
                            ? ""
                            : String(program.id),
                        )
                      }
                    >
                      {expanded === String(program.id)
                        ? "Hide details"
                        : "Learn more"}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="public-program-apply"
                    onClick={() => {
                      trackSiteEvent("application_open", { program_slug: program.slug || String(program.id) });
                      setApplying(program);
                    }}
                  >
                    Apply to program <FiArrowRight />
                  </button>
                  {program.instantEnroll?.enabled ? (
                    <button
                      type="button"
                      className="public-program-buy"
                      onClick={() => beginPurchase(program)}
                    >
                      {program.instantEnroll.ctaLabel || "Enroll Now"} <FiArrowRight />
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
      {applying ? <ModalPortal>
        <div
          className="program-application-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Apply for ${applying.title}`}
          onKeyDown={(event) => event.key === "Escape" && setApplying(null)}
        >
          <div>
            <button
              ref={closeRef}
              type="button"
              className="program-application-modal__close"
              onClick={() => setApplying(null)}
              aria-label="Close application"
            >
              <FiX />
            </button>
            <EmbeddedApplication path={`/apply?program=${encodeURIComponent(applying.slug || applying.id)}&embed=1`} />
          </div>
        </div>
      </ModalPortal> : null}
      {buying ? <ModalPortal>
        <div
          className="program-application-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Enroll in ${buying.title}`}
          onKeyDown={(event) => event.key === "Escape" && !buyerBusy && setBuying(null)}
        >
          <div>
            <button
              type="button"
              className="program-application-modal__close"
              onClick={() => !buyerBusy && setBuying(null)}
              aria-label="Close"
            >
              <FiX />
            </button>
            <form className="public-checkout-form" onSubmit={submitPurchase}>
              <h2>Enroll in {buying.title}</h2>
              <p className="public-checkout-form__price">{money(buying)}</p>
              <p>Enter your details and you&rsquo;ll be taken to a secure checkout page to complete payment.</p>
              {buyerError ? <p className="form-error">{buyerError}</p> : null}
              <label>
                First name
                <input
                  required
                  value={buyerForm.firstName}
                  onChange={(event) => setBuyerForm({ ...buyerForm, firstName: event.target.value })}
                />
              </label>
              <label>
                Last name
                <input
                  required
                  value={buyerForm.lastName}
                  onChange={(event) => setBuyerForm({ ...buyerForm, lastName: event.target.value })}
                />
              </label>
              <label>
                Email
                <input
                  required
                  type="email"
                  value={buyerForm.email}
                  onChange={(event) => setBuyerForm({ ...buyerForm, email: event.target.value })}
                />
              </label>
              <button type="submit" className="public-program-buy" disabled={buyerBusy}>
                {buyerBusy ? "Starting checkout…" : "Continue to secure checkout"}
              </button>
            </form>
          </div>
        </div>
      </ModalPortal> : null}
    </>
  );
}
function Testimonials({ rows = [] }) {
  return (
    <div className="testimonial-grid">
      {rows.map((row) => (
        <blockquote key={row.id}>
          {row.videoUrl ? (
            <TestimonialVideoPlayer
              videoUrl={row.videoUrl}
              coverUrl={row.avatarUrl ? cloudinaryImage(row.avatarUrl, 1000) : ""}
            />
          ) : row.avatarUrl ? (
            <img
              className="testimonial-avatar"
              src={cloudinaryImage(row.avatarUrl, 128)}
              alt=""
              loading="lazy"
            />
          ) : null}
          {row.rating ? (
            <div
              className="testimonial-stars"
              aria-label={`${row.rating} out of 5 stars`}
            >
              {Array.from({ length: row.rating }, (_, i) => (
                <FiStar key={i} />
              ))}
            </div>
          ) : null}
          <details className="testimonial-story">
            <summary>
              <span>{row.body}</span>
              <em aria-hidden="true" />
            </summary>
            <p>{row.body}</p>
          </details>
          {row.resultContext ? <small className="testimonial-result">{row.resultContext}</small> : null}
          <footer>
            <strong>{row.displayName}</strong>
            {row.headline ? <span>{row.headline}</span> : null}
          </footer>
        </blockquote>
      ))}
    </div>
  );
}
function embedUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.includes("youtube.com"))
      return `https://www.youtube.com/embed/${url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).pop()}`;
    if (url.hostname === "youtu.be")
      return `https://www.youtube.com/embed/${url.pathname.slice(1)}`;
    if (url.hostname.includes("vimeo.com"))
      return `https://player.vimeo.com/video/${url.pathname.split("/").filter(Boolean).pop()}`;
  } catch {
    return "";
  }
  return "";
}
function HeroVideoTile({ site }) {
  const p = site?.publicSite || {};
  const workspaceName =
    site?.branding?.publicSiteName || site?.workspace?.name || "";
  const [playing, setPlaying] = useState(false),
    closeRef = useRef(null),
    embed = embedUrl(p.introVideoUrl);
  useModalLayer(playing);
  useEffect(() => {
    if (playing) closeRef.current?.focus();
  }, [playing]);
  if (!p.introVideoUrl && !p.introVideoPosterUrl) return null;
  return (
    <>
      <button
        type="button"
        className="public-hero__video"
        aria-label={
          p.introVideoAlt ||
          p.introVideoTitle ||
          `Watch: Welcome to ${workspaceName || "the program"}`
        }
        style={
          p.introVideoPosterUrl
            ? {
                backgroundImage: `linear-gradient(#0002,#0002),url(${cloudinaryImage(p.introVideoPosterUrl, 480)})`,
              }
            : undefined
        }
        onClick={() => p.introVideoUrl && setPlaying(true)}
        disabled={!p.introVideoUrl}
      >
        <span className="public-hero__play">
          <FiPlay />
        </span>
        <small>
          Watch ·{" "}
          {p.introVideoTitle || `Welcome to ${workspaceName || "the program"}`}
        </small>
      </button>
      {playing ? <ModalPortal>
        <div
          className="video-modal"
          role="dialog"
          aria-modal="true"
          aria-label={
            p.introVideoTitle || `${workspaceName || "Program"} introduction`
          }
          onKeyDown={(event) => event.key === "Escape" && setPlaying(false)}
        >
          <button
            ref={closeRef}
            onClick={() => setPlaying(false)}
            aria-label="Close video"
          >
            <FiX />
          </button>
          <div>
            {embed ? (
              <iframe
                src={embed}
                title={
                  p.introVideoTitle ||
                  `${workspaceName || "Program"} introduction`
                }
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            ) : (
              <video
                src={p.introVideoUrl}
                poster={cloudinaryImage(p.introVideoPosterUrl, 1280)}
                controls
                autoPlay
              />
            )}
          </div>
        </div>
      </ModalPortal> : null}
    </>
  );
}
function Portrait({ person }) {
  return person.avatarUrl ? (
    <img
      src={cloudinaryImage(person.avatarUrl, 600)}
      alt={person.displayName}
      loading="lazy"
    />
  ) : (
    <div className="team-placeholder" aria-hidden="true">
      {person.displayName.slice(0, 2).toUpperCase()}
    </div>
  );
}
function Team({ rows = [] }) {
  if (!rows.length) return null;
  const [leader, ...team] = rows;
  return (
    <section className="team-section public-section" id="team">
      <header>
        <div>
          <p className="public-kicker">The people behind the program</p>
          <h2>Guidance from a team—not a faceless course.</h2>
        </div>
        <p>
          Published profiles introduce the specialists students may learn from
          across the journey.
        </p>
      </header>
      <article className="team-lead">
        <Portrait person={leader} />
        <div>
          <p className="public-kicker">
            {leader.publicTitle || "Coaching team"}
          </p>
          <h3>{leader.displayName}</h3>
          <p className="team-headline">{leader.headline}</p>
          <p>{leader.bio}</p>
          <Link to={`/people/${leader.slug}`}>
            Meet {leader.displayName.split(" ")[0]} <FiArrowRight />
          </Link>
        </div>
      </article>
      {team.length ? (
        <div className="team-rail">
          {team.map((person) => (
            <article key={person.slug}>
              <Portrait person={person} />
              <p className="public-kicker">{person.publicTitle || "Coach"}</p>
              <h3>{person.displayName}</h3>
              <p>{person.headline}</p>
              <Link to={`/people/${person.slug}`}>
                View profile <FiArrowRight />
              </Link>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function PublicHome() {
  const { site } = useWorkspaceTheme();
  const p = site?.publicSite || {},
    visibility = p.sectionVisibility || {},
    showPrograms = visibility.programs !== false,
    showHeroCopy = visibility.heroCopy !== false,
    showHeroImage = visibility.heroImage !== false,
    showHeroQuote = visibility.heroQuote !== false,
    videoOnlyHero = !showHeroCopy && !showHeroImage,
    discoveryCallCta = p.discoveryCallEnabled ? (
      <Link className="public-button public-discovery-call-cta" to="/book-a-call">
        {p.discoveryCallButtonLabel || "Book a Discovery Call"}
      </Link>
    ) : null,
    heroImage = p.heroMediaUrl || "",
    workspaceName =
      site?.branding?.publicSiteName || site?.workspace?.name || "",
    heroEyebrow = p.eyebrow || "Coaching · Education · Results",
    // CHANGED: the bolded word in the headline/intro title is now driven by
    // data (headlineAccent / introTitleAccent) instead of being hardcoded.
    // For Ellie, set headlineAccent: "Discipline" and
    // introTitleAccent: "real operators" to keep her page identical.
    headlineAccent = p.headlineAccent || "",
    introTitleAccent = p.introTitleAccent || "",
    // CHANGED: was the unconditional Ellie-specific pull-quote.
    // For Ellie, set aboutQuote to her existing quote text.
    aboutQuote =
      p.aboutQuote || "A clear point of view, thoughtfully put into practice.",
    // CHANGED: was the unconditional literal "ELLIE BAXTER".
    // For Ellie, set heroQuoteAttribution: "ELLIE BAXTER".
    heroQuoteAttribution = p.heroQuoteAttribution || workspaceName,
    aboutDisplayName = p.aboutTitle?.replace(/^Meet\s+/i, "") || workspaceName,
    initials =
      aboutDisplayName
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase() || "—";
  return (
    <PublicLayout>
      <main id="main-content" className="public-home-wrap">
        <section
          className={`public-hero-section${videoOnlyHero ? " public-hero-section--video-only" : ""}`}
        >
          {showHeroCopy ? (
            <div className="public-hero-left">
              <div className="public-hero-tags">
                <span className="public-hero-tag">{heroEyebrow}</span>
              </div>
              <h1 className="public-hero-headline">
                <EditorialHeading text={p.headline} accent={headlineAccent} />
              </h1>
              <div className="public-hero-subhead">{p.subheadline}</div>
              <div className="public-hero-actions">
                <SmartLink
                  className="public-hero-btn-primary"
                  to={
                    showPrograms ? "#programs" : p.primaryCtaUrl || "#contact"
                  }
                >
                  {showPrograms
                    ? "Explore programs"
                    : p.primaryCtaLabel || "Contact us"}
                </SmartLink>
                <SmartLink
                  className="public-hero-btn-secondary"
                  to={p.secondaryCtaUrl || "/#about"}
                >
                  {p.secondaryCtaLabel || "Meet the founder"}
                </SmartLink>
              </div>
              {visibility.video !== false ? (
                <>
                  <HeroVideoTile site={site} />
                  {discoveryCallCta}
                </>
              ) : null}
            </div>
          ) : visibility.video !== false ? (
            <div className="public-hero-video-only">
              <HeroVideoTile site={site} />
              {discoveryCallCta}
            </div>
          ) : null}
          {showHeroImage ? (
            <div className="public-hero-right">
              <div className="public-hero-img-box">
                {heroImage ? (
                  <img
                    className="public-hero-img"
                    src={cloudinaryImage(heroImage, 960)}
                    alt={p.heroMediaAlt || ""}
                  />
                ) : (
                  <div
                    className="public-hero-image-placeholder"
                    aria-hidden="true"
                  />
                )}
                {showHeroQuote ? (
                  <div className="public-hero-quote-box">
                    <span className="public-hero-quote">
                      "
                      {p.heroTagline ||
                        "Learn what works, build momentum, and get results."}
                      "
                    </span>
                    <small>— {heroQuoteAttribution}</small>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section className="public-why-section" id="about">
          <div className="public-why-title-block">
            <h2 className="public-why-title">
              <EditorialHeading text={p.introTitle} accent={introTitleAccent} />
            </h2>
            <div className="public-why-desc">{p.introBody}</div>
          </div>
          <div className="public-why-features">
            {(p.valuePropositions || []).map((row, index) => (
              <div className="public-why-feature" key={`${row.title}-${index}`}>
                <span className="public-why-feature-mark" aria-hidden="true" />
                <div className="public-why-feature-title">{row.title}</div>
                <div className="public-why-feature-desc">{row.body}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="public-meet-section">
          <div className="public-meet-grid">
            <div className="public-meet-photo-area">
              {p.aboutImageUrl ? (
                <img
                  src={cloudinaryImage(p.aboutImageUrl, 1200)}
                  className="public-meet-photo"
                  alt={aboutDisplayName}
                  loading="lazy"
                />
              ) : (
                <div className="public-meet-placeholder" aria-hidden="true">
                  {initials}
                </div>
              )}
            </div>
            <div className="public-meet-bio-area">
              <div className="public-meet-tags">
                {p.aboutEyebrow || "EXPERIENCE. PERSPECTIVE. SUPPORT."}
              </div>
              <h3 className="public-meet-title">
                {p.aboutTitle || `Meet ${workspaceName || "the founder"}`}
              </h3>
              <div className="public-meet-desc">{p.aboutBody}</div>
              <div className="public-meet-quote-box">
                <span className="public-meet-quote">"{aboutQuote}"</span>
              </div>
            </div>
          </div>
        </section>

        {visibility.team !== false ? <Team rows={site?.team || []} /> : null}

        {visibility.testimonials !== false &&
        site?.featuredTestimonials?.length ? (
          <section className="public-section public-testimonials" id="results">
            <p className="public-kicker">Student perspectives</p>
            <h2>Progress shared by the people doing the work.</h2>
            <Testimonials rows={site.featuredTestimonials} />
          </section>
        ) : null}

        {p.homepageLinks?.includes("/faq") && p.faqItems?.length ? (
          <section className="public-section public-homepage-faq" id="faq">
            <p className="public-kicker">Frequently asked questions</p>
            <h2>{p.seoPages?.faqHeading || "Answers before your next step."}</h2>
            <div className="public-homepage-faq__list">
              {p.faqItems.slice(0, 4).map((item) => (
                <details key={item.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
            <Link className="public-button" to="/faq">See all FAQs</Link>
          </section>
        ) : null}


        {visibility.programs !== false ? (
          <section className="public-curriculum-section" id="programs">
            <div className="public-curriculum-header">
              <h2 className="public-curriculum-title">
                The <em className="public-curriculum-accent">Curriculum</em>
              </h2>
              <div className="public-curriculum-desc">
                {p.programsTitle ||
                  "Choose the support that meets you where you are. Structured programs designed for every stage of your journey."}
              </div>
            </div>
            <ProgramCards programs={site?.programs} />
          </section>
        ) : null}

        {visibility.journey !== false ? (
          <section className="public-path-section" id="journey">
            <div className="public-path-left">
              <span className="public-path-label">
                {p.journeyLabel || "YOUR PATH TO MASTERY"}
              </span>
              <h2 className="public-path-title">
                {p.journeyTitle || "Your Path to Mastery"}
              </h2>
              <div className="public-path-desc">{p.journeyCopy}</div>
              <ApplicationButton className="public-path-btn">
                Start Your Application
              </ApplicationButton>
            </div>
            <div className="public-path-right">
              <ol className="public-path-steps">
                {(p.journeySteps || []).map((step, i) => (
                  <li className="public-path-step" key={step}>
                    <span className="public-path-step-num">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}

        {visibility.event !== false && site?.upcomingEvent ? (
          <section className="public-training-section">
            <div className="public-training-date">
              <span className="public-training-date-num">
                {new Date(site.upcomingEvent.startDate)
                  .toLocaleDateString(undefined, { month: "short" })
                  .toUpperCase()}
              </span>
              <span className="public-training-date-day">
                {new Date(site.upcomingEvent.startDate).getDate()}
              </span>
            </div>
            <div className="public-training-info">
              <div className="public-training-label">
                {p.eventEyebrow || "UPCOMING TRAINING"}
              </div>
              <div className="public-training-title">
                {p.eventTitle || site.upcomingEvent.name}
              </div>
              <div className="public-training-desc">
                {p.eventSummary || site.upcomingEvent.summary}
              </div>
            </div>
            {site.upcomingEvent.registrationUrl && (
              <a
                className="public-training-btn"
                href={site.upcomingEvent.registrationUrl}
              >
                {p.eventCtaLabel || "Event Details"}
              </a>
            )}
          </section>
        ) : null}

        {visibility.community !== false &&
        p.communityTitle &&
        p.communityBody ? (
          <section className="community-section">
            <p className="community-section__word" aria-hidden="true">
              SKOOL
            </p>
            <div>
              <p className="public-kicker">Your private Skool community</p>
              <h2>{p.communityTitle}</h2>
              <p>{p.communityBody}</p>
              <div className="community-feature-pills" aria-label="Skool community features">
                {["Program learning", "Deal discussions", "Live coaching calls", "Peer community", "Resource library"].map((feature) => (
                  <span key={feature}><FiCheck />{feature}</span>
                ))}
              </div>
              {p.communityCtaLabel && p.communityCtaUrl ? (
                <SmartLink className="public-community-cta" to={p.communityCtaUrl}>
                  {p.communityCtaLabel}
                  <FiArrowRight />
                </SmartLink>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="public-final-section">
          <div className="public-final-content">
            <p className="public-kicker">
              {p.finalCtaEyebrow || "Ready for your next move?"}
            </p>
            <h2 className="public-final-title">
              {p.finalCtaTitle ||
                "Choose the program that fits your goals and apply to become a student."}
            </h2>
            <p className="public-final-copy">{p.finalCtaCopy}</p>
          </div>
          <div className="public-final-action">
            <ApplicationButton>
              {p.finalCtaLabel || "Apply to join"} <FiArrowRight />
            </ApplicationButton>
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}

export function AboutPage() {
  const { site } = useWorkspaceTheme();
  const workspaceName =
    site?.branding?.publicSiteName || site?.workspace?.name || "us";
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        <p className="public-kicker">About {workspaceName}</p>
        <h1>{site?.publicSite?.seoPages?.aboutHeading || "Experience, perspective, and practical support."}</h1>
        <div className="public-prose">
          <p>
            {site?.publicSite?.aboutBody ||
              `${workspaceName}'s complete public biography is ready to be configured in Lead Porch.`}
          </p>
          <h2>Why clients work with us</h2>
          <ul>
            {(site?.publicSite?.aboutHighlights?.length
              ? site.publicSite.aboutHighlights
              : [
                  "Outcome-focused guidance",
                  "Practical, real-world perspective",
                  "Honest, structured next steps",
                ]
            ).map((item) => (
              <li key={item}>
                <FiCheck />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </main>
    </PublicLayout>
  );
}
export function ProgramsPage() {
  const { site } = useWorkspaceTheme();
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        <p className="public-kicker">Coaching programs</p>
        <h1>{site?.publicSite?.seoPages?.programsHeading || "Support designed around the work ahead."}</h1>
        <ProgramCards programs={site?.programs} />
      </main>
    </PublicLayout>
  );
}
export function FaqPage() {
  const { site } = useWorkspaceTheme();
  const name = site?.branding?.publicSiteName || site?.workspace?.name || "Ellie's Coaching";
  const questions = site?.publicSite?.faqItems?.length ? site.publicSite.faqItems.map((item) => [item.question, item.answer]) : [
    ["Who are the coaching programs for?", "The programs are designed for aspiring and active multifamily real estate investors who want structured education, practical guidance, and accountability."],
    ["Is coaching available online?", "Yes. Coaching is primarily delivered virtually. Select programs may also include in-person property tours or educational experiences when offered."],
    ["Which program should I choose?", "Review the coaching program pages, then book a discovery call or submit an application so the team can help identify the most appropriate next step."],
    ["Does applying guarantee acceptance?", "No. An application starts a conversation and does not guarantee enrollment in a program."],
    ["What topics are covered?", "Depending on the program, topics may include acquisitions, market analysis, underwriting, capital raising, investor relationships, asset management, and business planning."],
  ];
  return <PublicLayout><main id="main-content" className="public-inner"><p className="public-kicker">Frequently asked questions</p><h1>{site?.publicSite?.seoPages?.faqHeading || "Answers before your next step."}</h1><div className="public-prose">{questions.map(([question, answer]) => <section key={question}><h2>{question}</h2><p>{answer}</p></section>)}<SmartLink className="public-button" to="/book-a-call">Talk with {name}</SmartLink></div></main></PublicLayout>;
}
export function ResourcesPage() {
  const { site } = useWorkspaceTheme();
  return <PublicLayout><main id="main-content" className="public-inner"><p className="public-kicker">Investor resources</p><h1>{site?.publicSite?.seoPages?.resourcesHeading || "Start with the right foundation."}</h1><div className="public-prose"><p>{site?.publicSite?.seoPages?.resourcesCopy || "Explore Ellie’s coaching programs, student experiences, and practical next steps for multifamily real estate investing."}</p><h2>Explore the programs</h2><p>Compare focused six-week coaching and Asset Acquisition Accelerator options.</p><SmartLink className="public-button" to="/coaching-programs">View coaching programs</SmartLink><h2>Hear from students</h2><p>Read published student experiences and results.</p><SmartLink className="public-button" to="/testimonials">View testimonials</SmartLink><h2>Talk through your goals</h2><p>Book a discovery call to discuss where you are and what kind of support may fit.</p><SmartLink className="public-button" to="/book-a-call">Book a discovery call</SmartLink></div></main></PublicLayout>;
}
export function ProgramDetail() {
  const { slug } = useParams();
  const [row, setRow] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        fetchPublicProgram(slug)
          .then(setRow)
          .catch(() => setError("This program is not currently published.")),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [slug]);
  if (!row)
    return (
      <PublicLayout>
        <main id="main-content" className="public-inner">
          {error ? (
            <p className="public-empty">{error}</p>
          ) : (
            <div className="public-loading">Loading program…</div>
          )}
        </main>
      </PublicLayout>
    );
  const base = row.cta?.url || applyPath,
    applyUrl = base.startsWith("/apply")
      ? `${base}${base.includes("?") ? "&" : "?"}program=${encodeURIComponent(row.slug)}`
      : base;
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        <p className="public-kicker">Coaching program</p>
        <h1>{row.title}</h1>
        <p className="public-lead">{row.summary}</p>
        {row.introVideoUrl ? (
          <video
            className="public-program-video"
            src={row.introVideoUrl}
            controls
            preload="metadata"
          />
        ) : null}
        <div className="public-prose">
          <p>{row.description}</p>
          {row.audience ? (
            <>
              <h2>Who it is for</h2>
              <p>{row.audience}</p>
            </>
          ) : null}
          {row.highlights?.length ? (
            <>
              <h2>What to expect</h2>
              <ul>
                {row.highlights.map((item) => (
                  <li key={item}>
                    <FiCheck />
                    {item}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <SmartLink className="public-button" to={applyUrl}>
          {row.cta?.label || "Apply to join"}
        </SmartLink>
        {row.cta?.supportingText ? <p>{row.cta.supportingText}</p> : null}
      </main>
    </PublicLayout>
  );
}
export function TestimonialsPage() {
  const { site } = useWorkspaceTheme();
  const [rows, setRows] = useState([]),
    enabled = site?.publicSite?.sectionVisibility?.testimonials !== false;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (enabled)
        fetchPublicTestimonials()
          .then(setRows)
          .catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled]);
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        {enabled ? (
          <>
            <p className="public-kicker">Student perspectives</p>
            <h1>{site?.publicSite?.seoPages?.testimonialsHeading || "Stories from people doing the work."}</h1>
            {rows.length ? (
              <Testimonials rows={rows} />
            ) : (
              <p className="public-empty">
                Approved student stories will appear here.
              </p>
            )}
          </>
        ) : (
          <p className="public-empty">
            The Results page is not currently published.
          </p>
        )}
      </main>
    </PublicLayout>
  );
}
export function ContactPage() {
  const { site } = useWorkspaceTheme(),
    p = site?.publicSite || {},
    workspaceName =
      site?.branding?.publicSiteName || site?.workspace?.name || "us";
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        <p className="public-kicker">Contact</p>
        <h1>{p.seoPages?.contactHeading || `Start a conversation with ${workspaceName}.`}</h1>
        <div className="contact-panel">
          <div>
            <h2>Program questions</h2>
            <p>
              {p.seoPages?.contactCopy || "Questions before choosing a program? Use the configured contact information below, or submit the secure program application when you are ready."}
            </p>
            {p.contactEmail ? (
              <a href={`mailto:${p.contactEmail}`}>{p.contactEmail}</a>
            ) : (
              <span>Email address awaiting configuration</span>
            )}
            {p.contactPhone ? (
              <a href={`tel:${p.contactPhone}`}>{p.contactPhone}</a>
            ) : null}
          </div>
          <div>
            <h2>Social</h2>
            {p.socialLinks?.length ? (
              p.socialLinks.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.label}
                  <FiExternalLink />
                </a>
              ))
            ) : (
              <span>Social links awaiting configuration</span>
            )}
          </div>
        </div>
      </main>
    </PublicLayout>
  );
}
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

// Pure calendar-grid math (which weekday day N falls on, how many days in
// the month) — deliberately never touches the coach's timezone. A day cell
// only needs to know its own year/month/day to render and to build the same
// "YYYY-MM-DD" key slotsByDay uses; introducing a timezone conversion here
// would risk an off-by-one day in some viewer timezones for no benefit.
function monthGrid(year, month) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

function dayKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// A day's grid cell renders open/blocked directly from real availability
// data (slotsByDay), which the server already computed against the coach's
// actual Google Calendar free/busy — so two students can never even see,
// let alone pick, the same open day/time here.
function AvailabilityCalendar({ slotsByDay, timezone, selectedDay, onSelectDay }) {
  const today = new Date();
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const weeks = useMemo(() => monthGrid(view.year, view.month), [view.year, view.month]);
  const todayKey = useMemo(() => {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    return formatter.format(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone]);
  const canGoBack = view.year > today.getFullYear() || (view.year === today.getFullYear() && view.month > today.getMonth());
  return (
    <div className="discovery-calendar">
      <div className="discovery-calendar__header">
        <button type="button" aria-label="Previous month" disabled={!canGoBack} onClick={() => setView((current) => (current.month === 0 ? { year: current.year - 1, month: 11 } : { year: current.year, month: current.month - 1 }))}>
          <FiChevronLeft />
        </button>
        <strong>{MONTH_LABEL_FORMATTER.format(new Date(view.year, view.month, 1))}</strong>
        <button type="button" aria-label="Next month" onClick={() => setView((current) => (current.month === 11 ? { year: current.year + 1, month: 0 } : { year: current.year, month: current.month + 1 }))}>
          <FiChevronRight />
        </button>
      </div>
      <div className="discovery-calendar__weekdays">
        {WEEKDAY_LABELS.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
      </div>
      <div className="discovery-calendar__grid">
        {weeks.map((week, weekIndex) => week.map((day, dayIndex) => {
          if (!day) return <span key={`${weekIndex}-${dayIndex}`} className="discovery-calendar__cell discovery-calendar__cell--empty" />;
          const key = dayKey(view.year, view.month, day);
          const hasSlots = slotsByDay.has(key);
          const isPast = key < todayKey;
          return (
            <button
              key={key}
              type="button"
              className={`discovery-calendar__cell${hasSlots ? " has-availability" : ""}${key === selectedDay ? " is-selected" : ""}`}
              disabled={!hasSlots || isPast}
              onClick={() => onSelectDay(key)}
            >
              {day}
            </button>
          );
        }))}
      </div>
      <div className="discovery-calendar__legend"><span className="discovery-calendar__dot" /> Available</div>
    </div>
  );
}

export function DiscoveryCallPage() {
  const { site } = useWorkspaceTheme(),
    p = site?.publicSite || {},
    workspaceName = site?.branding?.publicSiteName || site?.workspace?.name || "us",
    programs = site?.programs || [],
    testimonials = site?.featuredTestimonials || [],
    faqs = p.faqItems || [];
  const [availability, setAvailability] = useState(null),
    [selectedDay, setSelectedDay] = useState(""),
    [selected, setSelected] = useState(""),
    [step, setStep] = useState("details"),
    [form, setForm] = useState({
      name: "",
      email: "",
      phone: "",
      notes: "",
      programId: "",
      experience: "",
      primaryGoal: "",
      timeline: "",
      smsConsent: false,
    }),
    [booking, setBooking] = useState(false),
    [result, setResult] = useState(null),
    [bookingError, setBookingError] = useState("");
  const bookingRef = useRef(null);
  const identityComplete = form.name.trim().length > 1 && /^\S+@\S+\.\S+$/.test(form.email);
  const timezone = availability?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const slotsByDay = useMemo(() => {
    const map = new Map();
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (const slot of availability?.slots || []) {
      const key = formatter.format(new Date(slot));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(slot);
    }
    return map;
  }, [availability, timezone]);
  useEffect(() => {
    if (!p.discoveryCallAvailability?.coachProfileId) return;
    fetchDiscoveryCallAvailability().then((data) => {
      setAvailability(data);
      const firstSlot = data.slots?.[0] || "";
      setSelected(firstSlot);
      if (firstSlot) {
        const tz = data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        setSelectedDay(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(firstSlot)));
      }
    }).catch(() => setAvailability({ slots: [] }));
  }, [p.discoveryCallAvailability?.coachProfileId]);
  const submitBooking = async (event) => {
    event.preventDefault();
    if (step !== "time") {
      showTimes();
      return;
    }
    setBooking(true); setBookingError("");
    try {
      const data = await bookDiscoveryCall({
        name: form.name,
        email: form.email,
        phone: form.phone,
        notes: form.notes,
        programId: form.programId,
        smsConsent: form.smsConsent,
        qualification: {
          experience: form.experience,
          primaryGoal: form.primaryGoal,
          timeline: form.timeline,
        },
        startsAt: selected,
      });
      setResult(data);
      trackSiteEvent("discovery_call_booked", { starts_at: selected, program_id: form.programId });
    }
    catch (error) { setBookingError(error?.response?.data?.error || "We couldn't reserve that time. Please choose another time and try again."); }
    finally { setBooking(false); }
  };
  const beginBooking = (programId = form.programId) => {
    if (programId) setForm((current) => ({ ...current, programId }));
    bookingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const showTimes = () => {
    if (!form.name.trim() || !/^\S+@\S+\.\S+$/.test(form.email) || !form.programId || !form.primaryGoal.trim()) {
      setBookingError("Choose a program and complete your name, email, and primary goal before selecting a time.");
      return;
    }
    setBookingError("");
    setStep("time");
    window.setTimeout(() => bookingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const bookingEmbedUrl = (() => {
    // Google's own documented format for embedding an Appointment Schedule
    // booking page inline (not just linking out to it) — gv=true is what
    // makes the embedded view interactive/bookable rather than a bare
    // read-only calendar. Falls back to no embed (plain link only) if the
    // saved URL isn't well-formed, rather than rendering a broken iframe.
      if (!p.discoveryCallBookingUrl) return "";
      try {
        const url = new URL(p.discoveryCallBookingUrl);
        url.searchParams.set("gv", "true");
        return url.toString();
      } catch {
        return "";
      }
    })();
  return (
    <PublicLayout>
      <main id="main-content" className="discovery-call-page">
        <section className="discovery-hero">
          <div className="discovery-hero__topline">
            <span>Private strategy conversation with {workspaceName}</span>
            <button type="button" onClick={() => beginBooking()}>Book your discovery call <FiArrowRight /></button>
          </div>
          <div className="discovery-hero__content">
            <p className="discovery-hero__audience"><span /> For real estate investors ready to take focused action</p>
            <h1>{p.discoveryCallHeading || "Book a Discovery Call"}</h1>
            <p>{p.discoveryCallCopy || "Tell us where you are in your investing journey. Meet with Ellie, ask honest questions, and identify the coaching path or next step that fits your goals."}</p>
            <div className="discovery-hero__actions">
              <button className="public-button" type="button" onClick={() => beginBooking()}>Find your next step</button>
              <span><FiCheck /> No-pressure fit conversation</span>
            </div>
          </div>
          {p.discoveryCallVideoUrl ? (
            <div className="discovery-call-page__video">
              <TestimonialVideoPlayer videoUrl={p.discoveryCallVideoUrl} coverUrl={p.discoveryCallVideoPosterUrl} />
            </div>
          ) : null}
        </section>

        <section className="discovery-booking-section" ref={bookingRef}>
          <div className="discovery-section-heading">
            <p className="public-kicker">Limited weekly appointments</p>
            <h2>Book your discovery call</h2>
          </div>
        {p.discoveryCallAvailability?.coachProfileId ? (
          result ? <section className="discovery-booking-success"><span className="discovery-booking-success__icon"><FiCheck /></span><p className="public-kicker">You’re scheduled</p><h2>Your call is booked.</h2><p>A Google Calendar invitation and meeting details have been sent to your email for {new Date(result.startsAt).toLocaleString()}.</p></section> :
          <form className="discovery-booking-form" onSubmit={submitBooking}>
            <div className="discovery-booking-form__steps" aria-label="Booking progress">
              <button type="button" className={step === "details" ? "is-active" : "is-complete"} onClick={() => setStep("details")}><span>{step === "time" ? <FiCheck /> : "1"}</span>Your details</button>
              <i />
              <button type="button" className={step === "time" ? "is-active" : ""} disabled={step !== "time"}><span>2</span>Choose a time</button>
            </div>
            {step === "details" ? <div className="discovery-booking-form__panel">
              <div className="discovery-booking-form__title"><span>1</span><div><h3>Discovery call</h3><p>Start with your name and email. The remaining questions will open automatically.</p></div></div>
              <div className="discovery-booking-form__identity"><label>Full name<input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your full name" /></label><label>Email address<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label></div>
              {identityComplete ? <div className="discovery-booking-form__additional">
                <h4>Additional information</h4>
                <fieldset><legend>Which program would you like to discuss?</legend><div className="discovery-booking-form__choices">{programs.map((program) => <label key={program.id}><input required type="radio" name="programId" value={program.id} checked={form.programId === String(program.id)} onChange={(event) => setForm({ ...form, programId: event.target.value })} /><span>{program.title}</span></label>)}<label><input required type="radio" name="programId" value="not_sure" checked={form.programId === "not_sure"} onChange={(event) => setForm({ ...form, programId: event.target.value })} /><span>I’m not sure — help me choose</span></label></div></fieldset>
                <fieldset><legend>How much investing experience do you have?</legend><div className="discovery-booking-form__choices">{["Exploring my first investment", "Actively pursuing my first deal", "I own one or more properties", "I’m ready to scale my portfolio"].map((option) => <label key={option}><input type="radio" name="experience" value={option} checked={form.experience === option} onChange={(event) => setForm({ ...form, experience: event.target.value })} /><span>{option}</span></label>)}</div></fieldset>
                <label>What is the primary goal you want help with?<textarea required value={form.primaryGoal} onChange={(event) => setForm({ ...form, primaryGoal: event.target.value })} placeholder="Tell Ellie what you want to accomplish and what is getting in the way." /></label>
                <fieldset><legend>When are you hoping to take action?</legend><div className="discovery-booking-form__choices">{["As soon as possible", "Within the next 30 days", "Within the next 3 months", "I’m researching for later"].map((option) => <label key={option}><input type="radio" name="timeline" value={option} checked={form.timeline === option} onChange={(event) => setForm({ ...form, timeline: event.target.value })} /><span>{option}</span></label>)}</div></fieldset>
                <label>Phone (optional)<input type="tel" autoComplete="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
                <label>Anything else Ellie should know? (optional)<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
                {form.phone ? <label className="discovery-booking-form__sms-consent"><input type="checkbox" checked={form.smsConsent} onChange={(event) => setForm({ ...form, smsConsent: event.target.checked })} /> I agree to receive text messages about my discovery call and future updates. Message and data rates may apply. Reply STOP to opt out.</label> : null}
                {bookingError ? <p className="form-error">{bookingError}</p> : null}
                <button className="public-button discovery-booking-form__continue" type="button" onClick={showTimes}>Accept and choose a time <FiArrowRight /></button>
              </div> : null}
            </div> : <div className="discovery-booking-form__panel">
              <div className="discovery-booking-form__title"><span>2</span><div><h3>Choose an available time</h3><p>All available times are shown in {timezone}.</p></div></div>
              {availability?.slots?.length ? <><AvailabilityCalendar slotsByDay={slotsByDay} timezone={timezone} selectedDay={selectedDay} onSelectDay={(key) => { setSelectedDay(key); setSelected(slotsByDay.get(key)?.[0] || ""); }} />{selectedDay && slotsByDay.has(selectedDay) ? <div className="discovery-calendar__times"><label>Available times on {new Date(`${selectedDay}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</label><div className="discovery-calendar__time-grid">{slotsByDay.get(selectedDay).map((slot) => <button key={slot} type="button" className={`discovery-calendar__time${slot === selected ? " is-selected" : ""}`} onClick={() => setSelected(slot)}>{new Date(slot).toLocaleString([], { hour: "numeric", minute: "2-digit" })}</button>)}</div><small>{new Date(selected || slotsByDay.get(selectedDay)[0]).toLocaleString([], { timeZoneName: "short" }).split(", ").pop()}</small></div> : <p className="discovery-calendar__prompt">Pick a highlighted day above to see available times.</p>}{bookingError ? <p className="form-error">{bookingError}</p> : null}<button className="public-button discovery-booking-form__continue" disabled={booking || !selected}>{booking ? "Reserving…" : "Confirm discovery call"}</button></> : availability ? <p>No appointment times are currently available. Please check again soon or contact {workspaceName}.</p> : <p>Loading available times…</p>}
            </div>}
          </form>
        ) : bookingEmbedUrl ? (
          <>
            <div className="discovery-call-page__booking">
              <iframe
                src={bookingEmbedUrl}
                title={p.discoveryCallButtonLabel || "Book a Discovery Call"}
                loading="lazy"
              />
            </div>
            <a
              className="discovery-call-page__fallback-link"
              href={p.discoveryCallBookingUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackSiteEvent("discovery_call_booking_click", {})}
            >
              Trouble booking above? Open in Google Calendar directly
              <FiExternalLink />
            </a>
          </>
        ) : (
          <p className="discovery-call-page__pending">
            Booking isn't set up yet. Contact {workspaceName} directly to schedule a call.
          </p>
        )}
        </section>

        <section className="discovery-editorial">
          <h2>The problem</h2>
          <p className="discovery-editorial__lead">Information is everywhere. The hard part is turning what you know into a focused plan—and following that plan long enough to create momentum.</p>
          <p>You may know you want to invest in multifamily real estate, raise capital, improve your acquisitions process, or manage an existing asset more effectively. But when every decision depends on you figuring out the next step alone, it is easy to stay busy without moving forward.</p>
          <p>A discovery call gives you space to explain where you are, what you have already tried, and what outcome you are working toward. Ellie can then help you separate the immediate priority from everything that can wait.</p>
        </section>

        <section className="discovery-editorial discovery-editorial--soft">
          <h2>Why this isn’t another course</h2>
          <p className="discovery-editorial__lead">Ellie’s programs are built around guided implementation, direct feedback, and accountability—not simply handing you more information.</p>
          <p>The right program depends on your current experience and the problem you need to solve. The booking form shows every active coaching option in one clear list. If you are unsure, choose <strong>“I’m not sure—help me choose.”</strong></p>
          <h3>What we’ll cover on the call</h3>
          <ul className="discovery-editorial__list">
            <li><FiCheck /><div><strong>Your current position</strong><span>What you have done so far and where progress has slowed.</span></div></li>
            <li><FiCheck /><div><strong>Your investing goal</strong><span>The outcome you want and the timeline you are working with.</span></div></li>
            <li><FiCheck /><div><strong>The right coaching path</strong><span>Which of Ellie’s programs best matches the support you need now.</span></div></li>
            <li><FiCheck /><div><strong>Your next step</strong><span>A clear direction for moving forward after the conversation.</span></div></li>
          </ul>
        </section>

        <section className="discovery-editorial">
          <h2>Who this is for</h2>
          <p className="discovery-editorial__lead">This conversation is for people who are serious about taking action and want practical guidance from someone who understands the work.</p>
          <p>You do not need to know which program is right before you book. You do need to be willing to speak honestly about your goals, your current obstacles, and the support you need to move forward.</p>
          <button className="public-button" type="button" onClick={() => beginBooking()}>Choose your program and time <FiArrowRight /></button>
        </section>

        {testimonials.length ? <section className="discovery-proof-section"><div className="discovery-section-heading"><p className="public-kicker">Student perspectives</p><h2>Hear from people who chose to move forward.</h2></div><Testimonials rows={testimonials} /></section> : null}

        {faqs.length ? <section className="discovery-faq-section"><div className="discovery-section-heading"><p className="public-kicker">Before you book</p><h2>Questions about the discovery call</h2></div><div className="discovery-faq-list">{faqs.slice(0, 6).map((item) => <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section> : null}

        <section className="discovery-final-cta"><p className="public-kicker">Your next move can be clearer</p><h2>Let’s talk through the path that fits you.</h2><p>Choose a program or select “help me choose,” share your goals, and reserve a time that works.</p><button className="public-button" type="button" onClick={() => beginBooking()}>Book your discovery call <FiArrowRight /></button></section>
      </main>
    </PublicLayout>
  );
}
export function PublicProfilePage() {
  const { slug } = useParams();
  const [row, setRow] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        fetchPublicProfile(slug)
          .then(setRow)
          .catch(() => setError("This profile is private or unavailable.")),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [slug]);
  return (
    <PublicLayout>
      <main
        id="main-content"
        className={`profile-page profile-page--${row?.layout || "executive"}`}
      >
        {error ? (
          <p className="public-empty">{error}</p>
        ) : row ? (
          <>
            <header>
              {row.avatarUrl ? (
                <img src={cloudinaryImage(row.avatarUrl, 192)} alt={row.displayName} />
              ) : (
                <span>{row.displayName.slice(0, 2).toUpperCase()}</span>
              )}
              <div>
                <p>{row.publicTitle || row.ownerType}</p>
                <h1>{row.displayName}</h1>
                <h2>{row.headline}</h2>
                {row.publicLocation ? (
                  <small>
                    <FiMapPin />
                    {row.publicLocation}
                  </small>
                ) : null}
              </div>
            </header>
            {row.bio ? (
              <section>
                <h2>About</h2>
                <p>{row.bio}</p>
              </section>
            ) : null}
            {row.specialties?.length ? (
              <section>
                <h2>Focus</h2>
                <div className="profile-tags">
                  {row.specialties.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </section>
            ) : null}
            {row.goals?.length ? (
              <section>
                <h2>Goals</h2>
                <div className="profile-tags">
                  {row.goals.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </section>
            ) : null}
            {row.experience ? (
              <section>
                <h2>Experience</h2>
                <p>{row.experience}</p>
              </section>
            ) : null}
            <section className="profile-links">
              {row.websiteUrl ? (
                <a href={row.websiteUrl}>
                  Website
                  <FiExternalLink />
                </a>
              ) : null}
              {row.socialLinks.map((link) => (
                <a key={link.url} href={link.url}>
                  {link.label}
                  <FiExternalLink />
                </a>
              ))}
              {row.cta?.url ? (
                <SmartLink className="public-button" to={row.cta.url}>
                  {row.cta.label || "Connect"}
                </SmartLink>
              ) : null}
            </section>
          </>
        ) : (
          <div className="public-loading">Loading profile…</div>
        )}
      </main>
    </PublicLayout>
  );
}
