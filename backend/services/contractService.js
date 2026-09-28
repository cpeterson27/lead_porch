const crypto = require("crypto");
const Contract = require("../models/Contract");
const IntegrationConnection = require("../models/IntegrationConnection");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");
const { publicBackendUrl } = require("../utils/unsubscribe");

// DocuSign requires its OWN OAuth access token for every eSignature API
// call — Integration Key + Secret + Account ID alone were never enough to
// actually send anything (see the connect()/connectionStatus() comment
// below for how those three get collected first). This uses JWT Grant
// rather than the interactive Authorization Code Grant: sending a contract
// is triggered from a backend route with no human at a browser at that
// moment, so the flow can't depend on someone being present to click
// through a Google/Gmail-style login each time. JWT Grant instead signs a
// short-lived assertion with an RSA keypair WE generate (setupJwt()) — the
// human only has to do two one-time things: paste the public half into
// DocuSign's app settings, and visit a consent URL once to allow this app
// to act as their DocuSign user. After that, sending never needs them
// again unless that consent is revoked.
const DOCUSIGN_JWT_TTL_SECONDS = 3600;

function docusignError(message, code = "DOCUSIGN_ERROR") {
  return Object.assign(new Error(message), { code });
}

function authBase() {
  // Sandbox during development/testing; becomes "https://account.docusign.com"
  // the moment DocuSign's own Go-Live process promotes this Integration Key
  // to Ellie's real paid account — one env var, no code change needed then.
  return process.env.DOCUSIGN_ENVIRONMENT === "production" ? "https://account.docusign.com" : "https://account-d.docusign.com";
}

async function connectionStatus(workspaceId) {
  const connection = await IntegrationConnection.findOne({ workspaceId, provider: "docusign" }).select("+credentialsEncrypted").lean();
  if (!connection) return { connected: false, status: "not_configured", jwtConfigured: false };
  let jwtConfigured = false;
  try { jwtConfigured = Boolean(decryptCredentials(connection.credentialsEncrypted)?.docusignUserId); } catch { /* leave false */ }
  return { connected: connection.status === "connected" || connection.status === "configured", status: connection.status, accountId: connection.config?.accountId || "", connectedAt: connection.connectedAt || connection.createdAt, jwtConfigured };
}

async function connect({ workspaceId, integrationKey, clientSecret, accountId, actorUserId }) {
  if (!integrationKey || !clientSecret || !accountId) throw docusignError("Integration Key, Client Secret, and Account ID are required", "DOCUSIGN_CREDENTIALS_INVALID");
  const credentialsEncrypted = encryptCredentials({ integrationKey, clientSecret, accountId });
  const connection = await IntegrationConnection.findOneAndUpdate(
    { workspaceId, provider: "docusign" },
    { $set: { credentialsEncrypted, config: { accountId }, status: "configured", connectedAt: new Date(), lastError: null, metadata: { connectedBy: actorUserId } } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
  return { connected: true, status: connection.status };
}

// Second connect step: generates the RSA keypair (private half stored
// encrypted, public half handed back once — DocuSign only needs the
// public key, so the private key never leaves this server) and the
// one-time consent link. docusignUserId is DocuSign's own "User ID" GUID,
// shown on the same Apps and Keys / My Account Information page as the
// Account ID.
async function setupJwt({ workspaceId, docusignUserId }) {
  if (!docusignUserId) throw docusignError("Your DocuSign User ID is required", "DOCUSIGN_USERID_REQUIRED");
  const connection = await IntegrationConnection.findOne({ workspaceId, provider: "docusign" }).select("+credentialsEncrypted");
  if (!connection?.credentialsEncrypted) throw docusignError("Connect your Integration Key, Secret, and Account ID first", "DOCUSIGN_NOT_CONNECTED");
  const current = decryptCredentials(connection.credentialsEncrypted);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  connection.credentialsEncrypted = encryptCredentials({ ...current, docusignUserId: String(docusignUserId).trim(), rsaPrivateKeyPem: privateKey });
  await connection.save();
  const consentUrl = `${authBase()}/oauth/auth?${new URLSearchParams({
    response_type: "code",
    scope: "signature impersonation",
    client_id: current.integrationKey,
    redirect_uri: `${publicBackendUrl()}/api/contracts/docusign-consent-complete`,
  })}`;
  return { publicKeyPem: publicKey, consentUrl };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwtAssertion({ integrationKey, docusignUserId, rsaPrivateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: integrationKey, sub: docusignUserId, aud: authBase().replace(/^https?:\/\//, ""), iat: now, exp: now + DOCUSIGN_JWT_TTL_SECONDS, scope: "signature impersonation" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), rsaPrivateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

async function getAccessToken(workspaceId) {
  const connection = await IntegrationConnection.findOne({ workspaceId, provider: "docusign" }).select("+credentialsEncrypted");
  if (!connection?.credentialsEncrypted) throw docusignError("DocuSign isn't connected yet. Add your Integration Key, Client Secret, and Account ID first.", "DOCUSIGN_NOT_CONNECTED");
  const creds = decryptCredentials(connection.credentialsEncrypted);
  if (!creds.docusignUserId || !creds.rsaPrivateKeyPem) throw docusignError("Finish the RSA keypair setup step before sending", "DOCUSIGN_JWT_NOT_CONFIGURED");
  const assertion = signJwtAssertion(creds);
  const response = await fetch(`${authBase()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === "consent_required") throw docusignError("DocuSign needs one-time consent before it can send on your behalf — open the consent link from the setup step and approve it, then try again.", "DOCUSIGN_CONSENT_REQUIRED");
    throw docusignError(data.error_description || data.error || "DocuSign authentication failed", "DOCUSIGN_AUTH_FAILED");
  }
  return { accessToken: data.access_token, accountId: creds.accountId };
}

async function accountBaseUri(accessToken, accountId) {
  const response = await fetch(`${authBase()}/oauth/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json();
  const account = (data.accounts || []).find((row) => row.account_id === accountId) || data.accounts?.[0];
  if (!account) throw docusignError("Could not find that DocuSign account for this connected user", "DOCUSIGN_ACCOUNT_NOT_FOUND");
  return account.base_uri;
}

async function createDraftContract({ workspaceId, contactId, salesOpportunityId, enrollmentId, documentName, signerName, signerEmail, createdBy }) {
  if (!contactId || !documentName) throw Object.assign(new Error("Contact and document name are required"), { code: "CONTRACT_INVALID" });
  // Not a hard "one contract ever" rule — a signed/declined/voided contract
  // is done, and a new one (a renewal, say) is legitimate after that. This
  // only blocks creating a second copy of the same still-live request,
  // which is what actually produces the "did I get two of these?" mix-up.
  const existing = await Contract.findOne({ workspaceId, contactId, documentName, status: { $in: ["draft", "sent", "delivered"] } }).select("_id status").lean();
  if (existing) throw Object.assign(new Error(`This contact already has "${documentName}" ${existing.status === "draft" ? "as an unsent draft" : "out for signature"} — resend or delete that one instead of creating another.`), { code: "CONTRACT_DUPLICATE" });
  return Contract.create({ workspaceId, contactId, salesOpportunityId: salesOpportunityId || null, enrollmentId: enrollmentId || null, documentName, signerName: signerName || "", signerEmail: signerEmail || "", createdBy });
}

async function listContracts({ workspaceId, contactId }) {
  const query = { workspaceId };
  if (contactId) query.contactId = contactId;
  return Contract.find(query).sort({ createdAt: -1 }).limit(200).lean();
}

// A draft only ever holds metadata (see models/Contract.js) — the actual
// file to sign is attached right here, at send time, rather than stored in
// Lead Porch between "drafted" and "sent". DocuSign becomes the system of
// record for the document itself the moment it's sent; Lead Porch only
// needs to remember the envelope id and its status after that.
async function sendForSignature({ workspaceId, contractId, fileBuffer, fileName }) {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw Object.assign(new Error("Contract not found"), { code: "CONTRACT_NOT_FOUND" });
  if (contract.status !== "draft") throw Object.assign(new Error("Only a draft contract can be sent"), { code: "CONTRACT_ALREADY_SENT" });
  if (!fileBuffer?.length) throw Object.assign(new Error("Attach the document to send for signature"), { code: "CONTRACT_FILE_REQUIRED" });
  if (!contract.signerEmail) throw Object.assign(new Error("This contract has no signer email on file"), { code: "CONTRACT_SIGNER_MISSING" });

  // Everything from here on talks to DocuSign — any failure, including an
  // auth failure before an envelope is ever attempted, gets recorded onto
  // the contract itself so it's visible on the row, not just in a notice
  // banner that's easy to miss or scroll past.
  try {
    const { accessToken, accountId } = await getAccessToken(workspaceId);
    const baseUri = await accountBaseUri(accessToken, accountId);
    const extension = (String(fileName || "document.pdf").split(".").pop() || "pdf").toLowerCase();
    const envelope = {
      emailSubject: `Please sign: ${contract.documentName}`,
      documents: [{ documentId: "1", name: contract.documentName, fileExtension: extension, documentBase64: fileBuffer.toString("base64") }],
      recipients: {
        signers: [{
          email: contract.signerEmail,
          name: contract.signerName || contract.signerEmail,
          recipientId: "1",
          routingOrder: "1",
          // A fixed default position near the bottom of page 1 — not aware
          // of this document's actual layout, so this is a starting point
          // to confirm looks right on a real send, not a guarantee it
          // lands on a blank area of every document.
          tabs: { signHereTabs: [{ documentId: "1", pageNumber: "1", xPosition: "100", yPosition: "700" }] },
        }],
      },
      status: "sent",
    };

    const response = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await response.json();
    if (!response.ok) throw docusignError(data.message || (data.errorDetails ? JSON.stringify(data.errorDetails) : "DocuSign rejected the envelope"), "DOCUSIGN_SEND_FAILED");

    contract.status = "sent";
    contract.envelopeId = data.envelopeId;
    contract.sentAt = new Date();
    contract.lastError = "";
    await contract.save();
    return contract;
  } catch (error) {
    contract.lastError = error.message || "DocuSign send failed";
    await contract.save();
    throw error;
  }
}

// Re-notifies whichever recipients haven't yet signed — the same envelope,
// not a new one, so "did you get it?" never means a student ends up with
// two separate signing links for the same agreement.
async function resendEnvelope({ workspaceId, contractId }) {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw Object.assign(new Error("Contract not found"), { code: "CONTRACT_NOT_FOUND" });
  if (!contract.envelopeId) throw Object.assign(new Error("This contract hasn't been sent yet"), { code: "CONTRACT_NOT_SENT" });
  if (!["sent", "delivered"].includes(contract.status)) throw Object.assign(new Error("Only a contract still awaiting signature can be resent"), { code: "CONTRACT_NOT_PENDING" });

  try {
    const { accessToken, accountId } = await getAccessToken(workspaceId);
    const baseUri = await accountBaseUri(accessToken, accountId);
    const response = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${contract.envelopeId}?resend_envelope=true`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ envelopeId: contract.envelopeId }),
    });
    const data = await response.json();
    if (!response.ok) throw docusignError(data.message || "DocuSign could not resend that envelope", "DOCUSIGN_RESEND_FAILED");
    contract.lastError = "";
    await contract.save();
    return contract;
  } catch (error) {
    contract.lastError = error.message || "DocuSign resend failed";
    await contract.save();
    throw error;
  }
}

// Only ever a draft — once something is actually sent, the envelope (and
// its record here) is the audit trail for a real signature request, so
// deleting it silently would be the wrong behavior even if DocuSign itself
// still allowed voiding it.
async function deleteDraftContract({ workspaceId, contractId }) {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw Object.assign(new Error("Contract not found"), { code: "CONTRACT_NOT_FOUND" });
  if (contract.status !== "draft") throw Object.assign(new Error("Only a draft contract can be deleted"), { code: "CONTRACT_NOT_DRAFT" });
  await contract.deleteOne();
  return { deleted: true };
}

module.exports = { connectionStatus, connect, setupJwt, createDraftContract, listContracts, sendForSignature, resendEnvelope, deleteDraftContract };
