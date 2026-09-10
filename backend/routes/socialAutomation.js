const express = require("express");
const mongoose = require("mongoose");
const { requireCapability } = require("../middleware/auth");
const Contact = require("../models/Contact");
const SocialAutomation = require("../models/SocialAutomation");
const SocialIdentity = require("../models/SocialIdentity");
const SocialProviderEvent = require("../models/SocialProviderEvent");
const SocialConnection = require("../models/SocialConnection");
const TrackedLink = require("../models/TrackedLink");
const CrmActivity = require("../models/CrmActivity");
const Campaign = require("../models/Campaign");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const ContentBrief = require("../models/ContentBrief");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const {
  SUPPORTED_TRIGGERS,
  createTrackedLink,
  isAllowedDestination,
  normalizedKeywords,
  normalizedLabels,
} = require("../services/socialLeadAutomationService");
const { normalizeUrl, matrix: publishingMatrix } = require("../services/socialPublishingService");
const agentExecutionService = require("../services/agentExecutionService");

const router = express.Router();
const adminOnly = requireCapability("social.manage");
const CAPABILITIES = {
  instagram: {
    connection: "native_meta",
    inboundDm: true,
    outboundReply: true,
    commentTrigger: true,
    commentKeyword: true,
    storyReply: true,
    followToDm: false,
    leadForm: true,
    ctaAttribution: true,
    likesViewsSaves: false,
  },
  facebook: {
    connection: "native_meta",
    inboundDm: true,
    outboundReply: true,
    commentTrigger: true,
    commentKeyword: true,
    storyReply: false,
    followToDm: false,
    leadForm: true,
    ctaAttribution: true,
    likesViewsSaves: false,
  },
  tiktok: {
    connection: "not_configured",
    inboundDm: false,
    outboundReply: false,
    commentTrigger: false,
    commentKeyword: false,
    storyReply: false,
    followToDm: false,
    leadForm: true,
    ctaAttribution: true,
    likesViewsSaves: false,
  },
  linkedin: {
    connection: "human_assisted",
    inboundDm: false,
    outboundReply: false,
    commentTrigger: false,
    commentKeyword: false,
    storyReply: false,
    followToDm: false,
    leadForm: "approved_marketing_partner_only",
    ctaAttribution: true,
    likesViewsSaves: false,
  },
  x: {
    connection: "not_configured",
    inboundDm: false,
    outboundReply: false,
    commentTrigger: false,
    commentKeyword: false,
    storyReply: false,
    followToDm: false,
    leadForm: false,
    ctaAttribution: true,
    likesViewsSaves: false,
  },
};

router.use((req, res, next) =>
  req.path.startsWith("/t/") ? next() : adminOnly(req, res, next),
);

/**
 * POST /social-automation/recommend
 * Content Agent recommends a complete campaign-automation plan grounded in
 * the real post/campaign; Social Agent's own real capability matrix then
 * validates whether the recommended platform/trigger is actually
 * executable today. This never creates or activates anything — the human
 * reviews the recommendation and uses the existing, separate
 * POST /social-automation/automations to activate it.
 */
router.post("/recommend", adminOnly, async (req, res) => {
  const { contentBriefId, provider, assetId } = req.body || {};
  if (!provider || !["facebook", "instagram"].includes(provider)) return res.status(400).json({ success: false, error: "Choose facebook or instagram" });
  const brief = contentBriefId ? await ContentBrief.findOne({ _id: contentBriefId, workspaceId: req.auth.workspaceId }).lean() : null;
  try {
    const result = await agentExecutionService.runAgent({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, agent: "content", task: "recommend_campaign_automation",
      input: { provider, post: brief ? { title: brief.title, body: brief.body } : null },
      operationalContext: `Recommend one complete, safe campaign automation for a ${provider} comment-keyword trigger. Base it strictly on the supplied post and workspace analytics — do not invent programs, offers, or numbers not present in the data. The automation may only ever: acknowledge publicly, send an approved private reply, create/update a CRM contact, record source, tag/score the contact, and stop. It must never send unapproved outreach, never guess private information, and must include real stop conditions (response received, registration, conversion, opt-out, cooldown, frequency limit).`,
      correlationId: `automation-recommend:${req.auth.workspaceId}`,
      options: {
        tools: [{ toolId: "growth.analytics", input: {} }],
        responseSchema: {
          type: "object",
          properties: {
            triggerType: { type: "string", enum: ["comment_keyword", "comment_any", "dm_keyword"] },
            keywords: { type: "array", items: { type: "string" } },
            publicAcknowledgement: { type: "string" },
            privateMessage: { type: "string" },
            crmActions: { type: "object", properties: { createOrUpdateContact: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, qualificationSignals: { type: "array", items: { type: "string" } } }, required: ["createOrUpdateContact", "tags", "qualificationSignals"], additionalProperties: false },
            followUp: { type: "string" },
            exclusions: { type: "array", items: { type: "string" } },
            cooldownMinutes: { type: "number" },
            dailyLimit: { type: "number" },
            stopConditions: { type: "array", items: { type: "string", enum: ["response_received", "registration", "conversion", "opt_out", "cooldown", "frequency_limit"] } },
            optOutHandling: { type: "string" },
            humanHandoff: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["triggerType", "keywords", "publicAcknowledgement", "privateMessage", "crmActions", "followUp", "exclusions", "cooldownMinutes", "dailyLimit", "stopConditions", "optOutHandling", "humanHandoff", "rationale"],
          additionalProperties: false,
        },
        schemaName: "campaign_automation_recommendation",
      },
    });
    const matrix = await publishingMatrix(req.auth.workspaceId);
    const capabilityRow = matrix.find((row) => row.provider === provider);
    const validation = !capabilityRow || capabilityRow.status !== "api"
      ? { status: "not_executable", reason: capabilityRow?.reason || "No authorized connection for this provider" }
      : { status: "executable", reason: capabilityRow.reason, asset: capabilityRow.asset };
    return res.json({ success: true, data: { recommendation: result.output, validation, provider, assetId: assetId || capabilityRow?.asset?.id || "" }, metadata: result.metadata });
  } catch (err) {
    const isBillingLimit = err.status === 429 || err.statusCode === 429;
    const status = isBillingLimit ? 429 : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code) ? 403 : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code) ? 400 : 500;
    return res.status(status).json({ success: false, error: isBillingLimit ? "OpenAI credits are empty. Add API credits to use AI automation recommendations." : err.message, code: err.code || "AUTOMATION_RECOMMENDATION_FAILED" });
  }
});

router.get("/overview", async (_req, res) => {
  const [connections, automationCount, leadCount, recentEvents] =
    await Promise.all([
      SocialConnection.find({}).lean(),
      SocialAutomation.countDocuments({}),
      SocialIdentity.countDocuments({}),
      SocialProviderEvent.find({})
        .select(
          "provider eventType occurredAt processingStatus reply.status reply.error contactId",
        )
        .populate("contactId", "name")
        .sort({ occurredAt: -1 })
        .limit(30)
        .lean(),
    ]);
  res.json({
    success: true,
    data: {
      capabilities: CAPABILITIES,
      supportedTriggers: SUPPORTED_TRIGGERS,
      manyChat: {
        required: false,
        reason:
          "Native Meta supports the Phase 7 DM, story reply, comment webhook, keyword, and permitted private-reply flows. Follow-to-DM remains unsupported and optional.",
      },
      connections,
      recentEvents,
      counts: { automations: automationCount, socialLeads: leadCount },
    },
  });
});

router.get("/automations", async (req, res) => {
  const filter = { workspaceId: req.auth.workspaceId };
  if (req.query.contentBriefId) filter.contentBriefId = req.query.contentBriefId;
  res.json({
    success: true,
    data: await SocialAutomation.find(filter)
      .populate("campaignId", "name")
      .populate("contentBriefId", "title status")
      .sort({ updatedAt: -1 })
      .lean(),
  });
});
router.get("/contact-labels", async (req, res) => {
  const config = await WorkspaceConfig.findOne({
    workspaceId: req.auth.workspaceId,
    key: "primary",
  })
    .select("contactLabels")
    .lean();
  const labels = normalizedLabels(config?.contactLabels || []);
  labels.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  res.json({ success: true, data: labels });
});
router.get("/posts", async (req, res) => {
  try {
    const data = await require("../services/metaRecentPostService").recentPosts(
      {
        workspaceId: req.auth.workspaceId,
        provider: String(req.query.provider || ""),
        assetId: String(req.query.assetId || ""),
      },
    );
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.get("/content-briefs", async (req, res) => {
  const provider = String(req.query.provider || ""),
    assetId = String(req.query.assetId || "");
  if (!["facebook", "instagram"].includes(provider) || !assetId)
    return res.status(400).json({ error: "Choose a connected account" });
  const rows = await ContentBrief.find({
    workspaceId: req.auth.workspaceId,
    type: "social",
    status: { $ne: "archived" },
    social: { $exists: true },
    "social.destinations": { $elemMatch: { provider, assetId } },
  })
    .select("title body status social.publications createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
  res.json({
    success: true,
    data: rows.map((row) => {
      const publication = (row.social?.publications || []).find(
        (item) =>
          item.provider === provider &&
          String(item.assetId) === assetId &&
          item.status === "published",
      );
      return {
        id: row._id,
        title: row.title,
        text: String(row.body || "").slice(0, 500),
        status: row.status,
        updatedAt: row.updatedAt || row.createdAt,
        providerPostId: publication?.providerPostId || "",
      };
    }),
  });
});
router.post("/contact-labels", async (req, res) => {
  const label = normalizedLabels([req.body?.label])[0];
  if (!label) return res.status(400).json({ error: "Enter a contact label" });
  const config = await WorkspaceConfig.findOne({
    workspaceId: req.auth.workspaceId,
    key: "primary",
  });
  const labels = normalizedLabels([...(config?.contactLabels || []), label]);
  const saved =
    config ||
    new WorkspaceConfig({ workspaceId: req.auth.workspaceId, key: "primary" });
  saved.contactLabels = labels;
  await saved.save();
  const canonical = labels.find(
    (item) => item.toLocaleLowerCase() === label.toLocaleLowerCase(),
  );
  res.status(config ? 200 : 201).json({ success: true, data: canonical });
});
router.get("/history", async (_req, res) =>
  res.json({
    success: true,
    data: await SocialProviderEvent.find({})
      .select(
        "provider eventType occurredAt processingStatus reply.status reply.error contactId",
      )
      .populate("contactId", "name")
      .sort({ occurredAt: -1 })
      .limit(50)
      .lean(),
  }),
);

router.post("/automations", async (req, res) => {
  const provider = String(req.body?.provider || "").toLowerCase();
  const triggerType = String(req.body?.triggerType || "");
  if (
    !SUPPORTED_TRIGGERS[provider]?.includes(triggerType) ||
    !["instagram", "facebook"].includes(provider)
  )
    return res
      .status(400)
      .json({
        error:
          "This provider trigger is not supported by the native connection",
        code: "TRIGGER_UNSUPPORTED",
      });
  if (!req.body?.assetId || !req.body?.name)
    return res
      .status(400)
      .json({ error: "Name and connected asset are required" });
  if (
    ["comment_keyword", "dm_keyword"].includes(triggerType) &&
    !normalizedKeywords(req.body.keywords).length
  )
    return res.status(400).json({ error: "At least one keyword is required" });
  const asset = await SocialConnection.findOne({
    provider:
      provider === "instagram" ? { $in: ["meta", "instagram"] } : "meta",
    status: "connected",
    selectedAssetIds: String(req.body.assetId),
    assets: {
      $elemMatch: {
        id: String(req.body.assetId),
        type: provider === "instagram" ? "instagram_business" : "facebook_page",
      },
    },
  }).lean();
  if (!asset)
    return res
      .status(400)
      .json({
        error: "The selected Meta asset is not connected to this workspace",
      });
  if (
    req.body.campaignId &&
    !(await Campaign.exists({ _id: req.body.campaignId }))
  )
    return res.status(400).json({ error: "Campaign is not in this workspace" });
  // A bare domain like "leadporch.co" (no https://) is exactly what someone naturally types into a
  // "button link" field — the post's own CTA URL already tolerates this via normalizeUrl(); this field
  // must too, or the same kind of input works in one field and fails in the other for no visible reason.
  if (req.body.cta?.destination)
    req.body.cta.destination = normalizeUrl(req.body.cta.destination);
  if (
    req.body.cta?.destination &&
    !(await isAllowedDestination(
      req.body.cta.destination,
      req.auth.workspaceId,
    ))
  )
    return res
      .status(400)
      .json({
        error:
          "CTA destination must use this workspace's verified HTTPS website or an approved Eventbrite URL",
      });
  let contentBrief = null;
  if (
    req.body.contentBriefId &&
    !mongoose.isValidObjectId(req.body.contentBriefId)
  )
    return res
      .status(400)
      .json({ error: "Choose a valid Growth Operator post" });
  if (req.body.contentBriefId)
    contentBrief = await ContentBrief.findOne({
      _id: req.body.contentBriefId,
      workspaceId: req.auth.workspaceId,
      type: "social",
      "social.destinations": {
        $elemMatch: { provider, assetId: String(req.body.assetId) },
      },
    }).lean();
  if (req.body.contentBriefId && !contentBrief)
    return res
      .status(400)
      .json({
        error: "Choose a Growth Operator post for this connected account",
      });
  const publication = (contentBrief?.social?.publications || []).find(
    (item) =>
      item.provider === provider &&
      String(item.assetId) === String(req.body.assetId) &&
      item.status === "published",
  );
  const record = await SocialAutomation.create({
    name: req.body.name,
    provider,
    assetId: String(req.body.assetId),
    contentId: contentBrief
      ? String(publication?.providerPostId || "")
      : String(req.body.contentId || ""),
    contentBriefId: contentBrief?._id || null,
    triggerType,
    keywords: normalizedKeywords(req.body.keywords),
    responseTemplate: String(req.body.responseTemplate || ""),
    cta: req.body.cta || {},
    campaignId: req.body.campaignId || null,
    tags: normalizedLabels(req.body.tags),
    qualification: normalizedKeywords(req.body.qualification),
    enabled: req.body.enabled === true,
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId,
  });
  res.status(201).json({ success: true, data: record });
});

router.patch("/automations/:id", async (req, res) => {
  const record = await SocialAutomation.findOne({
    _id: req.params.id,
    workspaceId: req.auth.workspaceId,
  });
  if (!record)
    return res.status(404).json({ error: "Social automation not found" });
  if (
    req.body.campaignId &&
    !(await Campaign.exists({ _id: req.body.campaignId }))
  )
    return res.status(400).json({ error: "Campaign is not in this workspace" });
  if (req.body.cta?.destination)
    req.body.cta.destination = normalizeUrl(req.body.cta.destination);
  if (
    req.body.cta?.destination &&
    !(await isAllowedDestination(
      req.body.cta.destination,
      req.auth.workspaceId,
    ))
  )
    return res
      .status(400)
      .json({
        error:
          "CTA destination must use this workspace's verified HTTPS website or an approved Eventbrite URL",
      });
  if (
    req.body.triggerType !== undefined &&
    !SUPPORTED_TRIGGERS[record.provider]?.includes(req.body.triggerType)
  )
    return res
      .status(400)
      .json({ error: "This provider trigger is not supported by the native connection" });
  for (const key of [
    "name",
    "contentId",
    "triggerType",
    "responseTemplate",
    "campaignId",
    "enabled",
  ])
    if (req.body[key] !== undefined) record[key] = req.body[key];
  if (req.body.contentBriefId !== undefined) {
    if (
      req.body.contentBriefId &&
      !mongoose.isValidObjectId(req.body.contentBriefId)
    )
      return res
        .status(400)
        .json({ error: "Choose a valid Growth Operator post" });
    const contentBrief = req.body.contentBriefId
      ? await ContentBrief.findOne({
          _id: req.body.contentBriefId,
          workspaceId: req.auth.workspaceId,
          type: "social",
          "social.destinations": {
            $elemMatch: { provider: record.provider, assetId: record.assetId },
          },
        }).lean()
      : null;
    if (req.body.contentBriefId && !contentBrief)
      return res
        .status(400)
        .json({
          error: "Choose a Growth Operator post for this connected account",
        });
    const publication = (contentBrief?.social?.publications || []).find(
      (item) =>
        item.provider === record.provider &&
        String(item.assetId) === String(record.assetId) &&
        item.status === "published",
    );
    record.contentBriefId = contentBrief?._id || null;
    record.contentId = contentBrief
      ? String(publication?.providerPostId || "")
      : String(req.body.contentId || "");
  }
  if (req.body.keywords)
    record.keywords = normalizedKeywords(req.body.keywords);
  if (req.body.tags) record.tags = normalizedLabels(req.body.tags);
  if (req.body.qualification)
    record.qualification = normalizedKeywords(req.body.qualification);
  if (req.body.cta) record.cta = req.body.cta;
  record.updatedBy = req.auth.userId;
  await record.save();
  res.json({ success: true, data: record });
});

router.get("/leads", async (req, res) => {
  const identities = await require("../services/socialLeadInboxService").list(
    req.auth.workspaceId,
    req.query,
  );
  res.json({ success: true, data: identities });
});

router.get("/leads/:contactId", async (req, res) => {
  const [contact, identities, events] = await Promise.all([
    Contact.findById(req.params.contactId).lean(),
    SocialIdentity.find({ contactId: req.params.contactId }).lean(),
    SocialProviderEvent.find({ contactId: req.params.contactId })
      .sort({ occurredAt: -1 })
      .limit(100)
      .lean(),
  ]);
  if (!contact) return res.status(404).json({ error: "Social lead not found" });
  res.json({ success: true, data: { contact, identities, events } });
});

router.post("/tracked-links", async (req, res) => {
  if (
    req.body.contactId &&
    !(await Contact.exists({ _id: req.body.contactId }))
  )
    return res.status(400).json({ error: "Contact is not in this workspace" });
  try {
    const link = await createTrackedLink(
      {
        destination: req.body.destination,
        workspaceId: req.auth.workspaceId,
        provider: req.body.provider,
        contactId: req.body.contactId || null,
        campaignId: req.body.campaignId || null,
        automationId: req.body.automationId || null,
        assetId: String(req.body.assetId || ""),
        contentId: String(req.body.contentId || ""),
        referralCode: String(req.body.referralCode || ""),
        utm: req.body.utm || {},
      },
      req.auth.userId,
    );
    res
      .status(201)
      .json({
        success: true,
        data: {
          ...link.toObject(),
          url: `${String(process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, "")}/api/social-automation/t/${link.token}`,
        },
      });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// This handler is mounted before role middleware in server.js. The token is
// random, contains no PII, and redirects only to an allowlisted destination.
router.get("/t/:token", async (req, res) => {
  const link = await TrackedLink.findOne({ token: req.params.token }).lean();
  if (!link || (link.expiresAt && new Date(link.expiresAt) < new Date()))
    return res.status(404).send("Link unavailable");
  const clickedAt = new Date();
  await runWithWorkspace(link.workspaceId, async () => {
    await TrackedLink.updateOne(
      { _id: link._id },
      {
        $inc: { clickCount: 1 },
        $set: {
          lastClickedAt: clickedAt,
          ...(!link.firstClickedAt ? { firstClickedAt: clickedAt } : {}),
        },
      },
    );
    await CrmActivity.create({
      contactId: link.contactId || null,
      campaignId: link.campaignId || null,
      type: "system",
      title: "Social tracked link clicked",
      source: "integration",
      metadata: {
        eventType: "social.link.clicked",
        provider: link.provider,
        contentId: link.contentId || "",
        trackedLinkId: link._id,
        anonymous: !link.contactId,
      },
    });
  });
  const destination = new URL(link.destination);
  const params = {
    utm_source: link.utm?.source || link.provider,
    utm_medium: link.utm?.medium || "social",
    utm_campaign: link.utm?.campaign || "",
    utm_content: link.utm?.content || link.contentId || "",
    utm_term: link.utm?.term || "",
    go_link: link.token,
    referral: link.referralCode || "",
  };
  for (const [key, value] of Object.entries(params))
    if (value) destination.searchParams.set(key, value);
  res.redirect(302, destination.toString());
});

module.exports = router;
module.exports.CAPABILITIES = CAPABILITIES;
