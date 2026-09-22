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
