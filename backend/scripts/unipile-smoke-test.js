#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 * Confirms UNIPILE_DSN/UNIPILE_API_KEY are wired correctly and, once a
 * LinkedIn account is connected in the dashboard, registers the messaging
 * webhook this app needs (message_received -> /api/webhooks/unipile-messages).
 *
 * Usage:
 *   node scripts/unipile-smoke-test.js
 *   node scripts/unipile-smoke-test.js --register-webhook
 */
require("dotenv").config();
const unipile = require("../services/unipileService");

async function main() {
  if (!unipile.isEnabled()) {
    console.error("Unipile is not enabled. Set LINKEDIN_UNIPILE_ENABLED=true, UNIPILE_DSN, and UNIPILE_API_KEY, then re-run this script.");
    process.exitCode = 1;
    return;
  }
  console.log("Checking Unipile connectivity by listing chats (works even before a real conversation exists)...");
  const chats = await unipile.getAllChats();
  console.log("Unipile responded successfully. Raw response shape:", Object.keys(chats));

  if (process.argv.includes("--register-webhook")) {
    const base = String(process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
    const token = String(process.env.UNIPILE_WEBHOOK_TOKEN || "").trim();
    if (!base || !token) {
      console.error("Set PUBLIC_BACKEND_URL and UNIPILE_WEBHOOK_TOKEN before registering the webhook.");
      process.exitCode = 1;
      return;
    }
    const requestUrl = `${base}/api/webhooks/unipile-messages?token=${token}`;
    console.log(`Registering messaging webhook -> ${base}/api/webhooks/unipile-messages?token=<hidden>`);
    const result = await unipile.registerMessagingWebhook({ requestUrl });
    console.log("Webhook registered:", result);
  } else {
    console.log("Run again with --register-webhook once PUBLIC_BACKEND_URL is set to also register the inbound-message webhook.");
  }
}

main().catch((error) => {
  console.error("Unipile smoke test failed:", error.message);
  process.exitCode = 1;
});
