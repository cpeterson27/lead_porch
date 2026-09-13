/**
 * Shared LinkedIn-outreach actions used by both the manual
 * routes/socialLinkedinOutreach.js endpoints and the automated
 * linkedinSequenceService.js runner, so a connection request or message is
 * always sent, recorded, and logged to the CRM the same way regardless of
 * who (or what) triggered it.
 */
const unipile = require("./unipileService");
const SocialConnection = require("../models/SocialConnection");
const CrmActivity = require("../models/CrmActivity");

const PROVIDER = "linkedin_unipile";

async function getConnectedAccount(workspaceId) {
  const connection = await SocialConnection.findOne({
    workspaceId,
    provider: PROVIDER,
    status: "connected",
  });
  if (!connection) {
    const error = new Error("No connected LinkedIn (Unipile) account for this workspace");
    error.code = "LINKEDIN_NOT_CONNECTED";
    throw error;
  }
  return connection;
}

async function resolveProviderId({ accountId, contact }) {
  if (contact.linkedinOutreach?.unipileProviderId) return contact.linkedinOutreach.unipileProviderId;
  if (!contact.linkedin) {
    const error = new Error("This contact has no LinkedIn URL on file");
    error.code = "LINKEDIN_URL_MISSING";
    throw error;
  }
  const slug = String(contact.linkedin).replace(/\/$/, "").split("/").pop();
  const profile = await unipile.retrieveProfile({ accountId, identifier: slug });
  const providerId = profile.provider_id || profile.id;
  if (!providerId) {
    const error = new Error("Unipile could not resolve this LinkedIn profile");
    error.code = "LINKEDIN_PROFILE_UNRESOLVED";
    throw error;
  }
  return providerId;
}

/**
 * Send a connection request to a contact and persist the outcome onto both
 * the Contact document and the CRM activity feed. Returns the resolved
 * provider_id and account_id so a caller (e.g. a sequence enrollment) can
 * cache them for later steps.
 */
async function sendConnectionRequestToContact({ workspaceId, contact, message, actorUserId = null }) {
  const connection = await getConnectedAccount(workspaceId);
  const accountId = connection.providerAccount?.id;
  const providerId = await resolveProviderId({ accountId, contact });

  await unipile.sendConnectionInvitation({ accountId, providerId, message });

  contact.linkedinOutreach = {
    ...contact.linkedinOutreach,
    status: "sent",
    sentAt: new Date(),
    unipileProviderId: providerId,
    unipileAccountId: accountId,
    connectionStatus: "pending",
  };
  await contact.save();
  await CrmActivity.create({
    contactId: contact._id,
    type: "system",
    title: "LinkedIn connection request sent",
    source: "integration",
    createdBy: actorUserId,
    metadata: { eventType: "social.linkedin.invitation_sent", provider: PROVIDER },
  });
  return { accountId, providerId };
}

module.exports = {
  PROVIDER,
  getConnectedAccount,
  resolveProviderId,
  sendConnectionRequestToContact,
};
