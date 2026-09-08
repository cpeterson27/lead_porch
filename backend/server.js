const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();
const { connectDatabase } = require("./config/database");
const Contact = require("./models/Contact");

const campaignsRouter = require("./routes/campaigns");
const outreachRouter = require("./routes/outreach");
const emailsRouter = require("./routes/emails");
const eventsRouter = require("./routes/events");
const eventbriteRouter = require("./routes/eventbrite");
const contactsRouter = require("./routes/contacts");
const audienceRouter = require("./routes/audience");
const organizationRelationshipsRouter = require("./routes/organizationRelationships");
const integrationsRouter = require("./routes/integrations");
const integrationConnectionsRouter = require("./routes/integrationConnections");
const marketingCampaignsRouter = require("./routes/marketingCampaigns");
const growthOperatorsRouter = require("./routes/growthOperators");
const bootcampCampaignsRouter = require("./routes/bootcampCampaigns");
const jarvisRouter = require("./routes/jarvis");
const webhooksRouter = require("./routes/webhooks");
const partnersRouter = require("./routes/partners");
const contentRouter = require("./routes/content");
const developmentRequestsRouter = require("./routes/developmentRequests");
const gmailRouter = require("./routes/gmail");
const workspaceRouter = require("./routes/workspace");
const ambassadorsRouter = require("./routes/ambassadors");
const unsubscribeRouter = require("./routes/unsubscribe");
const authRouter = require("./routes/auth");
const businessIndexRouter = require("./routes/businessIndex");
const mcpAccessRouter = require("./routes/mcpAccess");
const mcpRouter = require("./routes/mcp");
const oauthRouter = require("./routes/oauth");
const socialRouter = require("./routes/social");
const privacyRequestsRouter = require("./routes/privacyRequests");
const gptActionsRouter = require("./routes/gptActions");
const activitiesRouter = require("./routes/activities");
const opportunitiesRouter = require("./routes/opportunities");
const conversationsRouter = require("./routes/conversations");
const telephonyRouter = require("./routes/telephony");
const chatRouter = require("./routes/chat");
const socialMessagingRouter = require("./routes/socialMessaging");
const socialAutomationRouter = require("./routes/socialAutomation");
const automationsRouter = require("./routes/automations");
const analyticsRouter = require("./routes/analytics");
const coachingRouter = require("./routes/coaching");
const publicSiteRouter = require("./routes/publicSite");
const publicManagementRouter = require("./routes/publicManagement");
const meetupRouter = require("./routes/meetup");
const platformRouter = require("./routes/platform");
const aiRouter = require("./routes/ai");
const paymentsRouter = require("./routes/payments");
const { requireAuth } = require("./middleware/auth");
const { restrictNewRoleSurface } = require("./middleware/authorization");
const { startResearchMonitorRunner } = require("./services/researchMonitorService");
const { startCommunicationJobRunner } = require("./services/communicationJobRunner");
const { startAutomationRunner } = require("./services/automationRunner");
const { startSocialPublishingRunner } = require("./services/socialPublishingRunner");

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
}
const workspaceCors = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed"));
  },
  credentials: true,
});
const publicChatCors = cors({ origin: true, credentials: false });
// Static assets and the HTML document shell (everything outside /api) are
// public, non-credentialed resources — the same as any static host would
// serve them, with no origin restriction. Only /api/* (aside from the
// already-public chat widget) carries session/credential-bearing data and
// needs the strict allowlist below. Without this split, a browser's
// same-origin module-script fetch (crossorigin="anonymous", which sends an
// Origin header) got rejected with a 500 by the origin allowlist whenever
// the page's own origin wasn't already in it — breaking every page load.
const publicAssetCors = cors({ origin: true, credentials: false });
app.use((req, res, next) => {
  if (req.path.startsWith("/api/chat/widget/"))
    return publicChatCors(req, res, next);
  if (!req.path.startsWith("/api/")) return publicAssetCors(req, res, next);
  return workspaceCors(req, res, next);
});
// Video uploads (testimonials, program media) arrive as a base64 data URI in
// the JSON body — a 75MB video inflates to ~100MB of base64 text, far past
// the 12MB ceiling the rest of the API uses to limit memory exposure per
// request. Only these two known video-upload routes get the larger limit;
// express.json() is a no-op on a request whose body it has already parsed,
// so the second, smaller-limit parser below safely skips these requests.
const videoUploadPaths = new Set([
  "/api/public-management/program-media",
  "/api/public-management/testimonial-media",
]);
const videoUploadJson = express.json({ limit: "110mb" });
app.use((req, res, next) => {
  if (videoUploadPaths.has(req.path)) return videoUploadJson(req, res, next);
  next();
});
app.use(express.json({
  limit: "12mb",
  verify(req, _res, buffer) {
    if (req.originalUrl === "/api/webhooks/resend" || req.originalUrl === "/api/webhooks/meta" || req.originalUrl === "/api/webhooks/instagram" || req.originalUrl === "/api/coaching/zoom/webhook" || req.originalUrl === "/api/coaching/skool/adapter/events" || req.originalUrl === "/api/payments/square/webhook") {
      req.rawBody = buffer.toString("utf8");
    }
  },
}));
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 5001;
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
  console.error(
    "Missing MONGO_URI. Set it in backend/.env or the environment.",
  );
  process.exit(1);
}

connectDatabase(mongoUri)
  .then(async () => {
    console.log("Connected to MongoDB");

    const migratedImports = await Contact.updateMany(
      {
        status: "prospect",
        $or: [
          { sourceProvider: { $in: ["csv", "manual", "monday"] } },
          { sources: { $in: ["csv", "manual", "monday"] } },
        ],
      },
      { $set: { status: "active" } },
    );

    if (migratedImports.modifiedCount > 0) {
      console.log(
        `Moved ${migratedImports.modifiedCount} imported contacts into the CRM workflow.`,
      );
    }

    // Older intent conversions sometimes stored a Reddit username and URL as a
    // person's name. Keep the source evidence, but do not present that account
    // as a verified identity in the CRM.
    const legacyIntentContacts = await Contact.find({ sourceProvider: "intent_monitor" });
    let repairedIntentContacts = 0;
    for (const contact of legacyIntentContacts) {
      const recordedName = String(contact.name || "").trim();
      if (!/(?:reddit\.com\/user\/|^\/?u\/|https?:\/\/)/i.test(recordedName)) continue;
      const evidenceNote = `Original public account value: ${recordedName}`;
      const notes = String(contact.notes || "").includes(evidenceNote)
        ? contact.notes
        : [contact.notes, evidenceNote].filter(Boolean).join("\n");
      await Contact.updateOne(
        { _id: contact._id },
        { $set: { name: "Identity research needed", firstName: "", lastName: "", stage: "Needs Research", researchStatus: "needs_research", notes } },
      );
      repairedIntentContacts += 1;
    }
    if (repairedIntentContacts) {
      console.log(`Repaired ${repairedIntentContacts} legacy intent contact name(s).`);
    }

    app.use("/api/auth", authRouter);
    app.use("/", oauthRouter);
    app.use("/", gptActionsRouter);
    app.use("/mcp", mcpRouter);
    app.use("/api", (req, res, next) => {
      const publicRequest =
        req.path === "/health" ||
        req.path.startsWith("/public/") ||
        req.path.startsWith("/unsubscribe/") ||
        req.path === "/webhooks/resend" ||
        req.path.startsWith("/webhooks/twilio/") ||
        req.path === "/webhooks/meta" || req.path === "/webhooks/instagram" ||
        req.path.startsWith("/social-automation/t/") ||
        req.path.startsWith("/chat/widget/") ||
        req.path === "/jarvis/memory/sync" ||
        req.path === "/eventbrite/webhook" ||
        req.path === "/eventbrite/oauth/callback" ||
        req.path === "/gmail/oauth/callback";
      const publicMeetupCallback = req.path === "/meetup/oauth/callback";
      const publicCoachingCalendarCallback = req.path === "/coaching/calendar/oauth/callback";
      const publicCoachingZoomRoute = req.path === "/coaching/zoom/oauth/callback" || req.path === "/coaching/zoom/webhook";
      const publicSkoolAdapterRoute = req.path === "/coaching/skool/adapter/events";
      const publicSocialCallback = /^\/social\/(?:linkedin|meta|instagram|x)\/oauth\/callback$/.test(req.path) || req.path === "/social/meta/deauthorize";
      const publicPaymentRoute = req.path === "/payments/square/oauth/callback" || req.path === "/payments/square/webhook" || req.path.startsWith("/payments/public/") || req.path.startsWith("/payments/plans/public/");
      return publicRequest || publicMeetupCallback || publicSocialCallback || publicPaymentRoute || publicCoachingCalendarCallback || publicCoachingZoomRoute || publicSkoolAdapterRoute ? next() : requireAuth(req, res, next);
    });
    app.use("/api", restrictNewRoleSurface);

    app.use("/api/campaigns", campaignsRouter);
    app.use("/api/public", publicSiteRouter);
    app.use("/api/public-management", publicManagementRouter);
    app.use("/api/outreach", outreachRouter);
    app.use("/api/emails", emailsRouter);
    app.use("/api/events", eventsRouter);
    app.use("/api/eventbrite", eventbriteRouter);
    app.use("/api/contacts", contactsRouter);
    app.use("/api/activities", activitiesRouter);
    app.use("/api/opportunities", opportunitiesRouter);
    app.use("/api/coaching", coachingRouter);
    app.use("/api/ambassadors", ambassadorsRouter);
    app.use("/api/conversations", conversationsRouter);
    app.use("/api/telephony", telephonyRouter);
    app.use("/api/chat", chatRouter);
    app.use("/api/social-workspace", require("./routes/socialWorkspace"));
    app.use("/api/social-messaging", socialMessagingRouter);
    app.use("/api/social-automation", socialAutomationRouter);
    app.use("/api/automations", automationsRouter);
    app.use("/api/analytics", analyticsRouter);
    app.use("/api/audience", audienceRouter);
    app.use("/api/organizations", organizationRelationshipsRouter);
    app.use("/api/integrations", integrationsRouter);
    app.use("/api/meetup", meetupRouter);
    app.use("/api/integration-connections", integrationConnectionsRouter);
    app.use("/api/marketing-campaigns", marketingCampaignsRouter);
    app.use("/api/growth-operators", growthOperatorsRouter);
    app.use("/api/bootcamp-campaigns", bootcampCampaignsRouter);
    app.use("/api/jarvis", jarvisRouter);
    app.use("/api/webhooks", webhooksRouter);
    app.use("/api/partners", partnersRouter);
    app.use("/api/content", contentRouter);
    app.use("/api/development-requests", developmentRequestsRouter);
    app.use("/api/gmail", gmailRouter);
    app.use("/api/workspace", workspaceRouter);
    app.use("/api/platform", platformRouter);
    app.use("/api/ai", aiRouter);
    app.use("/api/payments", paymentsRouter);
    app.use("/api/unsubscribe", unsubscribeRouter);
    app.use("/api/business-index", businessIndexRouter);
    app.use("/api/mcp-access-tokens", mcpAccessRouter);
    app.use("/api/social", socialRouter);
    app.use("/api/privacy-requests", privacyRequestsRouter);

    app.get("/api/health", (req, res) => {
      res.json({
        status: "Lead Porch backend running 🚀",
      });
    });

    // Every route above throws plain Error objects with an intentional,
    // user-facing message (e.g. "Meta free-form replies require a customer
    // message within the last 24 hours"). Without this handler those errors
    // fell through to Express's default HTML error page, so the frontend
    // never saw the real reason and always showed its generic fallback text
    // — true for every route in the app, not just this one.
    app.use("/api", (err, req, res, next) => {
      if (res.headersSent) return next(err);
      console.error(`[API error] ${req.method} ${req.originalUrl}:`, err);
      res.status(err.statusCode || err.status || 400).json({
        error: err.message || "Something went wrong. Try again.",
      });
    });

    // Serve the built frontend's hashed JS/CSS/image assets as-is with
    // long-lived caching (safe: Vite fingerprints the filename on every
    // content change). index.html is deliberately excluded here — it must
    // always go through publicHtmlShell below so per-workspace meta tags
    // get injected, never served as a raw cached file.
    app.use(
      express.static(path.join(__dirname, "..", "frontend", "dist"), {
        index: false,
        maxAge: "1y",
        immutable: true,
      }),
    );

    app.use(require("./middleware/publicHtmlShell").publicHtmlShell);

    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      if (process.env.RESEARCH_WORKER_MODE !== "external") startResearchMonitorRunner();
      startCommunicationJobRunner();
      startAutomationRunner();
      startSocialPublishingRunner();
    });

    server.on("error", (error) => {
      console.error(`Failed to start server on port ${PORT}:`, error.message);
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error("Failed to connect to MongoDB:", error.message || error);
    process.exit(1);
  });
