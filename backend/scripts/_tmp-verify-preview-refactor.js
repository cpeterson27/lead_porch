require("dotenv").config();
const mongoose = require("mongoose");
const { connectDatabase } = require("../config/database");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const Campaign = require("../models/Campaign");
const { renderEmailContent } = require("../services/email");
const { generateOutreachDraft } = require("../utils/outreachGenerator");

const CAMPAIGN_ID = "6aa71eb0ca4840f86ea6c80b"; // "Ellies Coaching"

async function main() {
  await connectDatabase(process.env.MONGO_URI);
  const campaign = await Campaign.findById(CAMPAIGN_ID);
  if (!campaign) throw new Error("Campaign not found");
  await runWithWorkspace(campaign.workspaceId, async () => {
    const draft = generateOutreachDraft(
      { firstName: "Preview", lastName: "Contact", name: "Preview Contact", company: "Example Co", email: "preview@example.com", sources: ["preview"] },
      campaign.toObject(),
    );
    const { html } = await renderEmailContent(
      {
        workspaceId: campaign.workspaceId,
        campaignId: campaign._id,
        contactId: null,
        contactEmail: "preview@example.com",
        htmlBody: draft.htmlBody,
        emailDraft: draft.emailDraft,
      },
      { contact: null, preview: true },
    );
    console.log("SUCCESS. html length:", html.length);
    console.log("Contains 'Unsubscribe':", html.includes("Unsubscribe"));
    console.log("Contains an <img tag for a logo:", /<img[^>]*alt="[^"]*"[^>]*>/i.test(html));
    console.log("\n--- last 800 chars ---\n", html.slice(-800));
  });
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("VERIFY FAILED:", error);
  process.exit(1);
});
