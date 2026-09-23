const integrationHub = require("./integrationHub");
const IntegrationConnection = require("../models/IntegrationConnection");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const EmailSuppression = require("../models/EmailSuppression");
const {
  createUnsubscribeToken,
  publicBackendUrl,
} = require("../utils/unsubscribe");

// Confirmed live via Resend's send log: 106 campaign emails went out in a
// single hour (2026-09-22 19:00 UTC) to 106 recipients this domain had never
// contacted before, dispatched by 5 parallel workers with no pacing — the
// only prior cap was "100 selected drafts per HTTP request," a request-size
// limit, not a deliverability throttle. A sudden volume spike like that from
// a domain with almost no prior sending history is exactly the shape Gmail's
// bulk-sender heuristics are built to catch, independent of SPF/DKIM/DMARC
// (all of which were already correct). This rolling-window cap is the real
// fix: it applies inside sendEmail itself so every caller (manual "Send
// selected", the scheduled auto-send pipeline) is protected the same way,
// no matter how many drafts get approved/selected at once.
//
// RAMP_START_DATE anchors an automatic warm-up: raising the cap every day to
// match however many new leads Discovery happens to find would recreate the
// exact burst pattern above on a rolling basis, permanently — the fix for
// deliverability and the desire for more daily volume are the same lever,
// not two separate ones. Instead the cap grows on a fixed, conservative
// schedule (25% every 3 days) regardless of lead volume, capped at a ceiling
// well above what a single day's sending window needs. EMAIL_SEND_HOURLY_LIMIT
// still overrides this entirely when explicitly set, for a manual hard cap.
const RAMP_START_DATE = new Date("2026-09-23T00:00:00Z");
const RAMP_BASE = 100;
const RAMP_GROWTH_PER_PERIOD = 1.25;
const RAMP_PERIOD_DAYS = 3;
const RAMP_CEILING = 500;

function rampedHourlyLimit() {
  const daysSinceStart = Math.max(0, (Date.now() - RAMP_START_DATE.getTime()) / (24 * 60 * 60 * 1000));
  const periods = Math.floor(daysSinceStart / RAMP_PERIOD_DAYS);
  return Math.min(RAMP_CEILING, Math.round(RAMP_BASE * RAMP_GROWTH_PER_PERIOD ** periods));
}

const sendTimestamps = [];
function checkHourlySendCap() {
  const limit = Math.max(1, Number(process.env.EMAIL_SEND_HOURLY_LIMIT) || rampedHourlyLimit());
  const windowMs = 60 * 60 * 1000;
  const now = Date.now();
  while (sendTimestamps.length && now - sendTimestamps[0] > windowMs) sendTimestamps.shift();
  if (sendTimestamps.length >= limit) {
    const retryInMinutes = Math.ceil((windowMs - (now - sendTimestamps[0])) / 60000);
    return {
      allowed: false,
      message: `Paused for deliverability: this domain is still building sending reputation, so campaign email is capped at ${limit}/hour right now (rising automatically every ${RAMP_PERIOD_DAYS} days as long as it stays safe). Try again in about ${retryInMinutes} minute${retryInMinutes === 1 ? "" : "s"}, or set EMAIL_SEND_HOURLY_LIMIT to override this manually.`,
    };
  }
  sendTimestamps.push(now);
  return { allowed: true };
}

async function renderEmailContent(
  outreachItem,
  { contact = null, preview = false, unsubscribeUrlOverride = "" } = {},
) {
  const workspace = outreachItem.workspaceId
    ? await Workspace.findById(outreachItem.workspaceId)
        .select("name publicHosts")
        .lean()
    : null;
  const workspaceConfig = await WorkspaceConfig.findOne({
    ...(outreachItem.workspaceId
      ? { workspaceId: outreachItem.workspaceId }
      : {}),
    key: "primary",
  }).lean();
  if (!workspaceConfig?.postalAddress?.trim() && !preview) {
    throw new Error(
      "Add the business mailing address in Settings before sending campaign email.",
    );
  }
  const resolvedContact =
    contact ||
    (outreachItem.contactId
      ? await Contact.findById(outreachItem.contactId)
      : await Contact.findOne({
          email: String(outreachItem.contactEmail || "").toLowerCase(),
        }));
  const unsubscribeUrl = unsubscribeUrlOverride || (resolvedContact
    ? `${publicBackendUrl()}/api/unsubscribe/${encodeURIComponent(createUnsubscribeToken(resolvedContact))}`
    : "#");
  const businessName =
    workspaceConfig?.legalBusinessName || workspace?.name || "Lead Porch";
  const postalAddress =
    workspaceConfig?.postalAddress ||
    (preview ? "Business postal address from Settings" : "");
  const websiteUrl = String(workspaceConfig?.websiteUrl || "").trim();
  const complianceText = `This promotional message was sent because we believed this opportunity may be relevant to your professional work.\n${businessName}${postalAddress ? ` · ${postalAddress}` : ""}${websiteUrl ? ` · ${websiteUrl}` : ""}\nUnsubscribe: ${unsubscribeUrl}`;
  const footerHtml = `<div style="margin-top:36px;padding-top:20px;border-top:1px solid #ddd7ca;color:#737b77;font-size:12px;line-height:1.6;text-align:center"><div style="margin-bottom:8px">This promotional message was sent because we believed this opportunity may be relevant to your professional work.</div><div><strong>${String(businessName).replace(/[<>&"]/g, "")}</strong></div>${postalAddress ? `<div>${String(postalAddress).replace(/[<>&"]/g, "")}</div>` : ""}${websiteUrl ? `<div><a href="${websiteUrl.replace(/"/g, "&quot;")}" style="color:#506b63">${websiteUrl.replace(/[<>&"]/g, "")}</a></div>` : ""}<div style="margin-top:8px"><a href="${unsubscribeUrl}" style="color:#506b63">Unsubscribe from campaign emails</a></div></div>`;
  const text = `${outreachItem.emailDraft || ""}\n\n—\n${complianceText}`;
  let html =
    outreachItem.htmlBody ||
    `<html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;">${(
      outreachItem.emailDraft || ""
    )
      .split(/\n{2,}/)
      .map(
        (paragraph) =>
          `<p>${String(paragraph).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replaceAll("\n", "<br>")}</p>`,
      )
      .join("")}</body></html>`;
  // No logo is ever auto-inserted here — the sender controls entirely
  // whether one appears and where, by dragging it into the Unlayer editor
  // themselves (see CampaignWorkspace.jsx's "Insert logo" control).
  html = html.includes("</body>")
    ? html.replace("</body>", `${footerHtml}</body>`)
    : `${html}${footerHtml}`;
  return { text, html, unsubscribeUrl };
}

// ======================================
// SEND EMAIL
// ======================================

/**
 * Shared eligibility gate for ANY automated/campaign email send — suppression,
 * CRM contact existence, verified-email requirement, and topic-specific
 * marketing opt-in. Every code path that sends email on the recipient's
 * behalf (not a one-off admin connectivity test) must call this first; see
 * marketingCampaignExecution.js for the bulk-send caller.
 *
 * `allowUnverified` is an explicit marketing-send exception and is never
 * honored for cold business prospecting. `deliveryPurpose` may bypass only
 * the subscriber/topic checks; suppression, unsubscribe, invalid/archive,
 * bounce, CRM identity, and verified-address checks still apply.
 */
async function checkSendEligibility(recipientEmail, { contactId, emailTopic, allowUnverified = false, deliveryPurpose = "marketing" } = {}) {
  const recipient = String(recipientEmail || "").trim();
  if (!recipient) return { eligible: false, message: "No recipient email found." };

  const suppression = await EmailSuppression.findOne({
    email: recipient.toLowerCase().trim(),
  }).lean();
  if (suppression) {
    return {
      eligible: false,
      message: `This address is suppressed because of a previous ${suppression.reason.replaceAll("_", " ")}.`,
    };
  }

  const contact = contactId
    ? await Contact.findById(contactId)
    : await Contact.findOne({ email: recipient.toLowerCase() });
  if (["invalid", "archived"].includes(contact?.status)) {
    return { eligible: false, message: "This contact is invalid or archived and cannot receive campaign email." };
  }
  if (
    contact?.status === "unsubscribed" ||
    contact?.emailPreferences?.marketingStatus === "unsubscribed"
  ) {
    return { eligible: false, message: "This contact unsubscribed from campaign email." };
  }
  if (!contact) {
    return { eligible: false, message: "A CRM contact is required before campaign email can be sent." };
  }
  if (contact.emailStatus === "undeliverable" || contact.emailBounced === true) {
    return {
      eligible: false,
      message: "This email address is known to bounce and cannot be sent to.",
    };
  }
  if (contact.emailStatus !== "verified" && (!allowUnverified || deliveryPurpose === "business_prospecting")) {
    return {
      eligible: false,
      message: "This email address is not verified. Verify or directly confirm the corrected address before sending.",
    };
  }
  // A cold business-prospecting message is not a marketing subscription.
  // It may bypass only the affirmative opt-in/topic checks below. Suppression,
  // unsubscribe, invalid/bounced state, CRM identity, and address verification
  // above remain mandatory for every send.
  if (deliveryPurpose === "business_prospecting") return { eligible: true, contact };
  if (
    contact.emailPreferences?.marketingStatus !== "subscribed" ||
    !contact.emailPreferences?.consentAt
  ) {
    return {
      eligible: false,
      message: "This contact has no recorded marketing opt-in. Verified email is not the same as permission to send.",
    };
  }
  // "general" campaigns (MarketingCampaign's schema default) have no
  // narrower topic checkbox of their own — the baseline subscribed +
  // consentAt check above is their gate. Only the three specific topics
  // require their own explicit opt-in checkbox.
  if ((emailTopic || "event_invitations") === "general") return { eligible: true, contact };
  const topicField = {
    event_invitations: "eventInvitations",
    program_offers: "programOffers",
    educational_newsletter: "educationalNewsletter",
  }[emailTopic || "event_invitations"];
  if (!topicField || contact.emailPreferences?.topics?.[topicField] !== true) {
    return {
      eligible: false,
      message: `This contact has not subscribed to ${String(emailTopic || "this email topic").replaceAll("_", " ")}.`,
    };
  }
  return { eligible: true, contact };
}

async function sendEmail(outreachItem, { allowUnverified = false, deliveryPurpose = "marketing" } = {}) {
  if (!outreachItem) {
    return {
      success: false,
      message: "Missing outreach item.",
    };
  }

  const recipient = outreachItem.contactEmail || process.env.TEST_EMAIL;

  const eligibility = await checkSendEligibility(recipient, {
    contactId: outreachItem.contactId,
    emailTopic: outreachItem.emailTopic,
    allowUnverified,
    deliveryPurpose,
  });
  if (!eligibility.eligible) {
    return { success: false, message: eligibility.message };
  }
  const cap = checkHourlySendCap();
  if (!cap.allowed) {
    return { success: false, message: cap.message };
  }
  const contact = eligibility.contact;
  let rendered;
  try {
    rendered = await renderEmailContent(outreachItem, { contact });
  } catch (error) {
    return { success: false, message: error.message };
  }
  const { text, html, unsubscribeUrl } = rendered;

  try {
    const workspaceConfig = await WorkspaceConfig.findOne({
      ...(outreachItem.workspaceId
        ? { workspaceId: outreachItem.workspaceId }
        : {}),
      key: "primary",
    }).lean();
    const workspace = outreachItem.workspaceId
      ? await Workspace.findById(outreachItem.workspaceId)
          .select("name publicHosts")
          .lean()
      : null;
    const gmailConnection = await IntegrationConnection.findOne({
      ...(outreachItem.workspaceId
        ? { workspaceId: outreachItem.workspaceId }
        : {}),
      provider: "gmail",
      status: "connected",
    }).select("settings");
    const replyTo =
      String(workspaceConfig?.invitationIdentity?.replyToEmail || "").trim() ||
      String(process.env.EMAIL_REPLY_TO || "").trim() ||
      String(gmailConnection?.settings?.email || "").trim();
    const senderEmail = String(
      workspaceConfig?.invitationIdentity?.senderEmail || "",
    ).trim();
    const senderName = String(
      workspaceConfig?.invitationIdentity?.senderName ||
        workspace?.name ||
        workspaceConfig?.workspaceName ||
        "Lead Porch",
    ).trim();

    if (!senderEmail && workspace?.publicHosts?.length) {
      return {
        success: false,
        message:
          "Set the workspace invitation sender email in Organization Profile before sending.",
      };
    }
    const response = await integrationHub.execute("resend", "sendEmail", {
      from:
        (senderEmail ? `${senderName} <${senderEmail}>` : "") ||
        process.env.EMAIL_FROM ||
        `${senderName} <onboarding@resend.dev>`,
      to: recipient,
      subject: outreachItem.subject || `A message from ${senderName}`,
      text,
      html,
      replyTo,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey: outreachItem._id ? `outreach/${outreachItem._id}` : undefined,
    });

    console.log("✅ Email sent via Resend");

    return {
      success: true,

      message: "Email sent successfully.",

      id: response.messageId,
    };
  } catch (error) {
    console.error("SEND EMAIL ERROR");

    return {
      success: false,

      message: error.message,
    };
  }
}

async function sendTestEmail(
  outreachItem,
  recipient = "team@elliescoaching.com",
) {
  if (!outreachItem) {
    return { success: false, message: "Missing outreach item." };
  }

  try {
    // The real send path (sendEmail, above) includes List-Unsubscribe
    // headers on every message, AND sends from the workspace's configured
    // person (e.g. "Ellie Baxter <team@elliescoaching.com>") — this test
    // path was silently dropping the header AND sending from a generic
    // fallback display name ("Ellies Coaching"/"Growth Operator") instead,
    // via a completely different, unauthenticated-feeling identity. A
    // test was never actually previewing what a real send looks like; it
    // was previewing a strictly worse version of it. Confirmed live: real
    // campaign sends used "Ellie Baxter <team@elliescoaching.com>" while
    // every test send used "Ellies Coaching <team@elliescoaching.com>".
    // Use a real one-click-shaped URL without attaching the test mailbox to
    // the lead's suppression record. A tester clicking Unsubscribe must never
    // accidentally unsubscribe the contact whose draft is being reviewed.
    const testUnsubscribeUrl = `${publicBackendUrl()}/api/unsubscribe/test-preview`;
    const { text, html, unsubscribeUrl } = await renderEmailContent(outreachItem, {
      preview: true,
      unsubscribeUrlOverride: testUnsubscribeUrl,
    });
    const workspaceConfig = await WorkspaceConfig.findOne({
      ...(outreachItem.workspaceId ? { workspaceId: outreachItem.workspaceId } : {}),
      key: "primary",
    }).lean();
    const workspace = outreachItem.workspaceId
      ? await Workspace.findById(outreachItem.workspaceId).select("name").lean()
      : null;
    const gmailConnection = await IntegrationConnection.findOne({
      ...(outreachItem.workspaceId ? { workspaceId: outreachItem.workspaceId } : {}),
      provider: "gmail",
      status: "connected",
    }).select("settings");
    const replyTo =
      String(workspaceConfig?.invitationIdentity?.replyToEmail || "").trim() ||
      String(process.env.EMAIL_REPLY_TO || "").trim() ||
      String(gmailConnection?.settings?.email || "").trim();
    const senderEmail = String(workspaceConfig?.invitationIdentity?.senderEmail || "").trim();
    const senderName = String(
      workspaceConfig?.invitationIdentity?.senderName ||
        workspace?.name ||
        workspaceConfig?.workspaceName ||
        "Lead Porch",
    ).trim();
    const response = await integrationHub.execute("resend", "sendEmail", {
      from:
        (senderEmail ? `${senderName} <${senderEmail}>` : "") ||
        process.env.EMAIL_FROM ||
        `${senderName} <onboarding@resend.dev>`,
      to: recipient,
      // A deliverability test must be byte-for-byte representative of the
      // production subject. Prefixing it with "[TEST]" made Gmail evaluate a
      // different message than the one leads receive.
      subject: outreachItem.subject || "A message from Ellie's Coaching",
      text,
      html,
      replyTo,
      headers: unsubscribeUrl ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      } : undefined,
    });
    return {
      success: true,
      message: `Test email sent to ${recipient}.`,
      id: response.messageId,
      recipient,
      senderEmail,
      sameAddressWarning:
        senderEmail.toLowerCase() === String(recipient).trim().toLowerCase()
          ? "This test was sent from and to the same address. Gmail may treat self-sent mail from a third-party delivery service as suspicious, so use a different mailbox for a representative inbox-placement test."
          : "",
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

module.exports = {
  checkSendEligibility,
  renderEmailContent,
  sendEmail,
  sendTestEmail,
};
