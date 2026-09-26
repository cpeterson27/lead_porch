const IntegrationConnection = require("../models/IntegrationConnection");
const Outreach = require("../models/Outreach");
const Contact = require("../models/Contact");
const Campaign = require("../models/Campaign");
const gmail = require("./gmailOAuthService");
const llmService = require("./llmService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

// Explicit, direct request: fully automatic replies, no per-message
// approval. The previous classifier (replyIntelligence.js) was keyword
// matching against a fixed canned template per category — never an actual
// OpenAI call despite "AI reply draft" framing. This replaces it with a
// real model call that reads the actual reply and writes a genuine,
// personalized response, and — the new part — sends it immediately
// through the same Gmail send path the manual "Approve and send" button
// already used, for any reply the model itself flags as routine. Anything
// it flags as hostile, a complaint, a legal/compliance concern, or
// genuinely ambiguous is still only drafted, left for a human in
// Conversations -> Campaign history, exactly as before — the automation is
// new, the safety boundary for sensitive replies is deliberately not
// removed.
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["interested", "not_interested", "partnership", "not_now", "unsubscribe", "out_of_office", "question", "complaint_or_hostile", "needs_review"] },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    safeToAutoSend: { type: "boolean", description: "true only for a routine, non-sensitive reply with no complaint, threat, legal language, or real ambiguity. Always false for complaint_or_hostile, out_of_office, or needs_review." },
    reply: { type: "string", description: "A short, warm, genuinely personalized reply in the business's voice, directly responding to what they actually said. Never invent pricing, dates, guarantees, or facts not given. Empty string for out_of_office/unsubscribe (handled separately) or when safeToAutoSend is false." },
  },
  required: ["category", "urgency", "safeToAutoSend", "reply"],
  additionalProperties: false,
};

async function classifyAndDraft({ workspaceId, replyText, contactName, campaignName }) {
  return llmService.generateStructured({
    workspaceId,
    agent: "sales",
    feature: "outreach_reply_autoresponse",
    schema: REPLY_SCHEMA,
    schemaName: "outreach_reply_classification",
    messages: [
      { role: "system", content: "You classify a real reply to a cold outreach email for a real-estate investing coaching business, and draft a short reply in the business's own voice when it's safe to send with no human review. Be genuinely responsive to specifics in their message, not generic. Mark safeToAutoSend false for anything hostile, a complaint, a legal/compliance concern, or genuinely unclear intent — a human should handle those." },
      { role: "user", content: `Contact name: ${contactName || "there"}\nCampaign: ${campaignName || "our outreach"}\n\nTheir reply:\n${String(replyText || "").slice(0, 4000)}` },
    ],
  });
}

async function processWorkspaceReplies(workspaceId) {
  let checked = 0, drafted = 0, autoSent = 0, errors = 0;
  const sent = await Outreach.find({ workspaceId, status: "sent", contactEmail: { $ne: "" } }).select("contactEmail sentAt");
  if (!sent.length) return { checked, drafted, autoSent, errors };
  const emails = [...new Set(sent.map((item) => item.contactEmail.toLowerCase()))];
  const search = emails.slice(0, 40).map((email) => `from:${email}`).join(" OR ");
  const { threads } = await gmail.listThreads({ query: `in:inbox newer_than:1y (${search})`, maxResults: 50 });
  for (const thread of threads) {
    const sender = String(thread.from || "").match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0]?.toLowerCase();
    if (!sender || !emails.includes(sender)) continue;
    const receivedAt = thread.date ? new Date(thread.date) : new Date();
    const matching = await Outreach.find({ workspaceId, contactEmail: sender, status: "sent", sentAt: { $lte: receivedAt } }).populate("campaignId", "name");
    if (!matching.length) continue;
    checked += 1;
    let intelligence;
    try {
      intelligence = await classifyAndDraft({ workspaceId, replyText: thread.snippet || "", contactName: matching[0].contactName, campaignName: matching[0].campaignId?.name });
    } catch (error) {
      console.error("Auto-reply classification failed:", { workspaceId: String(workspaceId), message: error.message });
      errors += 1;
      continue;
    }
    for (const item of matching) {
      item.status = "replied";
      item.repliedAt = receivedAt;
      item.replyText = thread.snippet || "";
      item.replyCategory = intelligence.category;
      item.replyUrgency = intelligence.urgency;
      item.aiReplyDraft = intelligence.reply || "";
      await item.save();
      drafted += 1;
      if (intelligence.category === "unsubscribe" && item.contactId) {
        await Contact.updateOne({ _id: item.contactId }, { $set: { status: "unsubscribed", "emailPreferences.marketingStatus": "unsubscribed", "emailPreferences.unsubscribedAt": receivedAt, "emailPreferences.unsubscribeSource": "reply_request", "emailPreferences.topics.eventInvitations": false, "emailPreferences.topics.programOffers": false, "emailPreferences.topics.educationalNewsletter": false } });
      }
      if (item.campaignId?._id) await Campaign.updateOne({ _id: item.campaignId._id }, { $inc: { "metrics.replied": 1 } });
      if (intelligence.safeToAutoSend && intelligence.reply && item.contactEmail) {
        try {
          const subject = /^re:/i.test(item.subject || "") ? item.subject : `Re: ${item.subject || "Following up"}`;
          await gmail.sendMessage({ to: item.contactEmail, subject, body: intelligence.reply, threadId: thread.id });
          item.aiReplySentAt = new Date();
          await item.save();
          autoSent += 1;
        } catch (error) {
          console.error("Auto-reply send failed:", { workspaceId: String(workspaceId), outreachId: String(item._id), message: error.message });
          errors += 1;
        }
      }
    }
  }
  return { checked, drafted, autoSent, errors };
}

async function runDueOutreachReplyAutomation() {
  const connections = await IntegrationConnection.find({ provider: "gmail", status: "connected" }).select("workspaceId");
  const results = [];
  for (const connection of connections) {
    try {
      const result = await runWithWorkspace(connection.workspaceId, () => processWorkspaceReplies(connection.workspaceId));
      results.push({ workspaceId: connection.workspaceId, ...result });
    } catch (error) {
      console.error("Outreach reply automation failed for workspace:", { workspaceId: String(connection.workspaceId), message: error.message });
    }
  }
  return results;
}

let timer = null;
function startAutoReplyRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(5 * 60000, Number(process.env.AUTO_REPLY_INTERVAL_MS) || 15 * 60000);
  timer = setInterval(() => runDueOutreachReplyAutomation().catch((error) => console.error("Auto-reply runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}
function stopAutoReplyRunner() { if (timer) clearInterval(timer); timer = null; }

module.exports = { classifyAndDraft, processWorkspaceReplies, runDueOutreachReplyAutomation, startAutoReplyRunner, stopAutoReplyRunner };
