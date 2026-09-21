const assert = require("assert");
const { generateOutreachDraft } = require("./utils/outreachGenerator");

const draft = generateOutreachDraft(
  { firstName: "Jordan", name: "Jordan Lee" },
  {
    name: "September Outreach",
    campaignKind: "program",
    registrationLinks: {},
    brand: { websiteUrl: "https://elliescoaching.com/" },
    content: {
      subject: "Build your plan",
      body: '<a href="{{eventLink}}">Build my plan</a>',
      callToAction: "Build my plan",
      callToActionUrl: "",
    },
  },
);

assert.match(draft.htmlBody, /href="https:\/\/elliescoaching\.com\/"/);
assert.doesNotMatch(draft.htmlBody, /elliescoaching\.com\/apply/);
assert.doesNotMatch(draft.htmlBody, /href=""/);
assert.doesNotMatch(draft.htmlBody, /\{\{eventLink\}\}/);

// Real, reported confusion: an owner found a "Request program details"
// button in their sent emails with no way to see where it came from or
// remove it — it's this exact homepage-fallback button, auto-appended by
// generateOutreachDraft, not a block living in the Unlayer canvas. There
// was previously no escape hatch; hideCallToAction is that escape hatch,
// and it must override every other fallback in eventLink, not just the
// explicit callToActionUrl.
const hiddenDraft = generateOutreachDraft(
  { firstName: "Jordan", name: "Jordan Lee" },
  {
    name: "September Outreach",
    campaignKind: "program",
    registrationLinks: {},
    brand: { websiteUrl: "https://elliescoaching.com/" },
    content: {
      subject: "Build your plan",
      body: '<a href="{{eventLink}}">Build my plan</a>',
      callToAction: "Build my plan",
      callToActionUrl: "",
      hideCallToAction: true,
    },
  },
);
assert.doesNotMatch(hiddenDraft.htmlBody, /href="https:\/\/elliescoaching\.com\/"/, "hideCallToAction must suppress even the homepage fallback, not just an explicit callToActionUrl");

console.log("Program email CTA fallback and hide-button tests passed.");
