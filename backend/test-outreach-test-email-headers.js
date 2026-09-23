const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// The real send path (sendEmail) has always included List-Unsubscribe
// headers on every message — a documented, significant Gmail/major-
// provider inbox-placement signal, especially for a newer sending
// domain. sendTestEmail rendered the exact same content via the same
// renderEmailContent() helper (which already computes an unsubscribeUrl)
// but discarded it and sent with no unsubscribe header at all — every
// test send got strictly worse deliverability signals than a real
// recipient would ever see. Confirmed live: four consecutive test sends
// of identical content to the same address all landed in spam.
const emailSource = source("services/email.js");
const testEmailBody = emailSource.slice(emailSource.indexOf("async function sendTestEmail"));
assert.ok(testEmailBody.includes("unsubscribeUrl } = await renderEmailContent"), "sendTestEmail must capture unsubscribeUrl from renderEmailContent, not discard it");
assert.ok(testEmailBody.includes('"List-Unsubscribe": `<${unsubscribeUrl}>`'), "sendTestEmail must send the same List-Unsubscribe header the real send path does");

console.log("Outreach test-email headers test passed: test sends now carry the same unsubscribe signal as real sends.");

// A test send is meant to preview what a real recipient gets — but it was
// sending from a completely different identity ("Ellies Coaching"/"Growth
// Operator", a generic fallback) than the real send path uses ("Ellie
// Baxter <team@elliescoaching.com>", the workspace's actual configured
// person). Confirmed live via Resend's own send log: every real campaign
// send used the real identity; every test send used the generic one.
// That's a second, real, structural difference a spam filter can key on
// independent of any content in the message itself.
assert.ok(testEmailBody.includes("workspaceConfig?.invitationIdentity?.senderEmail"), "sendTestEmail must resolve the same workspace sender identity sendEmail uses, not a generic fallback");
assert.ok(testEmailBody.includes("workspaceConfig?.invitationIdentity?.senderName"), "sendTestEmail must use the workspace's real sender name, not a hardcoded generic one");

// The recipient can now be a separate Gmail/Outlook mailbox. Sending from
// team@elliescoaching.com back to itself through a third-party provider is a
// self-spoofing-looking pattern and does not predict inbox placement for a
// real lead. The subject must also remain identical to production.
assert.ok(testEmailBody.includes("to: recipient"), "sendTestEmail must deliver to the explicitly selected test mailbox");
assert.ok(!testEmailBody.includes("subject: `[TEST]"), "sendTestEmail must not alter the production subject with a TEST prefix");

console.log("Outreach test-email headers test passed: test sends now use the same sender identity as real sends.");
