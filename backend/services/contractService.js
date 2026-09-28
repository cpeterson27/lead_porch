const crypto = require("crypto");
const Contract = require("../models/Contract");
const IntegrationConnection = require("../models/IntegrationConnection");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");
const { publicBackendUrl } = require("../utils/unsubscribe");

// Standard OAuth (Authorization Code Grant) — the same pattern every other
// per-workspace integration in this app already uses (Gmail, Google
// Business Profile, Meetup): the business owner clicks "Connect," logs
// into THEIR OWN DocuSign with their own password, and this app never
// touches their credentials or needs to be added as a developer on their
// account. One Integration Key (DOCUSIGN_CLIENT_ID/SECRET, Lead Porch's
// own, set once as platform env vars) serves every workspace — exactly
// how GOOGLE_CLIENT_ID already works. An earlier version of this file
// used JWT Grant instead, which needed a manually-generated RSA keypair
// and a DocuSign "developer" login per workspace — wrong shape for a
// product other business owners will self-serve into.
const PROVIDER = "docusign";
const SCOPES = ["signature"];

function docusignError(message, code = "DOCUSIGN_ERROR") {
  return Object.assign(new Error(message), { code });
}

function authBase() {
  // Sandbox during development/testing; becomes "https://account.docusign.com"
  // once DocuSign's own Go-Live process approves this Integration Key for
  // production — one env var, no code change needed then.
  return process.env.DOCUSIGN_ENVIRONMENT === "production" ? "https://account.docusign.com" : "https://account-d.docusign.com";
}
function clientId() { return String(process.env.DOCUSIGN_CLIENT_ID || "").trim(); }
function clientSecret() { return String(process.env.DOCUSIGN_CLIENT_SECRET || "").trim(); }
function stateSecret() { return String(process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY || "").trim(); }
function configured() { return Boolean(clientId() && clientSecret() && stateSecret()); }
function requireConfigured() {
  if (!configured()) throw docusignError("DocuSign app credentials are not configured yet", "DOCUSIGN_APP_NOT_CONFIGURED");
}
function redirectUri() { return `${publicBackendUrl()}/api/contracts/oauth/callback`; }

function createState(workspaceId, userId, returnOrigin = "") {
  requireConfigured();
  const payload = Buffer.from(JSON.stringify({ workspaceId: String(workspaceId), userId: String(userId), returnOrigin: String(returnOrigin || ""), createdAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
  const signature = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function verifyState(value) {
  try {
    const [payload, signature] = String(value || "").split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Date.now() - Number(parsed.createdAt) < 10 * 60 * 1000 && parsed.workspaceId && parsed.userId ? parsed : null;
  } catch { return null; }
}

function authorizationUrl(workspaceId, userId, returnOrigin = "") {
  requireConfigured();
  const params = new URLSearchParams({ response_type: "code", scope: SCOPES.join(" "), client_id: clientId(), redirect_uri: redirectUri(), state: createState(workspaceId, userId, returnOrigin) });
  return `${authBase()}/oauth/auth?${params}`;
}

async function jsonRequest(url, options = {}, fallback = "DocuSign request failed") {
  const response = await fetch(url, options);
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw docusignError(data.error_description || data.message || data.error || fallback, "DOCUSIGN_REQUEST_FAILED");
  return data;
}
function basicAuthHeader() { return `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64")}`; }

const docusignAdapter = {
  exchangeCode(code) {
    return jsonRequest(`${authBase()}/oauth/token`, { method: "POST", headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code }) }, "DocuSign token exchange failed");
  },
  refresh(refreshToken) {
    return jsonRequest(`${authBase()}/oauth/token`, { method: "POST", headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) }, "DocuSign access refresh failed");
  },
  userInfo(accessToken) {
    return jsonRequest(`${authBase()}/oauth/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } }, "Unable to read the connected DocuSign account");
  },
};

function connectionFilter(workspaceId) { return { workspaceId, provider: PROVIDER, accountScope: "workspace" }; }

async function saveConnection({ workspaceId }, tokens, userInfo) {
  const account = (userInfo.accounts || []).find((row) => row.is_default) || userInfo.accounts?.[0];
  if (!account) throw docusignError("That DocuSign login has no accounts available", "DOCUSIGN_NO_ACCOUNT");
  const filter = connectionFilter(workspaceId);
  const existing = await IntegrationConnection.findOne(filter).select("+credentialsEncrypted");
  const previous = existing?.credentialsEncrypted ? decryptCredentials(existing.credentialsEncrypted) : {};
  return IntegrationConnection.findOneAndUpdate(filter, { $set: {
    ...filter,
    status: "connected",
    credentialsEncrypted: encryptCredentials({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous.refreshToken }),
    settings: { email: userInfo.email || "", name: userInfo.name || "", accountId: account.account_id, accountName: account.account_name || "", baseUri: account.base_uri },
    oauth: { expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000) },
    connectedAt: new Date(), lastError: null,
  } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

function publicConnection(connection) {
  return { configured: configured(), connected: connection?.status === "connected", email: connection?.settings?.email || "", accountName: connection?.settings?.accountName || "", connectedAt: connection?.connectedAt || null, lastError: connection?.lastError || "" };
}

async function connectionStatus(workspaceId) {
  return publicConnection(await IntegrationConnection.findOne(connectionFilter(workspaceId)).lean());
}

async function connectedConnection(workspaceId) {
  const connection = await IntegrationConnection.findOne({ ...connectionFilter(workspaceId), status: "connected" }).select("+credentialsEncrypted");
  if (!connection?.credentialsEncrypted) throw docusignError("DocuSign isn't connected yet — connect it under Contracts first.", "DOCUSIGN_NOT_CONNECTED");
  return connection;
}

async function accessToken(connection) {
  const credentials = decryptCredentials(connection.credentialsEncrypted);
  if (credentials.accessToken && new Date(connection.oauth?.expiresAt || 0).getTime() > Date.now() + 60000) return credentials.accessToken;
  if (!credentials.refreshToken) throw docusignError("Reconnect DocuSign — this connection can no longer refresh itself.", "DOCUSIGN_RECONNECT_REQUIRED");
  const refreshed = await docusignAdapter.refresh(credentials.refreshToken);
  connection.credentialsEncrypted = encryptCredentials({ accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || credentials.refreshToken });
  connection.oauth = { expiresAt: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000) };
  await connection.save();
  return refreshed.access_token;
}

async function disconnect(workspaceId) {
  const connection = await IntegrationConnection.findOneAndUpdate(connectionFilter(workspaceId), { $set: { status: "disconnected", credentialsEncrypted: null, connectedAt: null, oauth: {}, lastError: null } }, { new: true });
  return publicConnection(connection);
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
    const connection = await connectedConnection(workspaceId);
    const token = await accessToken(connection);
    const { accountId, baseUri } = connection.settings;
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

    const data = await jsonRequest(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    }, "DocuSign rejected the envelope");

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
    const connection = await connectedConnection(workspaceId);
    const token = await accessToken(connection);
    const { accountId, baseUri } = connection.settings;
    await jsonRequest(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${contract.envelopeId}?resend_envelope=true`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ envelopeId: contract.envelopeId }),
    }, "DocuSign could not resend that envelope");
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

module.exports = {
  PROVIDER, configured, docusignAdapter, verifyState, authorizationUrl, saveConnection, publicConnection,
  connectionStatus, disconnect, createDraftContract, listContracts, sendForSignature, resendEnvelope, deleteDraftContract,
};
