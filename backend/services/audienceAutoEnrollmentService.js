const Organization = require("../models/Organization");
const Campaign = require("../models/Campaign");
const apolloService = require("./apolloService");
const { ingestContacts } = require("./contactIngestionService");
const { regenerateCampaignOutreach } = require("./outreachGenerationService");

// Bounds how many Apollo credits one scheduled search can spend per day —
// this runs unattended, so it must never be able to silently rack up an
// unbounded bill. Decision-maker-level titles only, matching the same
// "high authority" language services/campaignAudienceService.js already
// uses to score contacts, so what gets auto-added is the same kind of
// person a human reviewer would already prioritize.
const MAX_ORGANIZATIONS_PER_RUN = 8;
const MAX_PEOPLE_PER_ORGANIZATION = 3;
const DECISION_MAKER_TITLES = ["owner", "founder", "co-founder", "chief executive officer", "ceo", "cfo", "coo", "president", "partner", "principal", "vice president", "vp", "director"];

/**
 * Finds decision-makers at newly discovered organizations and adds only the
 * ones with an Apollo-*verified* email straight into the CRM, qualified and
 * tagged to `campaignId` — everyone else Apollo can't confidently verify is
 * left alone entirely (no unqualified placeholder rows), preserving the
 * same trust bar the rest of Lead Porch already applies to Apollo emails.
 * Organizations already processed once are tracked by the caller
 * (Audience.scheduledSearch.autoEnrolledOrganizationIds) so the same
 * company is never re-searched for people on every subsequent run.
 */
async function autoEnrollPeopleForCampaign({ workspaceId, campaignId, organizationIds }) {
  const summary = { organizationsProcessed: 0, peopleFound: 0, peopleEnrolled: 0, errors: [] };
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) { summary.errors.push("Target campaign no longer exists."); return summary; }

  const organizations = await Organization.find({ _id: { $in: organizationIds.slice(0, MAX_ORGANIZATIONS_PER_RUN) }, workspaceId }).select("name domain");
  const rows = [];

  for (const organization of organizations) {
    if (!organization.domain) continue;
    summary.organizationsProcessed += 1;
    try {
      const { people } = await apolloService.searchPeople({
        workspaceId,
        filters: { q_organization_domains: organization.domain, person_titles: DECISION_MAKER_TITLES },
        perPage: MAX_PEOPLE_PER_ORGANIZATION,
      });
      summary.peopleFound += people.length;
      for (const candidate of people.slice(0, MAX_PEOPLE_PER_ORGANIZATION)) {
        try {
          const enriched = candidate.raw?.id
            ? await apolloService.enrichPerson({ workspaceId, matchInput: { id: candidate.raw.id }, revealEmail: true })
            : null;
          if (!enriched?.email || enriched.emailState !== "verified") continue;
          rows.push({
            "First Name": enriched.firstName || candidate.firstName,
            "Last Name": enriched.lastName || candidate.lastName,
            Title: enriched.title || candidate.title,
            "Company Name": organization.name,
            Email: enriched.email,
            "Email Status": "verified",
            "Person Linkedin Url": enriched.linkedinUrl || candidate.linkedinUrl || "",
            "Qualify Contact": true,
          });
        } catch (error) {
          summary.errors.push(`${candidate.fullName || "A candidate"} at ${organization.name}: ${error.message || "enrichment failed"}`);
        }
      }
    } catch (error) {
      summary.errors.push(`${organization.name}: ${error.message || "people search failed"}`);
    }
  }

  if (rows.length) {
    const ingestSummary = await ingestContacts({ contacts: rows, source: "apollo_auto_enrollment", campaignId: campaign._id });
    summary.peopleEnrolled = ingestSummary.mongoCreated + ingestSummary.mongoUpdated;
    if (summary.peopleEnrolled) await regenerateCampaignOutreach(campaign, { onlyMissing: true });
  }
  return summary;
}

module.exports = { autoEnrollPeopleForCampaign, MAX_ORGANIZATIONS_PER_RUN, MAX_PEOPLE_PER_ORGANIZATION };
