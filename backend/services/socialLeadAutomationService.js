const crypto = require("crypto");
const Contact = require("../models/Contact");
const SocialIdentity = require("../models/SocialIdentity");
const SocialAutomation = require("../models/SocialAutomation");
const SocialProviderEvent = require("../models/SocialProviderEvent");
const TrackedLink = require("../models/TrackedLink");
const CrmActivity = require("../models/CrmActivity");
const ContentBrief = require("../models/ContentBrief");
const ConversationMessage = require("../models/ConversationMessage");
const Workspace = require("../models/Workspace");
const {
  ingestProviderMessage,
} = require("./conversations/conversationIngestionService");
const backgroundSocialAiService = require("./backgroundSocialAiService");

const models = {
  Contact,
  SocialIdentity,
  SocialAutomation,
  SocialProviderEvent,
  TrackedLink,
  CrmActivity,
  ContentBrief,
  ConversationMessage,
  Workspace,
};
const SUPPORTED_TRIGGERS = Object.freeze({
  instagram: [
    "dm_keyword",
    "dm_any",
    "story_reply",
    "comment_any",
    "comment_keyword",
    "mention",
    "postback",
    "referral",
    "optin",
  ],
  facebook: [
    "dm_keyword",
    "dm_any",
    "comment_any",
    "comment_keyword",
    "mention",
    "postback",
    "referral",
    "optin",
  ],
  tiktok: ["lead_form"],
  linkedin: [],
  x: [],
});
const UNSUPPORTED_ENGAGEMENTS = new Set([
  "like",
  "view",
  "save",
  "share",
  "reaction",
  "follow",
]);

function clean(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function normalizedKeywords(values) {
  return [
    ...new Set(
      (values || []).map((v) => clean(v, 80).toLowerCase()).filter(Boolean),
    ),
  ];
}
function normalizedLabels(values) {
  const labels = [],
    seen = new Set();
  for (const value of values || []) {
    const label = clean(value, 80),
      key = label.toLocaleLowerCase();
    if (label && !seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}
function mergeLabels(existing, additions) {
  const labels = [...(existing || [])];
  const seen = new Set(
    labels.map((value) => clean(value, 80).toLocaleLowerCase()).filter(Boolean),
  );
  for (const label of normalizedLabels(additions)) {
    const key = label.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}
function containsKeyword(text, keywords) {
  const value = clean(text, 5000).toLowerCase();
  return keywords.some((keyword) => value.includes(keyword));
}
function attributionFrom(event, automation) {
  return {
    provider: event.provider,
    campaignId: automation?.campaignId || event.campaignId || null,
    contentId: event.contentId || automation?.contentId || "",
    contentBriefId: event.contentBriefId || null,
    automationId: automation?._id || null,
    occurredAt: event.occurredAt || new Date(),
    utm: event.utm || {},
  };
}

async function reserveEvent(event, deps = models) {
  if (!event.providerEventId)
    throw new Error("A provider event ID is required");
  // Honor receipts written before asset-scoped event keys were introduced.
  // Verify the associated identity before accepting a legacy key.
  if (event.legacyProviderEventId) {
    const legacy = await deps.SocialProviderEvent.findOne({
      provider: event.provider,
      providerEventId: event.legacyProviderEventId,
    });
    if (
      legacy?.socialIdentityId &&
      (await deps.SocialIdentity.findOne({
        _id: legacy.socialIdentityId,
        provider: event.provider,
        providerAssetId: event.assetId,
        providerUserId: event.providerUserId,
      }))
    ) {
      return reserveEvent(
        {
          ...event,
          providerEventId: event.legacyProviderEventId,
          legacyProviderEventId: null,
        },
        deps,
      );
    }
  }
  try {
    return {
      record: await deps.SocialProviderEvent.create({
        provider: event.provider,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        sourceMetadata: {
          ...event.sourceMetadata,
          assetId: event.assetId,
          contentId: event.contentId,
          providerUserId: event.providerUserId,
        },
        payloadHash: crypto
          .createHash("sha256")
          .update(JSON.stringify(event.raw || event))
          .digest("hex"),
        occurredAt: event.occurredAt || new Date(),
      }),
      duplicate: false,
    };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const record = await deps.SocialProviderEvent.findOne({
      provider: event.provider,
      providerEventId: event.providerEventId,
    });
    if (
      deps.SocialProviderEvent.findOneAndUpdate &&
      record?.processingStatus &&
      record.processingStatus !== "processed"
    ) {
      const claimed = await deps.SocialProviderEvent.findOneAndUpdate(
        {
          _id: record._id,
          $or: [
            { processingStatus: "failed" },
            {
              processingStatus: "processing",
              processingStartedAt: { $lt: new Date(Date.now() - 5 * 60000) },
            },
          ],
        },
        {
          $set: {
            processingStatus: "processing",
            processingStartedAt: new Date(),
            lastError: "",
          },
        },
        { new: true },
      );
      if (claimed) return { record: claimed, duplicate: false };
      // Keep the provider retrying rather than acknowledging an unfinished event.
      throw new Error("Social event is still processing; retry delivery");
    }
    return { record, duplicate: true };
  }
}

async function resolveIdentity(event, deps = models) {
  const identityFilter = {
    provider: event.provider,
    providerAssetId: event.assetId || "",
    providerUserId: event.providerUserId,
  };
  let identity = await deps.SocialIdentity.findOne(identityFilter);
  let contact = identity
    ? await deps.Contact.findById(identity.contactId)
    : null;
  let created = false;
  if (!contact) {
    const name = clean(
      event.displayName || event.username || `${event.provider} contact`,
      180,
    );
    contact = await deps.Contact.create({
      name,
      firstName: name,
      sources: [`social:${event.provider}`],
      sourceProvider: `social:${event.provider}`,
      type: "lead",
      status: "active",
      tags: ["social-lead"],
    });
    try {
      identity = await deps.SocialIdentity.create({
        contactId: contact._id,
        ...identityFilter,
        username: clean(event.username),
        displayName: clean(event.displayName),
        avatarUrl: clean(event.avatarUrl, 2000),
        providerThreadId: clean(event.providerThreadId, 1000),
        sourceMetadata: event.sourceMetadata || {},
        lastActivityAt: event.occurredAt || new Date(),
      });
      created = true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (deps.Contact.deleteOne)
        await deps.Contact.deleteOne({ _id: contact._id });
      identity = await deps.SocialIdentity.findOne(identityFilter);
      contact = identity
        ? await deps.Contact.findById(identity.contactId)
        : null;
      if (!identity || !contact)
        throw new Error(
          "Social identity could not be resolved after concurrent creation",
        );
    }
  } else {
    identity.username = clean(event.username) || identity.username;
    identity.displayName = clean(event.displayName) || identity.displayName;
    identity.avatarUrl = clean(event.avatarUrl, 2000) || identity.avatarUrl;
    identity.providerThreadId =
      clean(event.providerThreadId, 1000) || identity.providerThreadId;
    identity.lastActivityAt = event.occurredAt || new Date();
    await identity.save();
    // A message-derived contact starts with a generic placeholder name because
    // the webhook payload alone never carries the sender's real name — repair
    // it once a profile lookup (or a comment payload, which does include one)
    // resolves a real name or username.
    const genericName = `${event.provider} contact`;
    const betterName = clean(event.displayName || event.username, 180);
    if (betterName && String(contact.name || "").toLowerCase() === genericName) {
      contact.name = betterName;
      contact.firstName = betterName;
      await contact.save();
    }
  }
  return { contact, identity, created };
}

async function matchingAutomation(event, deps = models) {
  if (!SUPPORTED_TRIGGERS[event.provider]?.includes(event.triggerType))
    return null;
  const candidates = await deps.SocialAutomation.find({
    provider: event.provider,
    assetId: event.assetId,
    enabled: true,
    $or: [{ contentId: event.contentId || "" }, { contentId: "" }],
  }).sort({ createdAt: 1 });
  candidates.sort(
    (a, b) =>
      Number(Boolean(b.contentId)) - Number(Boolean(a.contentId)) ||
      Number(["comment_keyword", "dm_keyword"].includes(b.triggerType)) -
        Number(["comment_keyword", "dm_keyword"].includes(a.triggerType)),
  );
  return (
    candidates
      .filter((item) => !item.contentBriefId || item.contentId)
      .find((item) => {
        if (
          item.triggerType !== event.triggerType &&
          !(
            event.triggerType === "comment_any" &&
            item.triggerType === "comment_keyword"
          ) &&
          !(event.triggerType === "dm_keyword" && item.triggerType === "dm_any")
        )
          return false;
        return (
          !["comment_keyword", "dm_keyword"].includes(item.triggerType) ||
          containsKeyword(event.text, item.keywords || [])
        );
      }) || null
  );
}

async function applyAttribution(contact, event, automation) {
  const attribution = attributionFrom(event, automation);
  if (!contact.socialAttribution?.first?.provider)
    contact.set("socialAttribution.first", attribution);
  contact.set("socialAttribution.latest", attribution);
  contact.sources = [
    ...new Set([...(contact.sources || []), `social:${event.provider}`]),
  ];
  const tags = automation?.tags || [];
  contact.tags = mergeLabels(contact.tags, ["social-lead", ...tags]);
  if (automation?.qualification?.length)
    contact.additionalFields = {
      ...(contact.additionalFields || {}),
      socialIntent: [
        ...new Set([
          ...(contact.additionalFields?.socialIntent || []),
          ...automation.qualification,
        ]),
      ],
    };
  await contact.save();
}

async function writeActivity(deps, values) {
  const key = [
    values.metadata.provider,
    values.metadata.providerEventId,
    values.metadata.eventType,
  ].join(":");
  values.metadata.socialEventKey = key;
  if (!deps.CrmActivity.findOneAndUpdate)
    return deps.CrmActivity.create(values);
  try {
    return await deps.CrmActivity.findOneAndUpdate(
      { "metadata.socialEventKey": key },
      { $setOnInsert: values },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    return null;
  }
}

async function activity(deps, contact, event, automation, identityCreated) {
  if (identityCreated)
    await writeActivity(deps, {
      contactId: contact._id,
      type: "system",
      title: "Social lead created",
      source: "integration",
      metadata: {
        eventType: "social.lead.created",
        provider: event.provider,
        assetId: event.assetId,
        providerEventId: event.providerEventId,
      },
    });
  const eventType =
    event.eventType === "comment_received" &&
    automation?.triggerType === "comment_keyword"
      ? "social.keyword.matched"
      : `social.${event.eventType.replaceAll("_", ".")}`;
  await writeActivity(deps, {
    contactId: contact._id,
    campaignId: automation?.campaignId || event.campaignId || null,
    type: "system",
    direction:
      event.eventType.includes("received") || event.eventType === "story_reply"
        ? "inbound"
        : "",
    title: identityCreated ? "Social lead created" : eventType,
    source: "integration",
    occurredAt: event.occurredAt || new Date(),
    metadata: {
      ...event.sourceMetadata,
      providerUserId: event.providerUserId,
      eventType,
      provider: event.provider,
      assetId: event.assetId,
      contentId: event.contentId || "",
      contentBriefId: event.contentBriefId || null,
      automationId: automation?._id || null,
      providerEventId: event.providerEventId,
    },
  });
  if (identityCreated)
    await writeActivity(deps, {
      contactId: contact._id,
      type: "system",
      title: "Social identity linked",
      source: "integration",
      metadata: {
        eventType: "social.identity.linked",
        provider: event.provider,
        providerEventId: event.providerEventId,
      },
    });
}

async function ingestSocialEvent(event, options = {}) {
  const deps = options.models || models;
  if (
    UNSUPPORTED_ENGAGEMENTS.has(event.eventType) ||
    UNSUPPORTED_ENGAGEMENTS.has(event.triggerType)
  )
    return { ignored: true, reason: "unsupported_engagement" };
  const recordOnly =
    event.recordOnly === true ||
    ["lifecycle", "record_only"].includes(event.triggerType);
  if (
    !recordOnly &&
    !SUPPORTED_TRIGGERS[event.provider]?.includes(event.triggerType) &&
    event.eventType !== "dm_received"
  )
    return { ignored: true, reason: "unsupported_provider_trigger" };
  if (!event.assetId || (!event.providerUserId && !event.contextOnly))
    return { ignored: true, reason: "identity_unavailable" };
  const reserved = await reserveEvent(event, deps);
  if (reserved.duplicate) return { duplicate: true, event: reserved.record };
  try {
    if (
      event.recordOnly &&
      event.sourceMetadata?.messageIds?.length &&
      deps.ConversationMessage?.updateMany
    ) {
      const deliveryStatus =
        event.eventType === "message_delivered" ? "delivered" : "read";
      await deps.ConversationMessage.updateMany(
        {
          provider: "meta",
          providerMessageId: { $in: event.sourceMetadata.messageIds },
        },
        {
          $set: {
            deliveryStatus,
            ...(deliveryStatus === "delivered"
              ? { deliveredAt: event.occurredAt }
              : { readAt: event.occurredAt }),
          },
        },
      );
    }
    if (event.contextOnly) {
      await writeActivity(deps, {
        type: "system",
        title: "Social interaction received without a person identity",
        source: "integration",
        occurredAt: event.occurredAt,
        metadata: {
          eventType: "social.context.received",
          provider: event.provider,
          assetId: event.assetId,
          contentId: event.contentId,
          providerEventId: event.providerEventId,
          ...event.sourceMetadata,
        },
      });
      reserved.record.processingStatus = "processed";
      reserved.record.processedAt = new Date();
      await reserved.record.save();
      return { contextOnly: true, event: reserved.record };
    }
    if (event.contentId && deps.ContentBrief) {
      const published = await deps.ContentBrief.findOne({
        type: "social",
        status: { $in: ["published", "partially_published"] },
        social: { $exists: true },
        "social.publications": {
          $elemMatch: {
            provider: event.provider,
            assetId: String(event.assetId || ""),
            providerPostId: String(event.contentId),
            status: "published",
          },
        },
      }).lean();
      if (published) {
        event = {
          ...event,
          contentBriefId: published._id,
          campaignId: published.campaignId || event.campaignId || null,
        };
        reserved.record.contentBriefId = published._id;
      }
    }
    const { contact, identity, created } = await resolveIdentity(event, deps);
    console.log(`[Social lead automation] contact ${created ? "created" : "matched"}: provider=${event.provider} assetId=${event.assetId} contactId=${contact._id}`);
    const automation = recordOnly
      ? null
      : await matchingAutomation(event, deps);
    if (!recordOnly) await applyAttribution(contact, event, automation);
    await activity(deps, contact, event, automation, created);
    let conversation = null;
    if (
      event.sourceMetadata?.edited &&
      event.messageId &&
      deps.ConversationMessage?.updateOne
    )
      await deps.ConversationMessage.updateOne(
        {
          provider: "meta",
          providerMessageId: event.messageId,
          direction: "inbound",
        },
        { $set: { body: event.text, "metadata.editedAt": event.occurredAt } },
      );
    if (
      [
        "dm_received",
        "story_reply",
        "comment_received",
        "mention_received",
        "postback_received",
        "referral_received",
        "optin_received",
        "message_reaction",
        "lead_form_received",
      ].includes(event.eventType)
    ) {
      conversation = await (options.ingestMessage || ingestProviderMessage)({
        thread: {
          channel: event.provider,
          provider: "meta",
          providerThreadId:
            event.providerThreadId ||
            `${event.provider}:${event.assetId}:${event.providerUserId}${event.eventType === "comment_received" ? `:comment:${event.sourceMetadata?.commentId || event.providerEventId}` : ""}`,
          participants: [
            {
              kind: "contact",
              role: "from",
              address: event.providerUserId,
              contactId: contact._id,
            },
          ],
          contactIds: [contact._id],
          metadata: {
            assetId: event.assetId,
            socialOrigin: true,
            contentId: event.contentId || "",
            interactionType:
              event.eventType === "comment_received"
                ? "comment"
                : event.eventType === "mention_received"
                  ? "mention"
                  : "message",
            sourceMetadata: event.sourceMetadata || {},
            commentId: event.sourceMetadata?.commentId || "",
          },
        },
        message: {
          opensMessagingWindow:
            event.opensMessagingWindow !== false &&
            ![
              "comment_received",
              "mention_received",
              "referral_received",
            ].includes(event.eventType),
          providerMessageId: event.messageId || event.providerEventId,
          direction: "inbound",
          body: event.text || "",
          sender: {
            name: event.displayName || event.username || "",
            address: event.providerUserId,
          },
          recipients: [{ address: event.assetId, role: "to" }],
          contactId: contact._id,
          deliveryStatus: "received",
          sentAt: event.occurredAt || new Date(),
          metadata: {
            socialIdentityId: identity._id,
            automationId: automation?._id || null,
          },
        },
      });
      console.log(`[Social lead automation] conversation ${conversation.created ? "created" : "matched"}, inbound message saved: threadId=${conversation.thread._id} channel=${event.provider} messageId=${conversation.message._id}`);
    }
    let responseTemplate = automation?.responseTemplate || "";
    const ctaDestination = clean(automation?.cta?.destination, 2000);
    if (ctaDestination) {
      let responseUrl = ctaDestination;
      if (
        (await isAllowedDestination(
          ctaDestination,
          reserved.record.workspaceId,
          deps,
        )) &&
        deps.TrackedLink
      ) {
        const tracked = await createTrackedLink(
          {
            destination: ctaDestination,
            workspaceId: reserved.record.workspaceId,
            provider: event.provider,
            contactId: contact._id,
            campaignId: automation?.campaignId || null,
            automationId: automation?._id || null,
            assetId: event.assetId || "",
            contentId: event.contentId || "",
            utm: event.utm || {},
            idempotencyKey: `social-event:${reserved.record._id}`,
          },
          null,
          deps,
        );
        const base = String(process.env.PUBLIC_BACKEND_URL || "").replace(
          /\/$/,
          "",
        );
        if (base)
          responseUrl = `${base}/api/social-automation/t/${tracked.token}`;
      }
      responseTemplate = [responseTemplate, automation?.cta?.label, responseUrl]
        .filter(Boolean)
        .join("\n");
    }
    reserved.record.contactId = contact._id;
    reserved.record.socialIdentityId = identity._id;
    reserved.record.automationId = automation?._id || null;
    await reserved.record.save();
    reserved.record.reply = {
      status:
        responseTemplate && event.replyPolicy && event.replyPolicy !== "none"
          ? "pending"
          : "none",
      body: responseTemplate,
      policy: event.replyPolicy || "none",
      assetId: event.assetId,
      recipientId: event.providerUserId,
      commentId: event.sourceMetadata?.commentId || "",
      connectionProvider: event.connectionProvider || "meta",
      threadId: conversation?.thread?._id || null,
    };
    reserved.record.processingStatus = "processed";
    reserved.record.processedAt = new Date();
    await reserved.record.save();
    const backgroundAi = await (
      options.backgroundSocialAi || backgroundSocialAiService.processInbound
    )({
      workspaceId: reserved.record.workspaceId,
      providerEventId: reserved.record.providerEventId,
      conversation,
      automation,
    }).catch(() => ({ skippedReason: "background_analysis_failed_safely" }));
    return {
      duplicate: false,
      contact,
      contactCreated: created,
      identity,
      automation,
      conversation,
      responseTemplate,
      backgroundAi,
      event: reserved.record,
    };
  } catch (error) {
    reserved.record.processingStatus = "failed";
    reserved.record.lastError =
      "Social event processing failed; delivery can be retried";
    await reserved.record.save();
    throw error;
  }
}

function allowedDestination(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      [
        "elliescoaching.com",
        "www.elliescoaching.com",
        "eventbrite.com",
        "www.eventbrite.com",
      ].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}
async function isAllowedDestination(value, workspaceId, deps = models) {
  if (allowedDestination(value)) return true;
  if (!workspaceId || !deps.Workspace?.findById) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const query = deps.Workspace.findById(workspaceId);
    const workspace =
      typeof query?.lean === "function" ? await query.lean() : await query;
    return (workspace?.publicHosts || []).some(
      (host) => String(host).toLowerCase() === url.hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}
async function createTrackedLink(values, actorUserId, deps = models) {
  if (
    !(await isAllowedDestination(values.destination, values.workspaceId, deps))
  )
    throw new Error(
      "Tracked links must use an approved HTTPS workspace website or Eventbrite destination",
    );
  if (values.idempotencyKey) {
    const existing = await deps.TrackedLink.findOne({
      idempotencyKey: values.idempotencyKey,
    });
    if (existing) return existing;
  }
  let link;
  try {
    link = await deps.TrackedLink.create({
      ...values,
      token: crypto.randomBytes(18).toString("base64url"),
      createdBy: actorUserId,
    });
  } catch (error) {
    if (error.code === 11000 && values.idempotencyKey)
      return deps.TrackedLink.findOne({
        idempotencyKey: values.idempotencyKey,
      });
    throw error;
  }
  await deps.CrmActivity.create({
    contactId: values.contactId || null,
    campaignId: values.campaignId || null,
    type: "system",
    title: "Social tracked link generated",
    source: "integration",
    createdBy: actorUserId,
    metadata: {
      eventType: "social.link.generated",
      provider: values.provider,
      contentId: values.contentId || "",
      trackedLinkId: link._id,
    },
  });
  return link;
}

module.exports = {
  SUPPORTED_TRIGGERS,
  allowedDestination,
  isAllowedDestination,
  containsKeyword,
  createTrackedLink,
  ingestSocialEvent,
  matchingAutomation,
  mergeLabels,
  normalizedKeywords,
  normalizedLabels,
  resolveIdentity,
};
