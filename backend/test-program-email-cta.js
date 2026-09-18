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

assert.match(draft.htmlBody, /href="https:\/\/elliescoaching\.com\/apply"/);
assert.doesNotMatch(draft.htmlBody, /href=""/);
assert.doesNotMatch(draft.htmlBody, /\{\{eventLink\}\}/);
console.log("Program email CTA fallback tests passed.");
