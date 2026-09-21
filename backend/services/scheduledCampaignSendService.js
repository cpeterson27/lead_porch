const Outreach = require("../models/Outreach");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const { sendEmail } = require("./email");

// The exact same per-item send logic as the manual "Send selected" button
// (routes/outreach.js's POST /send) — suppression check first, then the
// real Resend send, 5 workers in parallel. Deliberately reused rather than
// reimplemented so a scheduled auto-send can never drift from what the
// manual button already does and has been proven safe with. The one real
// difference: /send is capped at 100 items per call (to fit one HTTP
// request); this has no such cap since nothing is waiting on an HTTP
// response — it processes every currently-approved draft for the campaign.
async function sendApprovedOutreachForCampaign(campaignId, { deliveryPurpose = "marketing", allowUnverified = false } = {}) {
  const items = await Outreach.find({ campaignId, status: "approved" });
  let sentCount = 0;
  let failedCount = 0;
  const failures = [];

  const processItem = async (item) => {
    const contact = item.contactId
      ? await Contact.findById(item.contactId).select("status emailStatus emailBounced")
      : await Contact.findOne({ email: String(item.contactEmail || "").toLowerCase() }).select("status emailStatus emailBounced");
    if (
      contact &&
      (["invalid", "unsubscribed", "archived"].includes(contact.status) ||
        contact.emailBounced === true ||
        contact.emailStatus === "undeliverable")
    ) {
      item.status = "failed";
      item.deliveryStatus = "suppressed";
      item.failedAt = new Date();
      item.errorMessage = "Suppressed because this address previously bounced or cannot receive marketing email.";
      failedCount++;
      failures.push({ outreachId: item._id, email: item.contactEmail, message: item.errorMessage });
      await item.save();
      return;
    }
    const result = await sendEmail(item, { allowUnverified, deliveryPurpose });
    if (result.success) {
      item.status = "sent";
      item.sentAt = new Date();
      item.messageId = result.id || "";
      item.deliveryStatus = "accepted";
      item.deliveryPurpose = deliveryPurpose;
      item.prospectingAttestedAt = deliveryPurpose === "business_prospecting" ? new Date() : null;
      sentCount++;
    } else {
      item.status = "failed";
      item.deliveryStatus = "failed";
      item.failedAt = new Date();
      item.errorMessage = result.message;
      failedCount++;
      failures.push({ outreachId: item._id, email: item.contactEmail, message: result.message });
    }
    await item.save();
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await processItem(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));

  if (sentCount > 0) await Campaign.updateOne({ _id: campaignId }, { $inc: { "metrics.sent": sentCount } });

  return { totalCount: items.length, sentCount, failedCount, failures };
}

module.exports = { sendApprovedOutreachForCampaign };
