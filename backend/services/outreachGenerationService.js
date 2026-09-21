const Outreach = require("../models/Outreach");
const Contact = require("../models/Contact");
const CampaignTemplateVersion = require("../models/CampaignTemplateVersion");
const { selectAutomaticAudienceTemplate } = require("./campaignAudienceService");
const { generateOutreachDraft } = require("../utils/outreachGenerator");

function cleanName(name = "") {
  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Creates missing outreach drafts and refreshes any still-"pending"/"failed"
 * ones for every eligible contact on a campaign, using whichever email
 * template version (general or audience-routed) is currently approved. This
 * is the single source of truth for outreach draft generation — both the
 * manual "Regenerate" button (routes/outreach.js) and the automatic refresh
 * that fires after a template version is approved (routes/campaigns.js) call
 * this same function so their behavior can't drift apart.
 */
async function regenerateCampaignOutreach(campaign, { onlyMissing = false, actorUserId = null } = {}) {
  let generalTemplate = campaign.emailTemplate?.currentVersion
    ? await CampaignTemplateVersion.findOne({
      campaignId: campaign._id,
      version: campaign.emailTemplate.currentVersion,
    })
    : null;
  if (!generalTemplate) {
    const template = require("./campaignMasterTemplate").effectiveTemplate(campaign);
    const version = (await CampaignTemplateVersion.findOne({ campaignId: campaign._id }).sort({ version: -1 }).select("version"))?.version + 1 || 1;
    generalTemplate = await CampaignTemplateVersion.create({
      campaignId: campaign._id,
      version,
      subject: template.subject,
      body: template.body,
      designJson: template.designJson || null,
      callToAction: template.callToAction,
      callToActionUrl: template.callToActionUrl,
      topic: template.topic,
      approvedByUserId: actorUserId,
      approvedAt: new Date(),
    });
    campaign.emailTemplate = { ...template, status: "approved", currentVersion: version, approvedAt: generalTemplate.approvedAt };
    campaign.activeAudienceTemplateKey = "general";
    await campaign.save();
  }
  const audienceTemplateDefinitions = Object.entries(campaign.emailAudienceTemplates || {})
    .filter(([, template]) => template?.status === "approved" && template?.currentVersion && template?.audienceLabel);
  const audienceTemplateVersions = await CampaignTemplateVersion.find({
    campaignId: campaign._id,
    version: { $in: audienceTemplateDefinitions.map(([, template]) => template.currentVersion) },
  });
  const audienceTemplates = audienceTemplateDefinitions
    .map(([key, definition]) => ({
      key,
      label: definition.audienceLabel,
      template: audienceTemplateVersions.find((version) => version.version === definition.currentVersion),
    }))
    .filter((item) => item.template);

  const contacts = await Contact.find({
    type: "lead",
    status: { $nin: ["archived", "unsubscribed", "invalid", "rejected"] },
    emailStatus: { $ne: "undeliverable" },
    email: { $exists: true, $nin: ["", null] },
    campaignIds: campaign._id,
  });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedExisting = 0;
  let skippedMissingEmail = 0;
  const routingSummary = {};

  for (const contact of contacts) {
    if (!contact.email) {
      skippedMissingEmail++;
      continue;
    }
    const email = contact.email.toLowerCase().trim();
    const exists = await Outreach.findOne({ campaignId: campaign._id, contactEmail: email });
    const cleanedContact = {
      ...contact.toObject(),
      name: cleanName(contact.name || contact.firstName || "there"),
      company: cleanName(contact.company || ""),
    };
    const automaticTemplate = selectAutomaticAudienceTemplate(cleanedContact, audienceTemplates);
    const overrideKey = String(cleanedContact.campaignTemplateOverrides?.[String(campaign._id)] || "auto");
    const routedTemplate = overrideKey === "general"
      ? null
      : overrideKey !== "auto"
        ? audienceTemplates.find((candidate) => candidate.key === overrideKey) || automaticTemplate
        : automaticTemplate;
    const recipientTemplate = routedTemplate?.template || generalTemplate;
    const recipientAudienceKey = overrideKey === "general" ? "general" : routedTemplate?.key || "general";
    const recipientAudienceLabel = overrideKey === "general" ? "Main campaign template" : routedTemplate?.label || "Main campaign template";
    routingSummary[recipientAudienceLabel] = (routingSummary[recipientAudienceLabel] || 0) + 1;
    campaign.content = {
      subject: recipientTemplate.subject,
      body: recipientTemplate.body,
      callToAction: recipientTemplate.callToAction,
      callToActionUrl: recipientTemplate.callToActionUrl,
    };

    const draft = generateOutreachDraft(cleanedContact, campaign);

    if (exists) {
      if (onlyMissing) {
        skippedExisting++;
        continue;
      }
      if (["pending", "failed"].includes(exists.status)) {
        exists.organization = draft.organization;
        exists.contactName = draft.contactName;
        exists.contactRole = draft.contactRole;
        exists.reason = draft.reason;
        exists.subject = draft.subject;
        exists.emailDraft = draft.emailDraft;
        exists.htmlBody = draft.htmlBody || "";
        exists.eventLink = draft.eventLink || "";
        exists.flyerUrl = draft.flyerUrl || "";
        exists.templateVersion = recipientTemplate.version;
        exists.templateAudienceKey = recipientAudienceKey;
        exists.templateAudienceLabel = recipientAudienceLabel;
        exists.emailTopic = recipientTemplate.topic;
        exists.status = "pending";
        exists.errorMessage = "";
        await exists.save();
        updatedCount++;
      } else {
        skippedExisting++;
      }
      continue;
    }

    await Outreach.create({
      campaignId: campaign._id,
      contactId: contact._id,
      organization: draft.organization,
      contactName: draft.contactName,
      contactEmail: email,
      contactRole: draft.contactRole,
      reason: draft.reason,
      subject: draft.subject,
      emailDraft: draft.emailDraft,
      htmlBody: draft.htmlBody || "",
      eventLink: draft.eventLink || "",
      flyerUrl: draft.flyerUrl || "",
      templateVersion: recipientTemplate.version,
      templateAudienceKey: recipientAudienceKey,
      templateAudienceLabel: recipientAudienceLabel,
      emailTopic: recipientTemplate.topic,
      status: "pending",
    });
    createdCount++;
  }

  const outreach = await Outreach.find({ campaignId: campaign._id }).sort({ createdAt: -1 });
  return { outreach, createdCount, updatedCount, skippedExisting, skippedMissingEmail, routingSummary };
}

module.exports = { regenerateCampaignOutreach };
