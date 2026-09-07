const express = require("express");
const { requireCapability } = require("../middleware/auth");
const ContentBrief = require("../models/ContentBrief");
const ConversationThread = require("../models/ConversationThread");
const ConversationMessage = require("../models/ConversationMessage");
const SocialIdentity = require("../models/SocialIdentity");
const SocialProviderEvent = require("../models/SocialProviderEvent");
const AutomationActionRun = require("../models/AutomationActionRun");
const CrmActivity = require("../models/CrmActivity");
const AmbassadorContentTask = require("../models/AmbassadorContentTask");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const CoachingProgram = require("../models/CoachingProgram");
const Event = require("../models/Event");
const CoachingApplication = require("../models/CoachingApplication");
const Enrollment = require("../models/Enrollment");
const TrackedLink = require("../models/TrackedLink");
const llm = require("../services/llmService");
const media = require("../services/imageAssetService");
const distribution = require("../services/ambassadorContentService");
const oauth = require("../services/socialOAuthService");
const metaInsights = require("../services/metaInsightsService");
const pageEngagement = require("../services/metaPageEngagementService");
const socialAiService = require("../services/socialAiService");
const automationPolicyService = require("../services/automationPolicyService");
const automationActionService = require("../services/automationActionService");
const automationExecutorService = require("../services/automationExecutorService");
const {
  metaMessagingAdapter,
} = require("../services/conversations/metaMessagingAdapter");
const router = express.Router();
router.use(requireCapability("social.manage"));
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const socialChannels = ["instagram", "facebook", "linkedin", "x"];
router.get(
  "/communications",
  wrap(async (req, res) =>
    res.json(
      await ConversationMessage.find({
        workspaceId: req.auth.workspaceId,
        direction: "outbound",
      })
        .select("subject body createdAt")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ),
  ),
);
router.get(
  "/settings",
  wrap(async (req, res) => {
    const config = await WorkspaceConfig.findOne({
      workspaceId: req.auth.workspaceId,
      key: "primary",
    })
      .select("ambassadorOnboarding")
      .lean();
    res.json(
      config?.ambassadorOnboarding || {
        requiredFields: ["headshot", "bio"],
        welcomeDraftOnComplete: false,
      },
    );
  }),
);
router.post(
  "/settings",
  wrap(async (req, res) => {
    const requiredFields = [
      ...new Set(
        (req.body.requiredFields || []).filter((field) =>
          [
            "headshot",
            "bio",
            "instagram",
            "linkedin",
            "company",
            "website",
            "timezone",
          ].includes(field),
        ),
      ),
    ];
    if (!requiredFields.length)
      return res
        .status(400)
        .json({ error: "Choose at least one required onboarding field" });
    const config = await WorkspaceConfig.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, key: "primary" },
      {
        $set: {
          ambassadorOnboarding: {
            requiredFields,
            welcomeDraftOnComplete: req.body.welcomeDraftOnComplete === true,
          },
        },
      },
      { new: true, upsert: true, runValidators: true },
    );
    res.json(config.ambassadorOnboarding);
  }),
);
router.get(
  "/overview",
  wrap(async (req, res) => {
    const workspaceId = req.auth.workspaceId;
    const [content, threads, identities, tasks, activity] = await Promise.all([
      ContentBrief.find({ workspaceId, type: "social" })
        .select(
          "title status social.requestedPublishAt social.publications createdAt",
        )
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean(),
      ConversationThread.find({ workspaceId, channel: { $in: socialChannels } })
        .select("unreadCount status channel")
        .lean(),
      SocialIdentity.countDocuments({ workspaceId }),
      AmbassadorContentTask.countDocuments({ workspaceId }),
      CrmActivity.find({
        workspaceId,
        "metadata.eventType": /^(social\.|ambassador\.)/,
      })
        .sort({ occurredAt: -1 })
        .limit(30)
        .lean(),
    ]);
    res.json({
      content,
      counts: {
        drafts: content.filter((x) =>
          ["draft", "pending_approval"].includes(x.status),
        ).length,
        scheduled: content.filter((x) => x.status === "scheduled").length,
        published: content.filter((x) => x.status === "published").length,
        needsReply: threads.filter((x) => x.status === "open").length,
        unread: threads.reduce((n, x) => n + x.unreadCount, 0),
        identifiableContacts: identities,
        ambassadorTasks: tasks,
      },
      activity,
      boundedContentCount: content.length,
    });
  }),
);
router.get(
  "/accounts",
  wrap(async (req, res) => {
    const connections = await Promise.all(
      ["meta", "instagram", "linkedin", "x"].map((provider) =>
        oauth.status(req.auth.workspaceId, provider),
      ),
    );
    res.json({
      connections,
      ai: llm.getStatus(),
      publishingEnabled: process.env.SOCIAL_PUBLISHING_ENABLED === "true",
      automaticRepliesEnabled:
        process.env.META_AUTOMATIC_REPLIES_ENABLED === "true",
      capabilityChecklist: (() => {
        const meta =
          connections.find((connection) => connection.provider === "meta") ||
          {};
        const instagram =
          connections.find(
            (connection) => connection.provider === "instagram",
          ) || {};
        const hasPermission = (connection, names) =>
          names.some((name) => (connection.scopes || []).includes(name));
        return [
          {
            key: "instagram-comments",
            label: "Instagram comments and approved private replies",
            ready: hasPermission(instagram, [
              "instagram_business_manage_comments",
              "instagram_manage_comments",
            ]),
            review: true,
          },
          {
            key: "instagram-messages",
            label: "Instagram direct messages",
            ready: hasPermission(instagram, [
              "instagram_business_manage_messages",
              "instagram_manage_messages",
            ]),
            review: true,
          },
          {
            key: "facebook-comments",
            label: "Facebook Page comments and moderation",
            ready: hasPermission(meta, [
              "pages_manage_engagement",
              "pages_read_user_content",
            ]),
            review: true,
          },
          {
            key: "messenger",
            label: "Messenger conversations and replies",
            ready: hasPermission(meta, ["pages_messaging"]),
            review: true,
          },
          {
            key: "publishing",
            label: "Publishing to connected accounts",
            ready:
              process.env.SOCIAL_PUBLISHING_ENABLED === "true" &&
              hasPermission(meta, ["pages_manage_posts"]),
            review: true,
          },
          {
            key: "lead-attribution",
            label: "CRM lead capture and tracked website CTAs",
            ready: true,
            review: false,
          },
        ];
      })(),
    });
  }),
);
router.get(
  "/analytics",
  wrap(async (req, res) => {
    const workspaceId = req.auth.workspaceId;
    const [links, applications, events] = await Promise.all([
      TrackedLink.find({ workspaceId })
        .select("provider contentId clickCount contactId")
        .limit(1000)
        .lean(),
      CoachingApplication.find({
        workspaceId,
        "attribution.provider": {
          $in: ["instagram", "facebook", "linkedin", "x"],
        },
      })
        .select(
          "attribution.provider attribution.contentId status contactId salesOpportunityId submittedAt",
        )
        .limit(1000)
        .lean(),
      SocialProviderEvent.find({ workspaceId })
        .select("provider contentBriefId contactId eventType")
        .limit(1000)
        .lean(),
    ]);
    const opportunities = applications
      .map((app) => app.salesOpportunityId)
      .filter(Boolean);
    const enrollments = opportunities.length
      ? await Enrollment.find({
          workspaceId,
          sourceOpportunityId: { $in: opportunities },
        })
          .select("sourceOpportunityId status")
          .lean()
      : [];
    const providerInsights =
      await metaInsights.fetchWorkspaceInsights(workspaceId);
    res.json({
      rows: socialChannels.map((provider) => ({
        provider,
        interactions: events.filter((event) => event.provider === provider)
          .length,
        identifiableContacts: new Set(
          events
            .filter((event) => event.provider === provider && event.contactId)
            .map((event) => String(event.contactId)),
        ).size,
        trackedClicks: links
          .filter((link) => link.provider === provider)
          .reduce((total, link) => total + (link.clickCount || 0), 0),
        attributedApplications: applications.filter(
          (app) => app.attribution.provider === provider,
        ).length,
        linkedEnrollments: enrollments.filter((enrollment) =>
          applications.some(
            (app) =>
              app.attribution.provider === provider &&
              String(app.salesOpportunityId) ===
                String(enrollment.sourceOpportunityId),
          ),
        ).length,
      })),
      attributionNote:
        "Applications carry recorded provider attribution; enrollments are linked through the application's sales opportunity. These are known associations, not proof that social caused a purchase. Counts cover up to 1,000 records per source.",
      providerInsights,
      metricsNote: providerInsights.note,
    });
  }),
);
router.get(
  "/inbox",
  wrap(async (req, res) => {
    const query = {
      workspaceId: req.auth.workspaceId,
      channel: { $in: socialChannels },
    };
    if (socialChannels.includes(req.query.provider))
      query.channel = req.query.provider;
    if (req.query.filter === "unread") query.unreadCount = { $gt: 0 };
    if (req.query.filter === "needs_reply") query.status = "open";
    if (req.query.filter === "assigned") query.assignedTo = req.auth.user._id;
    // Comments and mentions are replies to a specific public post, not a
    // direct-message conversation — they get their own section (?type=
    // comments) so the inbox itself only ever shows real DM threads.
    query["metadata.interactionType"] =
      req.query.type === "comments"
        ? { $in: ["comment", "mention"] }
        : { $nin: ["comment", "mention"] };
    const data = await ConversationThread.find(query)
      .populate("contactIds", "name")
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean();
    res.json(data);
  }),
);
router.get("/inbox/stream", (req, res) => {
  // Server-Sent Events: pushes a notice the instant a new message is saved
  // for this workspace, so the inbox updates immediately instead of on a
  // fixed polling interval (which browsers throttle heavily in background
  // tabs — the exact case where polling silently falls behind). Registered
  // before /inbox/:id so "stream" is never matched as a thread id.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const unsubscribe = require("../services/realtimeEvents").subscribe(
    req.auth.workspaceId,
    (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
  );
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
router.get(
  "/inbox/:id",
  wrap(async (req, res) => {
    const thread = await ConversationThread.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
      channel: { $in: socialChannels },
    })
      .populate("contactIds", "name")
      .lean();
    if (!thread)
      return res.status(404).json({ error: "Social conversation not found" });
    const messages = await ConversationMessage.find({
      workspaceId: req.auth.workspaceId,
      threadId: thread._id,
      deletedAt: null,
    })
      .populate("createdBy", "name")
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    const identity = thread.contactIds?.[0]
      ? await SocialIdentity.findOne({
          workspaceId: req.auth.workspaceId,
          contactId: thread.contactIds[0]._id,
          provider: thread.channel,
        })
          .select("username displayName avatarUrl providerUserId")
          .lean()
      : null;
    if (
      ["comment", "mention"].includes(thread.metadata?.interactionType) &&
      thread.metadata?.contentId &&
      !thread.metadata?.postContext
    ) {
      const postContext = await require("../services/metaRecentPostService").postContext({
        workspaceId: req.auth.workspaceId,
        provider: thread.channel,
        assetId: thread.metadata.assetId,
        postId: thread.metadata.contentId,
      });
      if (postContext) {
        await ConversationThread.updateOne(
          { _id: thread._id },
          { $set: { "metadata.postContext": postContext } },
        );
        thread.metadata.postContext = postContext;
      }
    }
    res.json({
      thread,
      messages,
      identity,
      socialAi: await socialAiService.latest(req.auth.workspaceId, thread._id),
    });
  }),
);
router.post(
  "/inbox/:id/ai-assist",
  wrap(async (req, res) => {
    const result = await socialAiService.analyze({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      auth: req.auth,
      threadId: req.params.id,
      action: req.body.action,
      extraInstruction: req.body.extraInstruction,
      forceRegenerate: req.body.forceRegenerate === true,
      forceAi: true,
    });
    res.json(result);
  }),
);
router.get(
  "/social-ai/settings",
  wrap(async (req, res) =>
    res.json(await socialAiService.getConfig(req.auth.workspaceId)),
  ),
);
router.patch(
  "/social-ai/settings",
  wrap(async (req, res) => {
    const allowed = socialAiService.INTENTS.filter((intent) =>
      (req.body.allowedIntents || []).includes(intent),
    );
    const config = await WorkspaceConfig.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, key: "primary" },
      {
        $set: {
          socialAi: {
            analysisEnabled: req.body.analysisEnabled === true,
            suggestedRepliesEnabled: req.body.suggestedRepliesEnabled !== false,
            qualificationAssistanceEnabled:
              req.body.qualificationAssistanceEnabled !== false,
            humanApprovalRequired: true,
            confidenceThreshold: Math.min(
              1,
              Math.max(0, Number(req.body.confidenceThreshold) || 0.78),
            ),
            allowedIntents: allowed.length ? allowed : socialAiService.INTENTS,
          },
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    res.json(config.socialAi);
  }),
);
router.get(
  "/social-ai/analytics",
  wrap(async (req, res) =>
    res.json(await socialAiService.analytics(req.auth.workspaceId)),
  ),
);
router.get(
  "/automation-controls",
  requireCapability("workspace.manage"),
  wrap(async (req, res) =>
    res.json({
      policy: await automationPolicyService.get(req.auth.workspaceId),
      environment: {
        socialPublishingEnabled:
          process.env.SOCIAL_PUBLISHING_ENABLED === "true",
        metaAutomaticRepliesEnabled:
          process.env.META_AUTOMATIC_REPLIES_ENABLED === "true",
      },
    }),
  ),
);
router.patch(
  "/automation-controls",
  requireCapability("workspace.manage"),
  wrap(async (req, res) =>
    res.json({
      policy: await automationPolicyService.save(
        req.auth.workspaceId,
        req.body || {},
      ),
    }),
  ),
);
router.get(
  "/automation-actions",
  requireCapability("workspace.manage"),
  wrap(async (req, res) => {
    const rows = await AutomationActionRun.find({
      workspaceId: req.auth.workspaceId,
    })
      .select(
        "actorType principal userId triggerType triggerId agent actionType provider targetType targetId status policyDecision approvalId attemptCount providerResultCategory failureCategory correlationId createdAt updatedAt completedAt",
      )
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Math.max(1, Number(req.query.limit) || 50)))
      .lean();
    res.json({ actions: rows });
  }),
);
router.post(
  "/automation-actions/:id/prepare-approval",
  requireCapability("workspace.manage"),
  wrap(async (req, res) =>
    res.json(
      await automationActionService.prepareApproval({
        workspaceId: req.auth.workspaceId,
        runId: req.params.id,
        userId: req.auth.user._id,
      }),
    ),
  ),
);
router.post(
  "/automation-actions/:id/execute",
  requireCapability("workspace.manage"),
  wrap(async (req, res) => {
    const actor = {
      actorType: "user",
      workspaceId: String(req.auth.workspaceId),
      userId: req.auth.user._id,
      effectivePermissions: req.auth.effectivePermissions,
    };
    const run = await automationExecutorService.executeRequest(
      {
        workspaceId: req.auth.workspaceId,
        runId: req.params.id,
        approvalId: req.body.approvalId,
        confirmation: req.body.confirmation,
        actor,
      },
      automationActionService,
    );
    res.json({ action: run });
  }),
);
router.post(
  "/inbox/:id/reply",
  wrap(async (req, res) => {
    if (req.body.approved !== true)
      return res
        .status(400)
        .json({ error: "Explicit reply approval is required" });
    const thread = await ConversationThread.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
      channel: { $in: ["instagram", "facebook"] },
    }).lean();
    if (!thread)
      return res
        .status(404)
        .json({ error: "Replyable conversation not found" });
    if (thread.metadata?.interactionType === "comment")
      return res.status(409).json({
        error:
          "Human comment/private-reply controls are not implemented yet; do not initiate an unsolicited DM.",
      });
    const recipient = thread.participants.find(
      (person) => person.kind === "contact",
    );
    if (!recipient)
      return res.status(409).json({ error: "Identifiable recipient required" });
    const result = await metaMessagingAdapter.sendMessage({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      senderType: "human",
      threadId: thread._id,
      channel: thread.channel,
      assetId: thread.metadata.assetId,
      recipientId: recipient.address,
      body: req.body.body,
    });
    res.json(result);
  }),
);
router.post(
  "/inbox/:id/comment-actions",
  wrap(async (req, res) => {
    if (req.body.approved !== true)
      return res.status(400).json({
        error: "Explicit approval is required for this Meta comment action",
      });
    try {
      const result = await pageEngagement.perform({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.user._id,
        threadId: req.params.id,
        action: req.body.action,
        body: req.body.body,
        idempotencyKey: req.body.idempotencyKey,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  }),
);
router.post(
  "/inbox/:id/read",
  wrap(async (req, res) => {
    const thread = await ConversationThread.findOneAndUpdate(
      {
        workspaceId: req.auth.workspaceId,
        _id: req.params.id,
        channel: { $in: socialChannels },
      },
      { $set: { unreadCount: 0 } },
      { new: true },
    );
    if (!thread)
      return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true });
  }),
);
router.post(
  "/inbox/:id/messages/:messageId/delete",
  wrap(async (req, res) => {
    const thread = await ConversationThread.findOne({
      _id: req.params.id,
      workspaceId: req.auth.workspaceId,
      channel: { $in: socialChannels },
    });
    if (!thread)
      return res.status(404).json({ error: "Conversation not found" });
    // Removes the message from Lead Porch only. Instagram and Facebook do not
    // offer any API for a business to unsend a message on the provider's side —
    // unsend is a manual, sender-only action inside their own apps.
    const message = await ConversationMessage.findOneAndUpdate(
      {
        _id: req.params.messageId,
        threadId: thread._id,
        workspaceId: req.auth.workspaceId,
        deletedAt: null,
      },
      { $set: { deletedAt: new Date(), deletedBy: req.auth.user._id } },
      { new: true },
    );
    if (!message)
      return res.status(404).json({ error: "Message not found" });
    const remaining = await ConversationMessage.find({
      workspaceId: req.auth.workspaceId,
      threadId: thread._id,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(1)
      .lean();
    if (!remaining.length) {
      // The contact itself stays in the CRM — only the now-empty conversation
      // shell is removed so it stops showing stale preview/unread state.
      await ConversationThread.deleteOne({ _id: thread._id });
      return res.json({ success: true, threadDeleted: true });
    }
    await ConversationThread.updateOne(
      { _id: thread._id },
      {
        $set: {
          preview: String(remaining[0].body || "").slice(0, 1000),
          lastMessageAt: remaining[0].createdAt,
        },
      },
    );
    res.json({ success: true, threadDeleted: false });
  }),
);
router.get(
  "/relations",
  wrap(async (req, res) =>
    res.json({
      offerings: await CoachingProgram.find({
        workspaceId: req.auth.workspaceId,
      })
        .select("name status")
        .lean(),
      events: await Event.find({ workspaceId: req.auth.workspaceId })
        .select("name title")
        .lean(),
    }),
  ),
);
router.get(
  "/media",
  wrap(async (req, res) => {
    const items = await ContentBrief.find({
      workspaceId: req.auth.workspaceId,
      type: "social",
      "social.media.0": { $exists: true },
    })
      .select("title social.media")
      .limit(200)
      .lean();
    res.json(
      items.flatMap((item) =>
        (item.social.media || []).map((asset) => ({
          ...asset,
          contentId: item._id,
          title: item.title,
        })),
      ),
    );
  }),
);
router.post(
  "/media",
  wrap(async (req, res) => {
    const asset = await media.uploadImage({
      file: req.body.file,
      folder: `growth-operator/social/${req.auth.workspaceId}`,
    });
    res.status(201).json({
      ...asset,
      type: "image",
      alt: String(req.body.alt || "").slice(0, 500),
    });
  }),
);
const AI_ACTIONS = [
  "Generate post",
  "Rewrite",
  "Shorten",
  "Expand",
  "Change tone",
  "Generate platform variants",
  "Generate hashtags",
  "Generate CTA",
  "Generate keyword CTA",
  "Generate ambassador version",
  "Generate image brief",
  "Generate content ideas",
  "Repurpose existing content",
];
router.post(
  "/generate",
  wrap(async (req, res) => {
    if (!AI_ACTIONS.includes(req.body.action))
      return res
        .status(400)
        .json({ error: "Choose a supported content action" });
    if (!llm.isEnabled())
      return res.status(409).json({
        error: "AI setup required. Manual content creation is available.",
      });
    const workspaceId = req.auth.workspaceId;
    const config = await WorkspaceConfig.findOne({
      workspaceId,
      key: "primary",
    })
      .select("workspaceName publicSite branding")
      .lean();
    let source = String(req.body.body || "").slice(0, 10000);
    if (req.body.messageId) {
      const message = await ConversationMessage.findOne({
        workspaceId,
        _id: req.body.messageId,
      })
        .select("body")
        .lean();
      if (!message)
        return res
          .status(404)
          .json({ error: "Source communication not found" });
      source = message.body;
    }
    const offerings = await CoachingProgram.find({ workspaceId })
      .select("name description")
      .limit(40)
      .lean();
    const body = await llm.chat({
      message: `${req.body.action}. Instructions: ${String(req.body.instructions || "").slice(0, 3000)}. Produce editable social copy only; do not claim publication. Do not invent business facts. The workspace is the school/business; offerings are courses/programs and events are separate. Content is independent; never assume a course/event relationship.`,
      context: JSON.stringify({ workspace: config, offerings, source }),
      profile: { name: "Jarvis" },
    });
    if (req.body.action === "Generate platform variants") {
      const variants = [];
      for (const provider of ["instagram", "facebook", "linkedin", "x"]) {
        const variant = await llm.chat({
          message: `Rewrite the supplied caption specifically for ${provider}. Return only the caption. Preserve facts; do not invent claims. For X keep it within 280 characters. No publishing actions.`,
          context: JSON.stringify({
            source: body,
            workspace: config?.workspaceName,
          }),
          profile: { name: "Jarvis" },
        });
        variants.push({
          provider,
          body: variant.slice(0, provider === "x" ? 280 : 10000),
          hashtags: [],
          cta: "",
        });
      }
      return res.json({
        body,
        variants,
        source: "jarvis",
        reviewRequired: true,
      });
    }
    res.json({ body, source: "jarvis", reviewRequired: true });
  }),
);
router.post(
  "/content/:id/distribute",
  wrap(async (req, res) =>
    res.status(201).json(
      await distribution.assign({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.user._id,
        contentId: req.params.id,
        input: req.body,
      }),
    ),
  ),
);
router.get(
  "/distribution",
  wrap(async (req, res) =>
    res.json(
      await AmbassadorContentTask.find({ workspaceId: req.auth.workspaceId })
        .populate("ambassadorProfileId", "displayName")
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
    ),
  ),
);
router.get(
  "/content/:id/history",
  wrap(async (req, res) => {
    const workspaceId = req.auth.workspaceId,
      contentBriefId = req.params.id;
    if (
      !(await ContentBrief.exists({
        _id: contentBriefId,
        workspaceId,
        type: "social",
      }))
    )
      return res.status(404).json({ error: "Content not found" });
    res.json({
      activity: await CrmActivity.find({
        workspaceId,
        "metadata.contentBriefId": contentBriefId,
      })
        .sort({ occurredAt: -1 })
        .limit(100)
        .lean(),
      interactions: await SocialProviderEvent.find({
        workspaceId,
        contentBriefId,
      })
        .select("provider eventType occurredAt contactId automationId")
        .limit(100)
        .lean(),
      tasks: await AmbassadorContentTask.find({
        workspaceId,
        contentBriefId,
      }).lean(),
    });
  }),
);
// Facebook's comment webhook keys post_id/comment_id off the post's internal
// "story"/object ID, which is frequently a different number than the
// page-post ID our own publish call stored (both refer to the same post —
// a longstanding Facebook Graph API quirk). Matching by that ID's text is
// unreliable, so for Facebook we additionally ask the post's own /comments
// edge which comment IDs really belong to it, and match on those directly.
// Instagram has no such split, so contentId matching alone is enough there.
async function knownIdsForPublications(workspaceId, publications) {
  const providerPostIds = new Set();
  const commentIds = new Set();
  const metaRecentPostService = require("../services/metaRecentPostService");
  await Promise.all(
    publications.map(async (row) => {
      if (!row.providerPostId) return;
      providerPostIds.add(row.providerPostId);
      if (row.provider !== "facebook" || !row.assetId) return;
      providerPostIds.add(`${row.assetId}_${row.providerPostId}`);
      const bare = String(row.providerPostId).split("_").pop();
      if (bare) providerPostIds.add(bare);
      const ids = await metaRecentPostService.postCommentIds({
        workspaceId,
        assetId: row.assetId,
        postId: row.providerPostId,
      });
      (ids || []).forEach((id) => commentIds.add(id));
    }),
  );
  return { providerPostIds, commentIds };
}
router.get(
  "/content/:id/comments",
  wrap(async (req, res) => {
    const workspaceId = req.auth.workspaceId;
    const item = await ContentBrief.findOne({
      _id: req.params.id,
      workspaceId,
      type: "social",
    })
      .select("social.publications")
      .lean();
    if (!item) return res.status(404).json({ error: "Content not found" });
    const { providerPostIds, commentIds } = await knownIdsForPublications(
      workspaceId,
      item.social?.publications || [],
    );
    if (!providerPostIds.size && !commentIds.size)
      return res.json({ threads: [] });
    const threads = await ConversationThread.find({
      workspaceId,
      channel: { $in: socialChannels },
      "metadata.interactionType": { $in: ["comment", "mention"] },
      $or: [
        { "metadata.contentId": { $in: [...providerPostIds] } },
        { "metadata.commentId": { $in: [...commentIds] } },
      ],
    })
      .populate("contactIds", "name")
      .sort({ lastMessageAt: -1 })
      .lean();
    const withMessages = await Promise.all(
      threads.map(async (thread) => ({
        thread,
        messages: await ConversationMessage.find({
          workspaceId,
          threadId: thread._id,
          deletedAt: null,
        })
          .populate("createdBy", "name")
          .sort({ createdAt: 1 })
          .lean(),
      })),
    );
    res.json({ threads: withMessages });
  }),
);
router.get(
  "/content/comments/unlinked",
  wrap(async (req, res) => {
    // Comments and mentions only ever show up per-post on that post's own
    // Content Library card, matched by its Facebook/Instagram post ID. A
    // comment on a post that was published outside Lead Porch, or whose
    // ContentBrief record was later deleted, has no card to appear under and
    // would otherwise become permanently invisible — this lists exactly
    // those orphaned threads so nothing gets lost.
    const workspaceId = req.auth.workspaceId;
    const items = await ContentBrief.find({ workspaceId, type: "social" })
      .select("social.publications")
      .lean();
    const publications = items.flatMap((item) => item.social?.publications || []);
    const { providerPostIds, commentIds } = await knownIdsForPublications(
      workspaceId,
      publications,
    );
    const threads = await ConversationThread.find({
      workspaceId,
      channel: { $in: socialChannels },
      "metadata.interactionType": { $in: ["comment", "mention"] },
      "metadata.contentId": { $nin: [...providerPostIds] },
      "metadata.commentId": { $nin: [...commentIds] },
    })
      .populate("contactIds", "name")
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean();
    const withMessages = await Promise.all(
      threads.map(async (thread) => ({
        thread,
        messages: await ConversationMessage.find({
          workspaceId,
          threadId: thread._id,
          deletedAt: null,
        })
          .populate("createdBy", "name")
          .sort({ createdAt: 1 })
          .lean(),
      })),
    );
    res.json({ threads: withMessages });
  }),
);
router.get(
  "/content/:id/insights",
  wrap(async (req, res) => {
    const workspaceId = req.auth.workspaceId;
    const item = await ContentBrief.findOne({
      _id: req.params.id,
      workspaceId,
      type: "social",
    })
      .select("social.publications")
      .lean();
    if (!item) return res.status(404).json({ error: "Content not found" });
    const metaRecentPostService = require("../services/metaRecentPostService");
    const rows = (item.social?.publications || []).filter(
      (row) =>
        ["facebook", "instagram"].includes(row.provider) &&
        row.providerPostId,
    );
    const destinations = await Promise.all(
      rows.map(async (row) => ({
        provider: row.provider,
        assetId: row.assetId,
        engagement: await metaRecentPostService.postEngagement({
          workspaceId,
          provider: row.provider,
          assetId: row.assetId,
          postId: row.providerPostId,
        }),
      })),
    );
    res.json({ destinations });
  }),
);
module.exports = router;
