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

async function renderEmailContent(
  outreachItem,
  { contact = null, preview = false } = {},
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
  const unsubscribeUrl = resolvedContact
    ? `${publicBackendUrl()}/api/unsubscribe/${encodeURIComponent(createUnsubscribeToken(resolvedContact))}`
    : "#";
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
  const organizationLogo = String(
    workspaceConfig?.branding?.publicSiteLogoUrl ||
      workspaceConfig?.organizationLogoUrl ||
      "",
  ).trim();
  if (organizationLogo && !html.includes(organizationLogo)) {
    const logoHtml = `<div style="margin:0 0 28px"><img src="${organizationLogo.replace(/"/g, "&quot;")}" alt="${String(businessName).replace(/[<>&"]/g, "")}" style="display:block;max-height:84px;max-width:220px;object-fit:contain"></div>`;
    html = html.includes("<body")
      ? html.replace(/(<body[^>]*>)/i, `$1${logoHtml}`)
      : `${logoHtml}${html}`;
  }
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
 */
async function checkSendEligibility(recipientEmail, { contactId, emailTopic } = {}) {
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
  if (
    contact?.status === "unsubscribed" ||
    contact?.emailPreferences?.marketingStatus === "unsubscribed"
  ) {
    return { eligible: false, message: "This contact unsubscribed from campaign email." };
  }
  if (!contact) {
    return { eligible: false, message: "A CRM contact is required before campaign email can be sent." };
  }
  if (contact.emailStatus !== "verified") {
    return {
      eligible: false,
      message: "This email address is not verified. Verify or directly confirm the corrected address before sending.",
    };
  }
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

async function sendEmail(outreachItem) {
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
  });
  if (!eligibility.eligible) {
    return { success: false, message: eligibility.message };
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
    const { text, html } = await renderEmailContent(outreachItem, {
      preview: true,
    });
    const gmailConnection = await IntegrationConnection.findOne({
      provider: "gmail",
      status: "connected",
    }).select("settings");
    const replyTo =
      String(process.env.EMAIL_REPLY_TO || "").trim() ||
      String(gmailConnection?.settings?.email || "").trim();
    const response = await integrationHub.execute("resend", "sendEmail", {
      from: process.env.EMAIL_FROM || "Growth Operator <onboarding@resend.dev>",
      to: recipient,
      subject: `[TEST] ${outreachItem.subject || "A message from Ellie's Coaching"}`,
      text,
      html,
      replyTo,
    });
    return {
      success: true,
      message: `Test email sent to ${recipient}.`,
      id: response.messageId,
      recipient,
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
