const assert = require("assert");
const { matchReasons, rankAutomaticAudienceTemplates, searchableText, selectAutomaticAudienceTemplate } = require("./services/campaignAudienceService");

const multifamilyInvestor = {
  title: "Real Estate Investor and Developer",
  industry: "real estate",
  keywords: ["multifamily", "property acquisitions"],
  tags: ["event-lead"],
};

assert(searchableText(multifamilyInvestor).includes("multifamily"));
const reasons = matchReasons(multifamilyInvestor, ["Multifamily investors", "Real estate investors"]);
assert.strictEqual(reasons.length, 2);
assert(reasons.some((reason) => reason.audience === "Multifamily investors"));
assert(reasons.some((reason) => reason.audience === "Real estate investors"));
assert.deepStrictEqual(matchReasons({ title: "Dentist" }, ["Airbnb investors"]), []);

const templates = [
  { key: "community", label: "Community partner" },
  { key: "multifamily", label: "Multifamily investors" },
];
assert.strictEqual(selectAutomaticAudienceTemplate(multifamilyInvestor, templates).key, "multifamily");
assert.strictEqual(selectAutomaticAudienceTemplate({ audienceProfiles: ["Community partner"] }, templates).key, "community");
assert.strictEqual(selectAutomaticAudienceTemplate({ title: "Dentist" }, templates), null);
assert.deepStrictEqual(
  rankAutomaticAudienceTemplates({ audienceProfiles: ["Community partner"] }, templates).map((item) => item.key),
  ["community"],
);

console.log("Campaign audience matching tests passed");
