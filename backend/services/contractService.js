const Contract = require("../models/Contract");
const IntegrationConnection = require("../models/IntegrationConnection");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");

// Checklist section 5 (Contracts/E-Signature) was entirely missing. This is
// the data model and workflow the user explicitly asked to have ready
// before real DocuSign credentials exist: draft a contract against a
// contact/opportunity, track its status, and store credentials the same
// encrypted way every other integration in this codebase already does
// (see utils/credentialEncryption.js + IntegrationConnection). The actual
// DocuSign eSignature REST call is deliberately NOT implemented yet — it
// needs to be built and tested against Ellie's real DocuSign account
// (Integration Key, Client Secret, Account ID) rather than shipped blind,
// so sendForSignature fails loudly with a clear reason instead of silently
// pretending to send.

async function connectionStatus(workspaceId) {
  const connection = await IntegrationConnection.findOne({ workspaceId, provider: "docusign" }).lean();
  if (!connection) return { connected: false, status: "not_configured" };
  return { connected: connection.status === "connected" || connection.status === "configured", status: connection.status, accountId: connection.config?.accountId || "", connectedAt: connection.connectedAt || connection.createdAt };
}

async function connect({ workspaceId, integrationKey, clientSecret, accountId, actorUserId }) {
  if (!integrationKey || !clientSecret || !accountId) throw Object.assign(new Error("Integration Key, Client Secret, and Account ID are required"), { code: "DOCUSIGN_CREDENTIALS_INVALID" });
  const credentialsEncrypted = encryptCredentials({ integrationKey, clientSecret, accountId });
  const connection = await IntegrationConnection.findOneAndUpdate(
    { workspaceId, provider: "docusign" },
    { $set: { credentialsEncrypted, config: { accountId }, status: "configured", connectedAt: new Date(), lastError: null, metadata: { connectedBy: actorUserId } } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
  return { connected: true, status: connection.status };
}

async function createDraftContract({ workspaceId, contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail, createdBy }) {
  if (!contactId || !documentName) throw Object.assign(new Error("Contact and document name are required"), { code: "CONTRACT_INVALID" });
  return Contract.create({ workspaceId, contactId, salesOpportunityId: salesOpportunityId || null, enrollmentId: enrollmentId || null, documentName, signerName: signerName || "", signerEmail: signerEmail || "", createdBy });
}

async function listContracts({ workspaceId, contactId }) {
  const query = { workspaceId };
  if (contactId) query.contactId = contactId;
  return Contract.find(query).sort({ createdAt: -1 }).limit(200).lean();
}

async function sendForSignature({ workspaceId, contractId }) {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw Object.assign(new Error("Contract not found"), { code: "CONTRACT_NOT_FOUND" });
  if (contract.status !== "draft") throw Object.assign(new Error("Only a draft contract can be sent"), { code: "CONTRACT_ALREADY_SENT" });
  const connection = await IntegrationConnection.findOne({ workspaceId, provider: "docusign" }).select("+credentialsEncrypted");
  if (!connection || !connection.credentialsEncrypted) throw Object.assign(new Error("DocuSign isn't connected yet. Add your Integration Key, Client Secret, and Account ID first."), { code: "DOCUSIGN_NOT_CONNECTED" });
  decryptCredentials(connection.credentialsEncrypted); // confirms the stored credentials are readable before failing further down
  throw Object.assign(new Error("DocuSign is connected, but sending envelopes hasn't been wired up and tested against the real API yet. This is the next step once you're ready."), { code: "DOCUSIGN_SEND_NOT_IMPLEMENTED" });
}

module.exports = { connectionStatus, connect, createDraftContract, listContracts, sendForSignature };
