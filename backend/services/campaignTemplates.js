const templateCatalog = {
  blank: {
    subject: "",
    body: "",
    callToAction: "",
  },
  event_investor: {
    subject: "{{firstName}}, an invitation for real-estate investors",
    body: "Hi {{firstName}},\n\nI wanted to personally invite you to {{campaignName}}. It is designed for investors looking for practical opportunities, clearer strategy, and valuable connections.\n\nWould you like the details?",
    callToAction: "View event details",
  },
  event_operator: {
    subject: "{{firstName}}, built for real-estate operators",
    body: "Hi {{firstName}},\n\n{{campaignName}} brings together operators and multifamily leaders for a focused conversation on growth and execution.\n\nI would love to share the details with you.",
    callToAction: "Explore the event",
  },
  event_partner: {
    subject: "Partner with us for {{campaignName}}",
    body: "Hi {{firstName}},\n\nWe are inviting a small group of trusted partners to help share {{campaignName}} with the right audience.\n\nIf this is a fit for your community, I would be glad to send the partner details.",
    callToAction: "See partner details",
  },
  program_enrollment: {
    subject: "{{firstName}}, an invitation to the next level of your business",
    body: "Hi {{firstName}},\n\n{{programName}} is a premium program for serious operators who want a clear path to stronger execution and measurable growth.\n\nIf you are evaluating your next move, I would be happy to share the enrollment details.",
    callToAction: "Request program details",
  },
  program_operator: {
    subject: "{{firstName}}, an invitation for established operators",
    body: "Hi {{firstName}},\n\n{{programName}} was built for experienced operators who are ready to improve their systems, deal flow, and growth strategy.\n\nWould it be helpful if I sent the program overview?",
    callToAction: "Explore the program",
  },
  program_partner: {
    subject: "A premium referral opportunity for your audience",
    body: "Hi {{firstName}},\n\nWe are opening a limited partner referral opportunity for {{programName}}. It is intended for trusted partners who serve ambitious real-estate operators.\n\nI would be glad to share the referral details.",
    callToAction: "View referral details",
  },
};

function getCampaignTemplate(templateKey, { campaignName = "this campaign", programName = "our premium program" } = {}) {
  const template = templateCatalog[templateKey] || templateCatalog.event_investor;
  const replaceVariables = (value) => value
    .replaceAll("{{campaignName}}", campaignName)
    .replaceAll("{{programName}}", programName || "our premium program");

  return {
    subject: replaceVariables(template.subject),
    body: replaceVariables(template.body),
    callToAction: template.callToAction,
    callToActionUrl: "",
  };
}

module.exports = { getCampaignTemplate, templateCatalog };
