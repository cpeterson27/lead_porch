import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("./src/pages/LinkedinOutreach.jsx", import.meta.url), "utf8");
const composer = fs.readFileSync(new URL("./src/components/SocialReplyComposer.jsx", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("./src/services/api.js", import.meta.url), "utf8");

for (const contract of [
  "fetchLinkedinCandidates",
  "fetchLinkedinAnalytics",
  "syncLinkedinInbox",
  "Maximum invitations per rolling 24 hours",
  "Optional follow-up if they do not reply",
  "Find and prepare the right people",
  "Open unified inbox",
  "Search LinkedIn for new people",
  "Add {selected.length || \"selected\"} to CRM",
]) assert(page.includes(contract), `LinkedIn page missing: ${contract}`);

assert(composer.includes('thread.channel === "linkedin"'));
for (const contract of ["/candidates", "/analytics", "/inbox/sync", "/inbox/register-webhook", "/search", "/search/import"])
  assert(api.includes(contract), `LinkedIn API client missing: ${contract}`);

console.log("LinkedIn outreach UI contracts passed");
