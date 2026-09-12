const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const CoachingProgram = require("../models/CoachingProgram");
const CoachProfile = require("../models/CoachProfile");
const Testimonial = require("../models/Testimonial");
const PublicProfile = require("../models/PublicProfile");
const Event = require("../models/Event");
const EditToken = require("../models/PublicProfileEditToken");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const deps = {
  Workspace,
  WorkspaceConfig,
  WorkspaceMembership,
  CoachingProgram,
  CoachProfile,
  Testimonial,
  PublicProfile,
  Event,
  EditToken,
};
const COLOR = /^#[0-9a-f]{6}$/i,
  SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function safeColor(value, fallback) {
  return COLOR.test(String(value || ""))
    ? String(value).toLowerCase()
    : fallback;
}
function safeUrl(value, { relative = false } = {}) {
  const raw = String(value || "").trim();
  if (relative && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}
function strings(values, max = 12) {
  return (Array.isArray(values) ? values : [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, max);
}
function links(values) {
  return (Array.isArray(values) ? values : [])
    .map((v) => ({
      label: String(v.label || "")
        .trim()
        .slice(0, 60),
      url: safeUrl(v.url),
    }))
    .filter((v) => v.label && v.url)
    .slice(0, 12);
}
function defaults(workspace) {
  const ellie =
      workspace?.slug === (process.env.ELLIE_WORKSPACE_SLUG || "ellie"),
    visibility = {
      video: true,
      proof: true,
      programs: true,
      journey: true,
      team: true,
      testimonials: true,
      event: true,
      community: true,
      // Ellie asked for the hero heading/subhead/buttons, the hero photo,
      // and the pull-quote gone entirely — only the video should show in
      // the hero. These stay a per-workspace default (not a code-wide
      // change: `genericVisibility` below keeps every other workspace's
      // hero fully visible) and are still editable from Public Site
      // Admin > Homepage > Visible sections if that ever needs to change.
      heroCopy: false,
      heroImage: false,
      heroQuote: false,
    },
    genericVisibility = {
      video: false,
      proof: false,
      programs: false,
      journey: false,
      team: false,
      testimonials: false,
      event: false,
      community: false,
      heroCopy: true,
      heroImage: true,
      heroQuote: true,
    };
  return ellie
    ? {
        branding: {
          logoUrl: "/elliescoachinglogo.png",
          publicSiteLogoUrl: "/elliescoachinglogo.png",
          primaryColor: "#0a0a0a",
          accentColor: "#8bc53f",
          surfaceMode: "charcoal",
          publicSiteName: "Ellie's Coaching",
          poweredByGrowthOperator: false,
        },
        publicSite: {
          published: true,
          eyebrow: "Multifamily investing · coaching · execution",
          headline:
            "Build the skills, confidence, and operating discipline to invest in multifamily real estate.",
          subheadline:
            "Practical coaching for investors ready to move from information to focused execution.",
          introTitle: "Coaching built for real operators",
          introBody:
            "Learn alongside experienced multifamily operators through structured programs, clear next steps, and accountable support.",
          introVideoEyebrow: "Meet Ellie",
          introVideoTitle: "Start with the people behind the program.",
          introVideoCopy:
            "Hear how Ellie Coaching approaches education, accountability, and the work of becoming an operator.",
          primaryCtaLabel: "Apply to join",
          primaryCtaUrl: "/apply",
          finalCtaEyebrow: "Your next move",
          finalCtaTitle:
            "Choose the program that fits your goals, then tell us where you are today.",
          finalCtaCopy:
            "A program application starts a conversation. It does not guarantee enrollment.",
          finalCtaLabel: "Start your application",
          finalCtaUrl: "/apply",
          communityTitle: "The program continues in community.",
          communityBody:
            "Once enrolled and connected, students use Skool for program learning and community while the coaching team provides guidance through the work.",
          heroOverline: "Structured programs",
          heroTagline: "Real people · practical work · accountable progress",
          aboutEyebrow: "Why Ellie Coaching",
          aboutTitle: "Experience, perspective, and practical support.",
          valuePropositions: [
            {
              title: "Practical education",
              body: "Turn multifamily concepts into decisions and next steps you can actually work through.",
            },
            {
              title: "Specialist guidance",
              body: "Learn with experienced people whose perspectives support different parts of the process.",
            },
            {
              title: "Structured progression",
              body: "Move through a defined program with continuity, accountability, and a clear view of what comes next.",
            },
          ],
          programsEyebrow: "Programs",
          programsTitle: "Choose the support that meets you where you are.",
          journeyEyebrow: "Your path",
          journeyTitle: "From exploring a program to doing the work.",
          journeyCopy:
            "Applying starts a conversation. Enrollment is not automatic or guaranteed.",
          journeySteps: [
            "Explore the programs",
            "Submit a program application",
            "Speak with Ellie’s team",
            "Join the appropriate program",
            "Enter the Skool community",
            "Work with your coaching team",
          ],
          eventEyebrow: "Upcoming training",
          eventCtaLabel: "Event details",
          allowThemeToggle: false,
          headingFont: "editorial",
          bodyFont: "modern",
          baseFontSize: 16,
          headingScale: 1,
          sectionVisibility: visibility,
          trustMetrics: [],
          footerText:
            "Multifamily coaching for investors ready to operate with intention.",
        },
      }
    : {
        branding: {
          logoUrl: "",
          publicSiteLogoUrl: "",
          primaryColor: "#102a24",
          accentColor: "#d7a93d",
          surfaceMode: "light",
          publicSiteName: workspace?.name || "Lead Porch",
          poweredByGrowthOperator: false,
        },
        publicSite: {
          published: false,
          eyebrow: "Lead generation for the long game",
          headline: "Turn good leads into deliberate growth.",
          subheadline:
            "A focused operating system for teams that want clearer priorities, better follow-up, and measurable momentum.",
          introTitle: "Make every opportunity easier to act on.",
          introBody:
            "Lead Porch brings your people, pipeline, conversations, and campaigns into one calm operating rhythm.",
          primaryCtaLabel: "Start a conversation",
          primaryCtaUrl: "/apply",
          finalCtaEyebrow: "Build your next growth system",
          finalCtaTitle: "Good growth gets easier when the work is visible.",
          finalCtaCopy:
            "Create a clearer path from first conversation to lasting relationship.",
          finalCtaLabel: "Talk with Lead Porch",
          finalCtaUrl: "/apply",
          communityTitle: "The work continues after the first yes.",
          communityBody:
            "Keep follow-up, shared context, and next steps close to the relationships that matter.",
          heroOverline: "A practical growth workspace",
          heroTagline: "Clear signals · useful systems · steady progress",
          aboutEyebrow: "About",
          aboutTitle: "",
          valuePropositions: [],
          programsEyebrow: "Programs",
          programsTitle: "",
          journeyEyebrow: "Your path",
          journeyTitle: "",
          journeyCopy: "",
          journeySteps: [],
          eventEyebrow: "Upcoming",
          eventCtaLabel: "Event details",
          allowThemeToggle: false,
          headingFont: "editorial",
          bodyFont: "modern",
          baseFontSize: 16,
          headingScale: 1,
          sectionVisibility: genericVisibility,
          trustMetrics: [],
          footerText: "",
        },
      };
}
function cleanMetrics(values) {
  return (Array.isArray(values) ? values : [])
    .map((row) => ({
      value: String(row?.value || "")
        .trim()
        .slice(0, 80),
      label: String(row?.label || "")
        .trim()
        .slice(0, 120),
    }))
    .filter((row) => row.value && row.label)
    .slice(0, 8);
}
function sanitizedConfig(workspace, config) {
  const base = defaults(workspace),
    b = config?.branding || {},
    p = config?.publicSite || {},
    a = config?.appBranding || {},
    visibility = {
      ...base.publicSite.sectionVisibility,
      ...(p.sectionVisibility || {}),
    },
    ellie = workspace?.slug === (process.env.ELLIE_WORKSPACE_SLUG || "ellie"),
    moduleAccess = ellie
      ? { coaching: true, ambassadors: true, publicProof: true }
      : {
          coaching: config?.moduleAccess?.coaching === true,
          ambassadors: config?.moduleAccess?.ambassadors === true,
          publicProof: config?.moduleAccess?.publicProof === true,
        },
    contactEmail =
      ellie &&
      (!p.contactEmail ||
        String(p.contactEmail).toLowerCase() === "support@elliescoaching.com")
        ? "team@elliescoaching.com"
        : p.contactEmail || "";
  const effectiveVisibility = {
    ...visibility,
    ...(moduleAccess.coaching
      ? {}
      : {
          video: false,
          programs: false,
          journey: false,
          team: false,
          event: false,
          community: false,
        }),
    ...(moduleAccess.publicProof
      ? {}
      : { proof: false, testimonials: false, results: false }),
  };
  return {
    workspace: { name: workspace.name, slug: workspace.slug },
    moduleAccess,
    branding: {
      logoUrl: safeUrl(b.logoUrl || base.branding.logoUrl, { relative: true }),
      faviconUrl: safeUrl(b.faviconUrl, { relative: true }),
      primaryColor: safeColor(b.primaryColor, base.branding.primaryColor),
      accentColor: safeColor(b.accentColor, base.branding.accentColor),
      surfaceMode: ["light", "dark", "charcoal"].includes(b.surfaceMode)
        ? b.surfaceMode
        : base.branding.surfaceMode,
      publicSiteName: String(
        b.publicSiteName || base.branding.publicSiteName,
      ).slice(0, 160),
      publicSiteLogoUrl: safeUrl(
        b.publicSiteLogoUrl || b.logoUrl || base.branding.publicSiteLogoUrl,
        { relative: true },
      ),
      publicSiteLogoDarkUrl: safeUrl(b.publicSiteLogoDarkUrl, {
        relative: true,
      }),
      poweredByGrowthOperator:
        b.poweredByGrowthOperator ?? base.branding.poweredByGrowthOperator,
    },
    appBranding: {
      logoUrl: safeUrl(a.logoUrl || config?.organizationLogoUrl || "", {
        relative: true,
      }),
      logoLightUrl: safeUrl(a.logoLightUrl || "", { relative: true }),
      logoDarkUrl: safeUrl(a.logoDarkUrl || "", { relative: true }),
      compactLogoUrl: safeUrl(a.compactLogoUrl || "", { relative: true }),
      faviconUrl: safeUrl(a.faviconUrl || "", { relative: true }),
      sidebarBackgroundColor: safeColor(a.sidebarBackgroundColor, "#102a24"),
      sidebarTextColor: safeColor(a.sidebarTextColor, "#f7faf8"),
      headerColor: safeColor(a.headerColor, "#ffffff"),
      primaryActionColor: safeColor(a.primaryActionColor, "#16624f"),
      accentColor: safeColor(a.accentColor, "#8bc53f"),
      backgroundColor: safeColor(a.backgroundColor, "#f5f7f6"),
      surfaceMode: ["light", "dark", "system"].includes(a.surfaceMode)
        ? a.surfaceMode
        : "light",
    },
    publicSite: {
      published: p.published ?? base.publicSite.published,
      eyebrow: String(p.eyebrow || base.publicSite.eyebrow || "").slice(0, 160),
      headline: String(p.headline || base.publicSite.headline).slice(0, 300),
      subheadline: String(p.subheadline || base.publicSite.subheadline).slice(
        0,
        1200,
      ),
      introTitle: String(p.introTitle || base.publicSite.introTitle).slice(
        0,
        300,
      ),
      headlineAccent: String(p.headlineAccent || "").slice(0, 160),
      introTitleAccent: String(p.introTitleAccent || "").slice(0, 160),
      introLabel: String(p.introLabel || "").slice(0, 160),
      introBody: String(p.introBody || base.publicSite.introBody).slice(
        0,
        5000,
      ),
      aboutBody: String(p.aboutBody || "").slice(0, 12000),
      aboutQuote: String(p.aboutQuote || "").slice(0, 1200),
      heroQuoteAttribution: String(p.heroQuoteAttribution || "").slice(0, 160),
      aboutImageUrl: safeUrl(p.aboutImageUrl),
      heroMediaUrl: safeUrl(p.heroMediaUrl),
      heroMediaAlt: String(p.heroMediaAlt || "").slice(0, 300),
      stickyBackgroundUrl: safeUrl(p.stickyBackgroundUrl),
      stickyBackgroundAlt: String(p.stickyBackgroundAlt || "").slice(0, 300),
      introVideoUrl: safeUrl(p.introVideoUrl),
      introVideoPosterUrl: safeUrl(p.introVideoPosterUrl),
      introVideoAlt: String(p.introVideoAlt || "").slice(0, 300),
      introVideoEyebrow: String(
        p.introVideoEyebrow || base.publicSite.introVideoEyebrow || "",
      ).slice(0, 160),
      introVideoTitle: String(
        p.introVideoTitle || base.publicSite.introVideoTitle || "",
      ).slice(0, 300),
      introVideoCopy: String(
        p.introVideoCopy || base.publicSite.introVideoCopy || "",
      ).slice(0, 1200),
      primaryCtaLabel: String(
        p.primaryCtaLabel || base.publicSite.primaryCtaLabel,
      ).slice(0, 80),
      primaryCtaUrl: safeUrl(p.primaryCtaUrl || base.publicSite.primaryCtaUrl, {
        relative: true,
      }),
      secondaryCtaLabel: String(p.secondaryCtaLabel || "").slice(0, 80),
      secondaryCtaUrl: safeUrl(p.secondaryCtaUrl, { relative: true }),
      finalCtaEyebrow: String(
        p.finalCtaEyebrow || base.publicSite.finalCtaEyebrow || "",
      ).slice(0, 160),
      finalCtaTitle: String(
        p.finalCtaTitle || base.publicSite.finalCtaTitle || "",
      ).slice(0, 400),
      finalCtaCopy: String(
        p.finalCtaCopy || base.publicSite.finalCtaCopy || "",
      ).slice(0, 1200),
      finalCtaLabel: String(
        p.finalCtaLabel || base.publicSite.finalCtaLabel || "",
      ).slice(0, 80),
      finalCtaUrl: safeUrl(p.finalCtaUrl || base.publicSite.finalCtaUrl || "", {
        relative: true,
      }),
      communityTitle: String(
        p.communityTitle || base.publicSite.communityTitle || "",
      ).slice(0, 300),
      communityBody: String(
        p.communityBody || base.publicSite.communityBody || "",
      ).slice(0, 3000),
      communityCtaLabel: String(p.communityCtaLabel || "").slice(0, 80),
      communityCtaUrl: safeUrl(p.communityCtaUrl || "", { relative: true }),
      heroOverline: String(
        p.heroOverline || base.publicSite.heroOverline || "",
      ).slice(0, 160),
      heroTagline: String(
        p.heroTagline || base.publicSite.heroTagline || "",
      ).slice(0, 300),
      aboutEyebrow: String(
        p.aboutEyebrow || base.publicSite.aboutEyebrow || "",
      ).slice(0, 160),
      aboutTitle: String(
        p.aboutTitle || base.publicSite.aboutTitle || "",
      ).slice(0, 300),
      valuePropositions: (Array.isArray(p.valuePropositions) &&
      p.valuePropositions.length
        ? p.valuePropositions
        : base.publicSite.valuePropositions || []
      )
        .slice(0, 6)
        .map((row) => ({
          title: String(row?.title || "")
            .trim()
            .slice(0, 160),
          body: String(row?.body || "")
            .trim()
            .slice(0, 800),
        }))
        .filter((row) => row.title && row.body),
      programsEyebrow: String(
        p.programsEyebrow || base.publicSite.programsEyebrow || "",
      ).slice(0, 160),
      programsTitle: String(
        p.programsTitle || base.publicSite.programsTitle || "",
      ).slice(0, 300),
      journeyEyebrow: String(
        p.journeyEyebrow || base.publicSite.journeyEyebrow || "",
      ).slice(0, 160),
      journeyTitle: String(
        p.journeyTitle || base.publicSite.journeyTitle || "",
      ).slice(0, 300),
      journeyCopy: String(
        p.journeyCopy || base.publicSite.journeyCopy || "",
      ).slice(0, 1200),
      journeySteps: strings(
        p.journeySteps?.length ? p.journeySteps : base.publicSite.journeySteps,
        10,
      ),
      eventEyebrow: String(
        p.eventEyebrow || base.publicSite.eventEyebrow || "",
      ).slice(0, 160),
      eventTitle: String(p.eventTitle || "").slice(0, 300),
      eventSummary: String(p.eventSummary || "").slice(0, 1200),
      eventCtaLabel: String(
        p.eventCtaLabel || base.publicSite.eventCtaLabel || "Event details",
      ).slice(0, 80),
      allowThemeToggle: p.allowThemeToggle === true,
      headingFont: ["editorial", "modern", "classic", "friendly"].includes(
        p.headingFont,
      )
        ? p.headingFont
        : "editorial",
      bodyFont: ["modern", "classic", "friendly"].includes(p.bodyFont)
        ? p.bodyFont
        : "modern",
      baseFontSize: Math.min(20, Math.max(14, Number(p.baseFontSize) || 16)),
      headingScale: Math.min(1.2, Math.max(0.8, Number(p.headingScale) || 1)),
      sectionVisibility: Object.fromEntries(
        Object.entries(effectiveVisibility).map(([key, value]) => [
          key,
          value !== false,
        ]),
      ),
      trustMetrics: cleanMetrics(p.trustMetrics),
      contactEmail: String(contactEmail).trim().slice(0, 320),
      contactPhone: String(p.contactPhone || "")
        .trim()
        .slice(0, 80),
      footerText: String(p.footerText || base.publicSite.footerText).slice(
        0,
        1000,
      ),
      socialLinks: links(p.socialLinks),
    },
  };
}
function workspaceSlugForHost(request) {
  const host = String(request?.headers?.host || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
  const leadPorchHosts = String(
      process.env.LEADPORCH_HOSTS || "leadporch.co,www.leadporch.co",
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    ellieHosts = String(
      process.env.ELLIE_PUBLIC_HOSTS ||
        "elliescoaching.com,www.elliescoaching.com",
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  if (leadPorchHosts.includes(host))
    return process.env.LEADPORCH_WORKSPACE_SLUG || "leadporch";
  if (ellieHosts.includes(host))
    return process.env.ELLIE_WORKSPACE_SLUG || "ellie";
  return (
    process.env.PUBLIC_WORKSPACE_SLUG ||
    process.env.ELLIE_WORKSPACE_SLUG ||
    "ellie"
  );
}
function requestHost(request) {
  return String(
    request?.headers?.["x-public-host"] ||
      request?.query?.publicHost ||
      request?.headers?.host ||
      "",
  )
    .split(",")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
}
async function workspace(models = deps, request) {
  if (models?.headers && !request) {
    request = models;
    models = deps;
  }
  const host = requestHost(request);
  if (host) {
    const mapped = await models.Workspace.findOne({
      publicHosts: host,
      status: "active",
    }).lean();
    if (mapped) return mapped;
  }
  const slug = workspaceSlugForHost(request);
  const item = await models.Workspace.findOne({
    slug,
    status: "active",
  }).lean();
  if (!item)
    throw Object.assign(new Error("Public site is unavailable"), {
      code: "PUBLIC_SITE_UNAVAILABLE",
    });
  return item;
}
function programProjection(item) {
  return {
    id: item._id,
    slug: item.publicPresentation.slug,
    title: item.publicPresentation.title || item.name,
    summary: item.publicPresentation.summary || item.internalSummary || "",
    description:
      item.publicPresentation.description || item.internalSummary || "",
    duration: item.duration,
    price: item.defaultPrice?.amount != null ? item.defaultPrice : null,
    priceVisible: Boolean(item.publicPresentation.priceVisible),
    highlights: strings(item.publicPresentation.highlights, 20),
    outcomes: strings(item.publicPresentation.outcomes, 20),
    curriculum: strings(item.publicPresentation.curriculum, 30),
    imageUrl: safeUrl(item.publicPresentation.imageUrl),
    audience: item.publicPresentation.audience,
    introVideoUrl: safeUrl(item.publicPresentation.introVideoUrl),
    cta: {
      label: item.publicPresentation.ctaLabel,
      url: safeUrl(item.publicPresentation.ctaUrl, { relative: true }),
      supportingText: String(
        item.publicPresentation.ctaSupportingText || "",
      ).slice(0, 500),
    },
    sortOrder: item.publicPresentation.sortOrder,
    section: item.publicPresentation.section || "",
    isFeatured: Boolean(item.publicPresentation.featured),
  };
}
function testimonialProjection(item) {
  return {
    id: item._id,
    displayName: item.displayName,
    headline: item.headline,
    body: item.body,
    avatarUrl: safeUrl(item.avatarUrl),
    resultContext: String(item.resultContext || "").slice(0, 2000),
    rating: item.rating,
    videoUrl: safeUrl(item.videoUrl),
    featured: Boolean(item.featured),
  };
}
function profileProjection(item) {
  return {
    slug: item.slug,
    ownerType: item.ownerType,
    displayName: item.displayName,
    publicTitle: String(item.publicTitle || "").slice(0, 160),
    headline: item.headline,
    bio: item.bio,
    avatarUrl: safeUrl(item.avatarUrl),
    publicLocation: item.publicLocation,
    specialties: strings(item.specialties),
    goals: strings(item.goals),
    experience: item.experience,
    socialLinks: links(item.socialLinks),
    websiteUrl: safeUrl(item.websiteUrl),
    cta: {
      label: String(item.cta?.label || "").slice(0, 80),
      url: safeUrl(item.cta?.url, { relative: true }),
    },
    layout: item.layout,
    accentToken: item.accentToken,
    sectionOrder: strings(item.sectionOrder, 10),
    featured: Boolean(item.featured),
    sortOrder: Number(item.sortOrder) || 0,
  };
}
async function site(models = deps, request) {
  if (models?.headers && !request) {
    request = models;
    models = deps;
  }
  const ws = await workspace(models, request);
  return runWithWorkspace(ws._id, async () => {
    const [
      config,
      programs,
      testimonials,
      profiles,
      event,
      activeCoaches,
      activeMembers,
    ] = await Promise.all([
      models.WorkspaceConfig.findOne({
        workspaceId: ws._id,
        key: "primary",
      }).lean(),
      models.CoachingProgram.find({
        workspaceId: ws._id,
        status: "active",
        "publicPresentation.status": "published",
      })
        .sort({ "publicPresentation.sortOrder": 1 })
        .lean(),
      models.Testimonial.find({
        workspaceId: ws._id,
        status: "approved",
        featured: true,
      })
        .sort({ sortOrder: 1 })
        .limit(6)
        .lean(),
      models.PublicProfile.find({
        workspaceId: ws._id,
        ownerType: "coach",
        status: "published",
      })
        .sort({ featured: -1, sortOrder: 1, displayName: 1 })
        .limit(50)
        .lean(),
      models.Event.findOne({
        workspaceId: ws._id,
        status: "active",
        startDate: { $gte: new Date() },
      })
        .sort({ startDate: 1 })
        .lean(),
      models.CoachProfile.find({ workspaceId: ws._id, status: "active" })
        .select("_id userId")
        .lean(),
      models.WorkspaceMembership.find({ workspaceId: ws._id, status: "active" })
        .select("userId")
        .lean(),
    ]);
    const coachIds = new Set(activeCoaches.map((row) => String(row._id))),
      memberIds = new Set(activeMembers.map((row) => String(row.userId)));
    const eligibleProfiles = profiles.filter(
      (row) =>
        coachIds.has(String(row.coachProfileId)) &&
        memberIds.has(String(row.userId)) &&
        row.displayName &&
        row.bio,
    );
    return {
      ...sanitizedConfig(ws, config),
      programs: programs.map(programProjection),
      featuredTestimonials: testimonials.map(testimonialProjection),
      team: eligibleProfiles.slice(0, 12).map(profileProjection),
      upcomingEvent: event
        ? {
            id: event._id,
            name: event.name,
            summary: event.summary || event.description,
            startDate: event.startDate,
            locationType: event.locationType,
            location: event.location,
            registrationUrl: safeUrl(event.onlineUrl),
          }
        : null,
    };
  });
}
function profileInput(input) {
  const slug = String(input.slug || "")
    .trim()
    .toLowerCase();
  if (!SLUG.test(slug))
    throw new Error(
      "Use a lowercase profile slug with letters, numbers, and hyphens",
    );
  return {
    slug,
    displayName: String(input.displayName || "")
      .trim()
      .slice(0, 160),
    publicTitle: String(input.publicTitle || "")
      .trim()
      .slice(0, 160),
    headline: String(input.headline || "")
      .trim()
      .slice(0, 300),
    bio: String(input.bio || "")
      .trim()
      .slice(0, 8000),
    avatarUrl: safeUrl(input.avatarUrl),
    publicLocation: String(input.publicLocation || "")
      .trim()
      .slice(0, 200),
    specialties: strings(input.specialties),
    goals: strings(input.goals),
    experience: String(input.experience || "")
      .trim()
      .slice(0, 5000),
    socialLinks: links(input.socialLinks),
    websiteUrl: safeUrl(input.websiteUrl),
    cta: {
      label: String(input.cta?.label || "").slice(0, 80),
      url: safeUrl(input.cta?.url, { relative: true }),
    },
    layout: ["executive", "profile", "minimal"].includes(input.layout)
      ? input.layout
      : "executive",
    accentToken: ["brand", "green", "charcoal"].includes(input.accentToken)
      ? input.accentToken
      : "brand",
    sectionOrder: strings(input.sectionOrder, 10),
    featured: Boolean(input.featured),
    sortOrder: Number(input.sortOrder) || 0,
    status: input.status === "published" ? "published" : "draft",
    publishedAt: input.status === "published" ? new Date() : null,
  };
}
async function issueToken(profile, workspaceId, userId, models = deps) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await models.EditToken.create({
    workspaceId,
    publicProfileId: profile._id,
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: userId,
  });
  return raw;
}
async function tokenProfile(raw, models = deps) {
  const hash = crypto
    .createHash("sha256")
    .update(String(raw || ""))
    .digest("hex");
  const token = await models.EditToken.findOne({
    tokenHash: hash,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select("+tokenHash");
  if (!token) return null;
  const profile = await models.PublicProfile.findOne({
    _id: token.publicProfileId,
    workspaceId: token.workspaceId,
    ownerType: "student",
    status: { $ne: "suspended" },
  });
  if (!profile) return null;
  token.lastUsedAt = new Date();
  await token.save();
  return { token, profile };
}
module.exports = {
  cleanMetrics,
  defaults,
  issueToken,
  links,
  profileInput,
  profileProjection,
  programProjection,
  safeColor,
  safeUrl,
  sanitizedConfig,
  site,
  testimonialProjection,
  tokenProfile,
  requestHost,
  workspaceSlugForHost,
  workspace,
};
