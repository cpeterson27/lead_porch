const PLACEHOLDER_SUBJECTS = new Set(["", "Event Campaign"]);
const PLACEHOLDER_BODIES = new Set(["", "Campaign created for event promotion."]);

function dealToCloseBody() {
  return `Hi {{firstName}},

I wanted to personally introduce you to Deal to Close: Multifamily Bootcamp.

This is a one-day virtual event designed for real estate investors who want to learn how to analyze multifamily deals, build investor relationships, raise capital, and confidently move toward acquisitions.

We thought this would be a great fit for your audience because your community is connected to real estate education, investing, and growth opportunities.

We would love to explore a partnership opportunity with you and see if this event would be valuable to share with your audience.

Event Details:

Deal to Close: Multifamily Bootcamp
{{eventDate}}
8:00 AM - 4:00 PM PST

Would you be open to discussing a potential partnership?

Thank you,

Ellie's Coaching`;
}

function effectiveTemplate(campaign) {
  const saved = campaign.emailTemplate || {};
  const content = campaign.content || {};
  const isDealToClose = /deal\s*to\s*close/i.test(String(campaign.name || ""));
  const subject = String(saved.subject || "").trim()
    || (!PLACEHOLDER_SUBJECTS.has(String(content.subject || "").trim()) ? content.subject : "")
    || (isDealToClose ? "Partner With Deal to Close: Multifamily Bootcamp" : `An invitation to ${campaign.name}`);
  const body = String(saved.body || "").trim()
    || (!PLACEHOLDER_BODIES.has(String(content.body || "").trim()) ? content.body : "")
    || (isDealToClose ? dealToCloseBody() : `Hi {{firstName}},\n\nI wanted to personally invite you to {{campaignName}}.\n\nWould you like the details?`);

  return {
    subject,
    body,
    // Only meaningful when `body` came from `saved` (Unlayer can't produce
    // the design that matches a fallback/content-brief body) — null in
    // every other case is correct, not a bug.
    designJson: String(saved.body || "").trim() ? saved.designJson || null : null,
    callToAction: saved.callToAction || content.callToAction || "Learn more",
    callToActionUrl: saved.callToActionUrl || content.callToActionUrl || "",
    hideCallToAction: saved.hideCallToAction === true,
    additionalButtons: Array.isArray(saved.additionalButtons) ? saved.additionalButtons : [],
    topic: saved.topic || (campaign.campaignKind === "program" ? "program_offers" : "event_invitations"),
    status: saved.status || "draft",
    currentVersion: saved.currentVersion || 0,
    approvedAt: saved.approvedAt || null,
  };
}

module.exports = { effectiveTemplate };
