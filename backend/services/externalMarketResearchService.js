const Audience = require("../models/Audience");
const MarketResearchJob = require("../models/MarketResearchJob");
const Organization = require("../models/Organization");
const apolloService = require("./apolloService");
const { scoreOrganization } = require("./audience");

// Real, paid Apollo Organization Search replaced the previous "owned
// business index" (services/businessDataSourceService.js, now deleted) —
// that index had zero records in production, so in practice every job
// through it returned nothing outside one narrow, free OpenStreetMap
// pilot for Sacramento. Apollo's mixed_companies/search is what "the other
// lead generators" actually run on: a live, externally-maintained company
// database, not a self-hosted index nobody populated.
//
// Hard page cap below (NOT the caller's own maxResults) is the real spend
// guardrail: each page is one paid Apollo API call, so a request for the
// old ceiling of up to 5,000 results would have meant dozens of paid calls
// per job. 3 pages x 100 companies = 300 results max, however large a
// maxResults a caller asks for — this is deliberately conservative and can
// be raised later if the cost is worth it for real usage.
const MAX_APOLLO_COMPANY_PAGES = 3;
const APOLLO_COMPANIES_PER_PAGE = 100;

function sourceStatus() {
  const configured = apolloService.isEnabled();
  return {
    id: "apollo_company_search",
    name: "Apollo Organization Search",
    configured,
    mode: "apollo_live",
    supports: ["organization_search", "evidence", "pagination"],
    message: configured
      ? "Lead Porch will search Apollo's live organization database."
      : "Connect Apollo (set APOLLO_ENABLED=true and APOLLO_API_KEY) to discover organizations not already in your CRM.",
  };
}

function buildApolloCompanyFilters(criteria = {}) {
  const filters = {};
  if (criteria.locations?.length) filters.organization_locations = criteria.locations;
  const keywordTags = [...new Set([...(criteria.industries || []), ...(criteria.keywords || [])])].filter(Boolean);
  if (keywordTags.length) filters.q_organization_keyword_tags = keywordTags;
  const { min, max } = criteria.employeeRange || {};
  if (typeof min === "number" && typeof max === "number" && min <= max) filters.organization_num_employees_ranges = [`${min},${max}`];
  return filters;
}

function apolloCompanyToBusinessItem(company) {
  return {
    providerId: company.externalId,
    sourceId: "apollo_company_search",
    name: company.name,
    domain: company.domain,
    website: company.domain ? `https://${company.domain}` : "",
    industry: company.industry,
    description: "",
    employeeCount: company.employeeCount,
    location: company.location,
    phone: "",
    locationCount: null,
    rating: null,
    reviewCount: null,
    keywords: [],
    decisionMakers: [],
    // Apollo's company search returns no citation URL of its own — a
    // LinkedIn URL is the only real, checkable evidence link it supplies,
    // so evidence stays empty rather than inventing a source.
    evidence: company.linkedinUrl ? [{ sourceType: "apollo", sourceUrl: company.linkedinUrl, field: "organization", observedValue: company.name, observedAt: new Date() }] : [],
  };
}

async function searchApolloCompanies({ workspaceId, userId, plan, cursor = null, limit = APOLLO_COMPANIES_PER_PAGE, correlationId = "" }, dependencies = {}) {
  const apollo = dependencies.apolloService || apolloService;
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isFinite(page) || page < 1 || page > MAX_APOLLO_COMPANY_PAGES) return { success: true, results: [], cursor: null, total: 0 };
  try {
    const filters = buildApolloCompanyFilters(plan?.criteria || {});
    const perPage = Math.min(APOLLO_COMPANIES_PER_PAGE, Math.max(1, Number(limit) || APOLLO_COMPANIES_PER_PAGE));
    const { companies, pagination } = await apollo.searchCompanies({ workspaceId, userId, filters, page, perPage, correlationId });
    const results = companies.map(apolloCompanyToBusinessItem).filter((item) => item.name);
    const hasMore = page < Math.min(pagination.totalPages || 1, MAX_APOLLO_COMPANY_PAGES);
    return { success: true, results, cursor: hasMore ? String(page + 1) : null, total: pagination.totalEntries ?? results.length };
  } catch (error) {
    if (error.code === "APOLLO_DISABLED") return { success: false, code: "source_required", message: sourceStatus().message };
    return { success: false, code: "failed", message: error.response?.data?.message || error.message || "Apollo company search failed." };
  }
}

const uniqueEvidence = (entries = []) => {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.sourceType}|${entry.sourceUrl}|${entry.field}`;
    if (!entry.sourceUrl || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function upsertOrganization(workspaceId, item, criteria, OrganizationModel = Organization) {
  const identity = item.domain
    ? { workspaceId, domain: item.domain }
    : { workspaceId, [`externalSources.${item.sourceId}.id`]: item.providerId };
  const existing = await OrganizationModel.findOne(identity);
  const merged = { ...(existing?.toObject?.() || {}), ...item };
  const { score, tier, reasons } = scoreOrganization(merged, criteria);
  const evidence = uniqueEvidence([...(existing?.researchEvidence || []).map((entry) => entry.toObject?.() || entry), ...item.evidence]);
  const update = {
    workspaceId,
    name: item.name,
    domain: item.domain || null,
    source: "public_web",
    website: item.website || existing?.website || "",
    industry: item.industry || existing?.industry || "",
    description: item.description || existing?.description || "",
    employeeCount: item.employeeCount ?? existing?.employeeCount ?? null,
    location: item.location || existing?.location || "",
    phone: item.phone || existing?.phone || "",
    locationCount: item.locationCount ?? existing?.locationCount ?? null,
    rating: item.rating ?? existing?.rating ?? null,
    reviewCount: item.reviewCount ?? existing?.reviewCount ?? null,
    keywords: [...new Set([...(existing?.keywords || []), ...(item.keywords || [])])],
    researchEvidence: evidence,
    decisionMakers: item.decisionMakers || existing?.decisionMakers || [],
    lastResearchVerifiedAt: evidence.length ? new Date() : existing?.lastResearchVerifiedAt || null,
    audienceScore: score,
    audienceTier: tier,
    scoreReasons: reasons,
    [`externalSources.${item.sourceId}`]: { id: item.providerId || null, refreshedAt: new Date() },
  };
  const organization = await OrganizationModel.findOneAndUpdate(identity, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return { organization, created: !existing };
}

async function runMarketResearchJob(jobId, { maxResults = 1000 } = {}, dependencies = {}) {
  const Job = dependencies.MarketResearchJob || MarketResearchJob;
  const job = await Job.findById(jobId);
  if (!job || job.status === "running" || job.status === "completed") return job;
  job.status = "running";
  job.startedAt = new Date();
  job.error = "";
  await job.save();
  try {
    let cursor = null;
    let received = 0;
    const organizationIds = [];
    const seen = new Set();
    do {
      const page = await (dependencies.searchApolloCompanies || searchApolloCompanies)({ workspaceId: job.workspaceId, userId: job.userId, plan: job.plan, cursor, limit: Math.min(APOLLO_COMPANIES_PER_PAGE, maxResults - received) }, dependencies);
      if (!page.success) {
        job.status = page.code === "source_required" ? "source_required" : "failed";
        job.error = page.message;
        job.completedAt = new Date();
        await job.save();
        return job;
      }
      for (const item of page.results) {
        const signature = item.domain || `${item.sourceId}:${item.providerId}`;
        if (seen.has(signature)) { job.statistics.duplicates += 1; continue; }
        seen.add(signature);
        received += 1;
        try {
          const result = await upsertOrganization(job.workspaceId, item, job.plan.criteria || {}, dependencies.Organization);
          organizationIds.push(result.organization._id);
          if (result.created) job.statistics.created += 1;
          else job.statistics.updated += 1;
        } catch {
          job.statistics.rejected += 1;
        }
        if (received >= maxResults) break;
      }
      cursor = page.cursor;
    } while (cursor && received < maxResults);

    job.statistics.received = received;
    job.status = "completed";
    job.completedAt = new Date();
    const AudienceModel = dependencies.Audience || Audience;
    const audience = await AudienceModel.findById(job.audienceId);
    if (audience) {
      audience.organizationIds = [...new Set([...(audience.organizationIds || []).map(String), ...organizationIds.map(String)])];
      audience.totalOrgs = audience.organizationIds.length;
      audience.lastDiscoveredAt = new Date();
      await audience.save();
    }
    await job.save();
    return job;
  } catch (error) {
    job.status = "failed";
    job.error = error.response?.data?.message || error.message || "External research failed.";
    job.completedAt = new Date();
    await job.save();
    return job;
  }
}

module.exports = { runMarketResearchJob, upsertOrganization, searchApolloCompanies, buildApolloCompanyFilters, sourceStatus };
