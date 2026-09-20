import assert from "node:assert/strict";
import fs from "node:fs";
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const workspace = read("./src/pages/SocialWorkspace.jsx");
const commentActions = read("./src/components/FacebookCommentActions.jsx");
for (const control of [
  'Manage {instagram ? "Instagram" : "Facebook"} comment',
  "Post public reply",
  "Hide",
  "Unhide",
  "Like as Page",
  "Remove Page like",
  "Delete comment",
  "Automatic replies remain disabled",
])
  assert(commentActions.includes(control));
assert(
  commentActions.includes("manageFacebookComment") &&
    commentActions.includes("idempotencyKey"),
);
assert(workspace.includes("Connected account insights"));
assert(workspace.includes("providerInsights"));
for (const section of [
  "overview",
  "create",
  "calendar",
  "content",
  "inbox",
  "automations",
  "distribution",
  "analytics",
  "accounts",
  "settings",
])
  assert(workspace.includes(`"${section}"`));
const studio = read("./src/pages/SocialStudio.jsx");
const automationFields = read("./src/components/SocialAutomationFields.jsx");
const studioSurface = `${studio}\n${automationFields}`;
for (const control of [
  "Generate post",
  "Repurpose existing content",
  "Upload image",
  "Internal post name",
  "For organizing your content. This won't appear on social media.",
  "Freedom coaching intro",
  "Is this post promoting something? (optional)",
  "No — general content",
  "Save draft",
])
  assert(studioSurface.includes(control));
for (const control of [
  "Automate responses to this post",
  "Automation name",
  "Internal only",
  "Comment contains keyword",
  "Any new comment",
  "Keywords",
  "Automatic reply",
  "Button text (optional)",
  "Learn more",
  "Button link (optional)",
  "https://elliescoaching.com/apply",
  "Turn on when post is published",
  "createSocialAutomation",
  "contentBriefId",
  "campaignId",
  "tags",
  "automationReady",
])
  assert(studioSurface.includes(control));
for (const control of [
  "Campaign (optional)",
  "Contact labels",
  "Select an existing label",
  "Create a new label",
])
  assert(automationFields.includes(control));
assert.equal(studio.includes("Account for this automation"), false);
assert(
  studio.includes("metaDestinations") &&
    studio.includes("destination.provider") &&
    studio.includes("destination.assetId"),
);
const tasks = read("./src/components/AmbassadorContentTasks.jsx");
for (const control of [
  "My content tasks",
  "Copy caption",
  "Open approved media",
  "Mark completed",
  "Decline",
])
  assert(tasks.includes(control));
assert(
  read("./src/App.jsx").includes('hasPermission(session, "social.manage")'),
);
assert(read("./src/App.jsx").includes("isSocialConnectionOnly(session)"));
assert(
  read("./src/App.jsx").includes(
    '<SocialWorkspace connectionsOnly section="accounts" />',
  ),
);
assert(workspace.includes("Connected Accounts could not load"));
assert(
  workspace.includes('oauthStatus === "connected"') &&
    workspace.includes('oauthStatus === "denied"') &&
    workspace.includes('oauthStatus === "failed"'),
);
const connectedAccounts = read("./src/components/SocialConnectedAccounts.jsx");
for (const value of [
  "socialAssetIdentity",
  "identity.primary",
  "identity.secondary",
  "asset.avatarUrl",
  "social-asset-initials",
])
  assert(connectedAccounts.includes(value));
for (const value of [
  "Choose which LinkedIn Page to manage",
  "No manageable LinkedIn Pages were returned",
  "LinkedIn",
])
  assert(connectedAccounts.includes(value));
const sidebar = read("./src/components/Sidebar.jsx"),
  navbar = read("./src/components/Navbar.jsx");
assert(
  sidebar.includes("socialConnectionOnly") &&
    sidebar.includes('session?.workspace?.name || "Lead Porch"'),
);
assert(
  navbar.includes('session?.workspace?.name || "Lead Porch"') &&
    navbar.includes('session?.workspace?.name || "Workspace"'),
);
assert(
  read("./src/components/SocialReplyComposer.jsx").includes(
    "I approve sending this exact reply",
  ),
);
assert(
  /@media\s*\(max-width:\s*\d+px\)/.test(
    read("./src/pages/SocialWorkspace.css"),
  ),
);
console.log(
  "Social workspace, studio, calendar, inbox, distribution and permission UI contracts passed.",
);
