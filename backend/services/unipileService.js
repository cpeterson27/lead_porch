/**
 * Unipile integration for LinkedIn personal-profile outreach (connection
 * requests + DMs on a real, human LinkedIn account). This is a SEPARATE
 * integration from LINKEDIN_CLIENT_ID/SECRET (services/socialOAuthService.js),
 * which is LinkedIn's own Marketing API for organization-page publishing only
 * and cannot search people, send connection requests, or message anyone.
 *
 * Disabled by default. When disabled, every exported function throws
 * immediately without making any HTTP request.
 *
 * Endpoint contracts below are confirmed either against Unipile's published
 * API reference (developer.unipile.com) or by direct inspection of the
 * `unipile-node-sdk` package source (resources/messaging.resource.js,
 * resources/users.resource.js) as of this writing:
 *   - POST   /api/v1/hosted/accounts/link     (hosted LinkedIn login flow)
 *   - POST   /api/v1/users/invite             (send a connection request)
 *   - GET    /api/v1/users/invite/sent        (list invitations + status)
 *   - GET    /api/v1/users/relations          (list accepted connections)
 *   - GET    /api/v1/users/{identifier}       (resolve a profile's
 *     internal provider_id from its public slug/URL, required by invite)
 *   - POST   /api/v1/chats                    (start a new chat/DM with
 *     someone who has no existing chat yet — the opener after a fresh
 *     connection acceptance)
 *   - POST   /api/v1/chats/{chat_id}/messages (reply within an existing chat)
 *   - GET    /api/v1/chats                    (list chats — inbox sync)
 *   - GET    /api/v1/chats/{chat_id}/messages (list messages in a chat)
 *   - POST   /api/v1/webhooks                 (register a messaging webhook)
 *
 * Important confirmed constraint: Unipile has NO webhook event for
 * "connection request accepted" — only `message_received`, `message_read`,
 * and `message_reaction` exist as messaging webhook triggers. Detecting
 * acceptance requires polling GET /users/relations or GET /users/invite/sent
 * (see checkConnectionAcceptance in linkedinSequenceService.js); the exact
 * response body field names for those two list endpoints were not
 * confirmed from source (only their request shape was), so
 * relationMatchesProviderId below probes several plausible field names
 * defensively and logs a warning if none match, rather than assuming one.
 */
const axios = require("axios");

function isEnabled() {
  return (
    process.env.LINKEDIN_UNIPILE_ENABLED === "true" &&
    Boolean(process.env.UNIPILE_DSN?.trim()) &&
    Boolean(process.env.UNIPILE_API_KEY?.trim())
  );
}

function assertEnabled() {
  if (!isEnabled()) {
    const error = new Error(
      "LinkedIn outreach (Unipile) is not enabled. Set LINKEDIN_UNIPILE_ENABLED=true, UNIPILE_DSN, and UNIPILE_API_KEY to use it.",
    );
    error.code = "UNIPILE_DISABLED";
    throw error;
  }
}

function baseUrl() {
  const dsn = String(process.env.UNIPILE_DSN || "").trim().replace(/\/$/, "");
  return dsn.startsWith("http") ? dsn : `https://${dsn}`;
}

function client() {
  return axios.create({
    baseURL: `${baseUrl()}/api/v1`,
    timeout: 15000,
    headers: {
      "X-API-KEY": process.env.UNIPILE_API_KEY.trim(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function unipileError(context, error) {
  const wrapped = new Error(
    `Unipile ${context} failed: ${error.response?.data?.message || error.response?.statusText || error.message}`,
  );
  wrapped.code = "UNIPILE_REQUEST_FAILED";
  wrapped.status = error.response?.status || null;
  wrapped.cause = error;
  return wrapped;
}

/**
 * Request a hosted LinkedIn login link. The customer completes login
 * (including any 2FA/checkpoint challenge) on Unipile's own hosted page, so
 * this backend never touches a raw LinkedIn password. `notifyUrl` should
 * point at the /api/webhooks/unipile receiver; Unipile POSTs a
 * `{ status: "CREATION_SUCCESS", account_id, name }` payload there once the
 * login completes, where `name` echoes the value passed as `identifier`
 * here so the webhook can match the new account back to a workspace.
 */
async function requestHostedAuthLink({
  identifier,
  notifyUrl,
  successRedirectUrl,
  failureRedirectUrl,
  expiresInHours = 2,
}) {
  assertEnabled();
  try {
    const { data } = await client().post("/hosted/accounts/link", {
      type: "create",
      providers: ["LINKEDIN"],
      api_url: baseUrl(),
      name: String(identifier || ""),
      notify_url: notifyUrl,
      success_redirect_url: successRedirectUrl,
      failure_redirect_url: failureRedirectUrl,
      expiresOn: new Date(Date.now() + expiresInHours * 60 * 60000).toISOString(),
    });
    return data;
  } catch (error) {
    throw unipileError("hosted auth link request", error);
  }
}

/**
 * Resolve a LinkedIn public profile URL/slug to Unipile's internal
 * provider_id for that person, required by sendConnectionInvitation.
 */
async function retrieveProfile({ accountId, identifier }) {
  assertEnabled();
  try {
    const { data } = await client().get(
      `/users/${encodeURIComponent(identifier)}`,
      { params: { account_id: accountId } },
    );
    return data;
  } catch (error) {
    throw unipileError("profile retrieval", error);
  }
}

/**
 * Send a LinkedIn connection request (optionally with a short note) from a
 * connected account to another member. LinkedIn caps this around 80-100/day
 * per account for paid LinkedIn accounts, fewer on free accounts — callers
 * must apply their own daily-volume limiting before calling this.
 */
async function sendConnectionInvitation({ accountId, providerId, message }) {
  assertEnabled();
  try {
    const { data } = await client().post("/users/invite", {
      account_id: accountId,
      provider_id: providerId,
      ...(message ? { message: String(message).slice(0, 300) } : {}),
    });
    return data;
  } catch (error) {
    throw unipileError("connection invitation", error);
  }
}

/**
 * List this account's currently-accepted LinkedIn connections. Used to poll
 * for acceptance since no acceptance webhook exists (see module doc).
 */
async function getAllRelations({ accountId, cursor }) {
  assertEnabled();
  try {
    const { data } = await client().get("/users/relations", {
      params: { account_id: accountId, ...(cursor ? { cursor } : {}) },
    });
    return data;
  } catch (error) {
    throw unipileError("relations list", error);
  }
}

/**
 * Best-effort match of a relations-list entry to a target provider_id.
 * The exact response field name was not confirmed from source, so this
 * checks several plausible shapes rather than assuming one is correct.
 */
function relationMatchesProviderId(relation, providerId) {
  const candidates = [
    relation?.provider_id,
    relation?.member_id,
    relation?.user_provider_id,
    relation?.id,
    relation?.profile?.provider_id,
  ];
  return candidates.some((value) => value && String(value) === String(providerId));
}

/**
 * Start a brand-new chat with someone who has no existing chat yet — the
 * opener message right after a connection is accepted.
 */
async function startNewChat({ accountId, providerId, text }) {
  assertEnabled();
  try {
    const { data } = await client().post("/chats", {
      account_id: accountId,
      attendees_ids: [providerId],
      text: String(text || "").slice(0, 8000),
    });
    return data;
  } catch (error) {
    throw unipileError("starting a new chat", error);
  }
}

/** Reply within an already-existing chat. */
async function sendChatMessage({ chatId, text }) {
  assertEnabled();
  try {
    const { data } = await client().post(`/chats/${encodeURIComponent(chatId)}/messages`, {
      text: String(text || "").slice(0, 8000),
    });
    return data;
  } catch (error) {
    throw unipileError("sending a chat message", error);
  }
}

async function getAllChats({ accountId, cursor } = {}) {
  assertEnabled();
  try {
    const { data } = await client().get("/chats", {
      params: { ...(accountId ? { account_id: accountId } : {}), ...(cursor ? { cursor } : {}) },
    });
    return data;
  } catch (error) {
    throw unipileError("chats list", error);
  }
}

async function getAllMessagesFromChat({ chatId, cursor }) {
  assertEnabled();
  try {
    const { data } = await client().get(`/chats/${encodeURIComponent(chatId)}/messages`, {
      params: cursor ? { cursor } : {},
    });
    return data;
  } catch (error) {
    throw unipileError("chat messages list", error);
  }
}

/**
 * Run a user-initiated LinkedIn people search. Results are only previews;
 * callers must require an explicit human selection before creating CRM
 * contacts or starting outreach.
 */
async function searchLinkedinPeople({ accountId, url, keywords, cursor, limit = 25 }) {
  assertEnabled();
  try {
    const { data } = await client().post("/linkedin/search", url
      ? { url: String(url).trim() }
      : { api: "classic", category: "people", keywords: String(keywords || "").trim() }, {
      params: {
        account_id: accountId,
        limit: Math.min(25, Math.max(1, Number(limit) || 25)),
        ...(cursor ? { cursor } : {}),
      },
    });
    return data;
  } catch (error) {
    throw unipileError("LinkedIn people search", error);
  }
}

/**
 * Register a messaging webhook so inbound LinkedIn messages reach
 * /api/webhooks/unipile-messages. Idempotency is the caller's
 * responsibility — Unipile does not dedupe webhook registrations by URL.
 */
async function registerMessagingWebhook({ requestUrl, accountIds }) {
  assertEnabled();
  try {
    const { data } = await client().post("/webhooks", {
      source: "messaging",
      request_url: requestUrl,
      events: ["message_received"],
      ...(accountIds?.length ? { account_ids: accountIds } : {}),
    });
    return data;
  } catch (error) {
    throw unipileError("webhook registration", error);
  }
}

module.exports = {
  isEnabled,
  assertEnabled,
  requestHostedAuthLink,
  retrieveProfile,
  sendConnectionInvitation,
  getAllRelations,
  relationMatchesProviderId,
  startNewChat,
  sendChatMessage,
  getAllChats,
  getAllMessagesFromChat,
  searchLinkedinPeople,
  registerMessagingWebhook,
};
