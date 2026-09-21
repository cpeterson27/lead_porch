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

// Real, reported incident: a program campaign with no explicit
// registration link or callToActionUrl used to silently fall back to
// linking the primary CTA at the program's own homepage — an owner found
// this exact auto-generated button in a sent email with no idea where it
// came from (it isn't a block in the Unlayer canvas, so there was nothing
// to click and delete) and no way to turn it off. There must be no
// fallback at all now: no button, not even to the homepage, unless a real
// registration link or an explicitly-set callToActionUrl exists.
assert.doesNotMatch(draft.htmlBody, /href="https:\/\/elliescoaching\.com\/"/, "must never silently fall back to the homepage URL");
assert.doesNotMatch(draft.htmlBody, /elliescoaching\.com\/apply/);
assert.doesNotMatch(draft.htmlBody, /\{\{eventLink\}\}/, "an unresolved {{eventLink}} token must never reach the sent email");

const explicitDraft = generateOutreachDraft(
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
      callToActionUrl: "https://elliescoaching.com/apply",
    },
  },
);
assert.match(explicitDraft.htmlBody, /href="https:\/\/elliescoaching\.com\/apply"/, "an explicitly-set callToActionUrl must still work — only the silent homepage fallback is gone");

console.log("Program email CTA tests passed: no silent homepage fallback, explicit callToActionUrl still works.");
