const MessagingSender = require("../models/MessagingSender");

// Deliberately NOT going through conversations/twilioConversationAdapter's
// sendMessage() — that path runs evaluateOutboundCommunication(), which
// exists to gate *customer* messaging (marketing consent, opt-outs, and by
// default 9pm-8am quiet hours). A login code is a security mechanism the
// user just triggered themselves and needs right now — it must never be
// silently held back until morning, or blocked because a workspace's
// number isn't yet A2P-approved for marketing sends. This talks to Twilio
// directly instead.
function configured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

async function findSender(workspaceId, capability = "sms") {
  return MessagingSender.findOne({ workspaceId, status: "active", [`capabilities.${capability}`]: true }).lean();
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[char]));
}

async function sendVerificationCode({ workspaceId, phone, code }) {
  if (!configured()) throw Object.assign(new Error("Text messaging is not set up for this account yet"), { code: "SMS_NOT_CONFIGURED" });
  const sender = await findSender(workspaceId);
  if (!sender) throw Object.assign(new Error("No active phone number is set up to send codes from — add one under Settings > Integrations > Twilio first"), { code: "NO_SMS_SENDER" });
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID).trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN).trim();
  const body = new URLSearchParams({
    To: phone,
    Body: `${code} is your verification code.`,
    ...(sender.messagingServiceId ? { MessagingServiceSid: sender.messagingServiceId } : { From: sender.phoneNumber }),
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || "Unable to send the verification text"), { code: "SMS_SEND_FAILED" });
  return data;
}

// "Try another method": reads the code aloud instead of texting it. The
// TwiML is passed inline on the call-creation request itself (Twilio's API
// accepts Twiml as an alternative to a callback Url) rather than standing
// up a public webhook Twilio would fetch back — there is no separate route
// to keep in sync, and the code never sits in a URL any expired link could
// leak.
async function sendVerificationCall({ workspaceId, phone, code }) {
  if (!configured()) throw Object.assign(new Error("Voice calls are not set up for this account yet"), { code: "VOICE_NOT_CONFIGURED" });
  const sender = await findSender(workspaceId, "voice");
  if (!sender) throw Object.assign(new Error("No active phone number is set up to place calls from — add one under Settings > Integrations > Twilio first"), { code: "NO_VOICE_SENDER" });
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID).trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN).trim();
  const spokenCode = String(code).split("").join(", ");
  const say = escapeXml(`Your Lead Porch verification code is: ${spokenCode}.`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${say}</Say><Pause length="1"/><Say>${say}</Say></Response>`;
  const body = new URLSearchParams({ To: phone, From: sender.phoneNumber, Twiml: twiml });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || "Unable to place the verification call"), { code: "CALL_SEND_FAILED" });
  return data;
}

module.exports = { sendVerificationCode, sendVerificationCall, configured };
