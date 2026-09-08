import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  FiArrowRight,
  FiCheck,
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
  fetchPublicProfile,
  fetchPublicProgram,
  fetchPublicTestimonials,
} from "../services/api.js";
import { cloudinaryImage } from "../utils/cloudinaryImage.js";
import "./PublicSite.css";
import "./PublicEnhancements.css";

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
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [open]);

  const query = new URLSearchParams({
    embed: "1",
    ...(program ? { program } : {}),
  });
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open ? (
        <div
          className="program-application-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Program application"
          onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
        >
          <div>
            <header>
              <div>
                <p className="public-kicker">Program application</p>
                <h2>Start your application</h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close application"
              >
                <FiX />
              </button>
            </header>
            <iframe title="Program application" src={`/apply?${query}`} />
          </div>
        </div>
      ) : null}
    </>
  );
}
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
      className="public-site"
      data-public-theme={theme}
      style={{
        "--public-base-size": `${site?.publicSite?.baseFontSize || 16}px`,
        "--public-heading-scale": site?.publicSite?.headingScale || 1,
        "--public-heading-font":
          site?.publicSite?.headingFont === "modern"
            ? '"DM Sans",ui-sans-serif,system-ui,sans-serif'
            : '"Instrument Serif",Georgia,serif',
        "--public-body-font":
          site?.publicSite?.bodyFont === "classic"
            ? '"Instrument Serif",Georgia,serif'
            : '"DM Sans",ui-sans-serif,system-ui,sans-serif',
      }}
    >
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
    closeRef = useRef(null);
  useEffect(() => {
    if (!applying) return undefined;
    closeRef.current?.focus();
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [applying]);
  if (!programs.length)
    return <p className="public-empty">No programs are currently published.</p>;

  const orderedPrograms = [...programs].sort(
    (left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0),
  );
  const featured = orderedPrograms.filter(
    (program) => Number(program.price?.amount || 0) >= 10000,
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
    const text = `${program.title || ""} ${program.summary || ""}`;
    if (/one[- ]on[- ]one|1[- ]on[- ]1/i.test(text)) return "ONE-ON-ONE";
    if (/bootcamp/i.test(text)) return "BOOTCAMP";
    return "COACHING";
  };

  return (
    <>
      <div className="public-curriculum-group">
        <div className="public-curriculum-label">
          HIGH PERFORMANCE ACCELERATORS
        </div>
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
                    alt={`${program.title} program`}
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
                <div className="public-accelerator-meta">
                  {program.duration?.value || ""} {program.duration?.unit || ""}
                  {program.duration?.value ? " · " : ""}
                  {formatLabel(program)}
                </div>
                <div className="public-accelerator-title">{program.title}</div>
                {expanded === String(program.id) ? (
                  <div
                    className="public-accelerator-desc"
                    id={`program-details-${program.id}`}
                  >
                    {program.description || program.summary}
                  </div>
                ) : null}
                <div className="public-accelerator-footer">
                  <span className="public-accelerator-price">
                    {program.price?.amount != null
                      ? new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: program.price.currency || "USD",
                          maximumFractionDigits: 0,
                        }).format(program.price.amount)
                      : "Contact us"}
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
                {expanded === String(program.id) ? (
                  <button
                    type="button"
                    className="public-program-apply"
                    onClick={() => setApplying(program)}
                  >
                    Apply to program <FiArrowRight />
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
      {intensive.length > 0 && (
        <div className="public-curriculum-group">
          <div className="public-curriculum-label">
            INTENSIVE 6-WEEK PROGRAMS
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
                      alt={`${program.title} program`}
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
                      {program.price?.amount != null
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: program.price.currency || "USD",
                            maximumFractionDigits: 0,
                          }).format(program.price.amount)
                        : "Contact us"}
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
                  {expanded === String(program.id) ? (
                    <button
                      type="button"
                      className="public-program-apply"
                      onClick={() => setApplying(program)}
                    >
                      Apply to program <FiArrowRight />
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
      {applying ? (
        <div
          className="program-application-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="program-application-title"
          onKeyDown={(event) => event.key === "Escape" && setApplying(null)}
        >
          <div>
            <header>
              <div>
                <p className="public-kicker">Program application</p>
                <h2 id="program-application-title">
                  Apply for {applying.title}
                </h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setApplying(null)}
                aria-label="Close application"
              >
                <FiX />
              </button>
            </header>
            <iframe
              title={`Application for ${applying.title}`}
              src={`/apply?program=${encodeURIComponent(applying.slug || applying.id)}&embed=1`}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
function Testimonials({ rows = [] }) {
  return (
    <div className="testimonial-grid">
      {rows.map((row, index) => (
        <blockquote className={index === 0 ? "is-featured" : ""} key={row.id}>
          {row.avatarUrl && !row.videoUrl ? (
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
          <p>"{row.body}"</p>
          {row.resultContext ? <small>{row.resultContext}</small> : null}
          <footer>
            <strong>{row.displayName}</strong>
            {row.headline ? <span>{row.headline}</span> : null}
          </footer>
          {row.videoUrl ? (
            <video
              className="testimonial-video-player"
              src={row.videoUrl}
              poster={row.avatarUrl ? cloudinaryImage(row.avatarUrl, 800) : undefined}
              controls
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              playsInline
              preload="metadata"
              onContextMenu={(event) => event.preventDefault()}
            />
          ) : null}
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
  useEffect(() => {
    if (playing) closeRef.current?.focus();
  }, [playing]);
  if (!p.introVideoUrl && !p.introVideoPosterUrl) return null;
  return (
    <>
      <button
        type="button"
        className="public-hero__video"
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
      {playing ? (
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
      ) : null}
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
    // CHANGED: was the unconditional literal "WHY ELLIE COACHING".
    // For Ellie, set introLabel: "WHY ELLIE COACHING".
    introLabel = p.introLabel || "WHY CHOOSE US",
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
        <section className="public-hero-section">
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
                to={showPrograms ? "#programs" : p.primaryCtaUrl || "#contact"}
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
            {visibility.video !== false ? <HeroVideoTile site={site} /> : null}
          </div>
          <div className="public-hero-right">
            <div className="public-hero-img-box">
              {heroImage ? (
                <img
                  className="public-hero-img"
                  src={cloudinaryImage(heroImage, 960)}
                  alt=""
                />
              ) : (
                <div
                  className="public-hero-image-placeholder"
                  aria-hidden="true"
                />
              )}
              <div className="public-hero-quote-box">
                <span className="public-hero-quote">
                  "
                  {p.heroTagline ||
                    "Learn what works, build momentum, and get results."}
                  "
                </span>
                <small>— {heroQuoteAttribution}</small>
              </div>
            </div>
          </div>
        </section>

        <section className="public-why-section" id="about">
          <div className="public-why-title-block">
            <span className="public-why-label">{introLabel}</span>
            <h2 className="public-why-title">
              <EditorialHeading text={p.introTitle} accent={introTitleAccent} />
            </h2>
            <div className="public-why-desc">{p.introBody}</div>
          </div>
          <div className="public-why-features">
            {(p.valuePropositions || []).map((row, index) => (
              <div className="public-why-feature" key={`${row.title}-${index}`}>
                <div className="public-why-feature-num">
                  {String(index + 1).padStart(2, "0")}
                </div>
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
              COMMUNITY
            </p>
            <div>
              <p className="public-kicker">After enrollment</p>
              <h2>{p.communityTitle}</h2>
              <p>{p.communityBody}</p>
              {p.communityCtaLabel && p.communityCtaUrl ? (
                <SmartLink className="public-text-link" to={p.communityCtaUrl}>
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
        <h1>Experience, perspective, and practical support.</h1>
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
        <h1>Support designed around the work ahead.</h1>
        <ProgramCards programs={site?.programs} />
      </main>
    </PublicLayout>
  );
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
    enabled = site?.publicSite?.sectionVisibility?.results === true;
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
            <h1>Stories from people doing the work.</h1>
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
        <h1>Start a conversation with {workspaceName}.</h1>
        <div className="contact-panel">
          <div>
            <h2>Program questions</h2>
            <p>
              Questions before choosing a program? Use the configured contact
              information below, or submit the secure program application when
              you are ready.
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
