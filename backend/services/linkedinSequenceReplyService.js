/**
 * Drafts (and, only when a sequence explicitly opts in, sends) an
 * objection-handling / meeting-booking reply to an inbound LinkedIn message
 * that belongs to an active LinkedinSequenceEnrollment.
 *
 * Every reply is drafted by AI; it is only ever sent without a human click
 * when LinkedinSequence.autonomousSendEnabled is true for that sequence
 * (default false). This is deliberately a narrower, LinkedIn-sequence-only
 * exception to this app's general rule that AI-drafted social replies
 * always require human review (see services/socialAiService.js /
 * services/backgroundSocialAiService.js) — nothing about that broader rule
 * is changed here.
 */
const llmService = require("./llmService");
const unipile = require("./unipileService");
const ConversationMessage = require("../models/ConversationMessage");
const CrmActivity = require("../models/CrmActivity");
const InAppNotification = require("../models/InAppNotification");

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "The LinkedIn DM reply text, under 700 characters, warm and non-pushy." },
    meetingBooked: { type: "boolean", description: "True only if the person has just clearly agreed to a specific meeting/call." },
  },
  required: ["reply", "meetingBooked"],
  additionalProperties: false,
};

async function recentHistory(threadId, limit = 10) {
  const messages = await ConversationMessage.find({ threadId, kind: "message" })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("direction body createdAt")
    .lean();
  return messages.reverse();
}

async function draftReply({ workspaceId, sequence, contact, history }) {
  const transcript = history
    .map((m) => `${m.direction === "inbound" ? "Them" : "Us"}: ${m.body}`)
    .join("\n");
  const firstName = String(contact.firstName || contact.name || "there").trim().split(/\s+/)[0];
  const systemPrompt = [
    "You are a warm, concise professional continuing a LinkedIn DM conversation on behalf of the sender.",
    "Handle objections naturally, stay conversational, and never sound like a script.",
    "Your goal is to invite the person to book a short call.",
    sequence.calendarBookingUrl
      ? `When the person shows real interest, share this booking link exactly once: ${sequence.calendarBookingUrl}`
      : "There is no booking link configured; if they want to meet, ask for their availability directly instead.",
    "Keep the reply under 700 characters. Never invent facts about the sender's company that aren't in the conversation.",
  ].join(" ");
  const result = await llmService.generateStructured({
    workspaceId,
    agent: "social",
    feature: "linkedin_sequence_reply",
    schema: REPLY_SCHEMA,
    schemaName: "linkedin_reply",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Conversation so far with ${firstName}:\n${transcript}\n\nDraft the next reply.` },
    ],
  });
  return result;
}

async function notifyForReview(workspaceId, enrollment, draftMessage) {
  await InAppNotification.findOneAndUpdate(
    { workspaceId, userId: null, eventKey: `linkedin-sequence-reply:${draftMessage._id}` },
    {
      $setOnInsert: {
        type: "social_automation_attention",
        title: "LinkedIn reply drafted — needs review",
        message: "Open the LinkedIn sequence inbox to review and send the AI-drafted reply.",
        actionUrl: "/social/inbox",
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * Called after an inbound LinkedIn message has already been threaded via
 * ingestProviderMessage. Drafts a reply; sends it immediately only if the
 * sequence has autonomous sending turned on, otherwise leaves it as a
 * deliveryStatus:"draft" ConversationMessage for human review/edit/send
 * (see routes/socialLinkedinOutreach.js's reply-review endpoints).
 */
async function handleInboundReply({ workspaceId, sequence, enrollment, contact, thread }) {
  // An inbound reply always halts the remaining timed follow-ups. From here
  // the conversation is reply-led, not sequence-led.
  enrollment.status = "awaiting_reply";
  enrollment.nextActionDueAt = null;
  await enrollment.save();
  contact.linkedinOutreach = {
    ...contact.linkedinOutreach,
    status: "replied",
    connectionStatus: "accepted",
  };
  await contact.save();
  const history = await recentHistory(thread._id);
  let drafted;
  try {
    drafted = await draftReply({ workspaceId, sequence, contact, history });
  } catch (error) {
    await CrmActivity.create({
      contactId: contact._id,
      type: "system",
      title: "LinkedIn reply drafting failed",
      source: "integration",
      metadata: { eventType: "social.linkedin.reply_draft_failed", detail: error.message },
    });
    return { skipped: true, reason: error.code || "draft_failed" };
  }

  const draftMessage = await ConversationMessage.create({
    threadId: thread._id,
    channel: "linkedin",
    provider: "linkedin_unipile",
    providerMessageId: `linkedin-draft:${enrollment._id}:${Date.now()}`,
    direction: "outbound",
    kind: "message",
    body: drafted.reply,
    deliveryStatus: "draft",
    contactId: contact._id,
    metadata: { enrollmentId: enrollment._id, sequenceId: sequence._id, meetingBooked: Boolean(drafted.meetingBooked) },
  });

  if (!sequence.autonomousSendEnabled) {
    await notifyForReview(workspaceId, enrollment, draftMessage);
    return { sent: false, draftMessage };
  }

  await unipile.sendChatMessage({ chatId: enrollment.unipileChatId, text: drafted.reply });
  draftMessage.deliveryStatus = "sent";
  draftMessage.sentAt = new Date();
  await draftMessage.save();
  if (drafted.meetingBooked) {
    enrollment.status = "meeting_booked";
    enrollment.nextActionDueAt = null;
    await enrollment.save();
    await CrmActivity.create({
      contactId: contact._id,
      type: "system",
      title: "Meeting booked via LinkedIn sequence",
      source: "integration",
      metadata: { eventType: "social.linkedin.meeting_booked", sequenceId: sequence._id },
    });
  }
  return { sent: true, draftMessage };
}

module.exports = { draftReply, handleInboundReply, recentHistory };
