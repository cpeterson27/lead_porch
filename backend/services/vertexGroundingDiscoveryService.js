/**
 * Connects Vertex AI Grounding (services/vertexGroundingService.js) to
 * Discovery as an OPTIONAL public-web research source, entirely separate
 * from Apollo/PDL (the structured people/company providers, unchanged) and
 * OpenAI/Jarvis (planning and qualification, unchanged). Every grounded
 * result lands in a review queue (GroundingResearchResult) with its
 * citations attached — nothing here ever becomes a CRM contact,
 * organization, or lead without an explicit, separate "save" action.
 *
 * Deduplication happens at two layers: services/geminiService.js's
 * deduplicateAndCorroborate() already merges duplicate entities WITHIN one
 * search's results (by type+name+domain, raising confidence only when
 * independent citation domains agree); this service ALSO merges a new
 * finding into an existing, still-open review row from an EARLIER search
 * for the same entity, rather than creating a duplicate row every time the
 * same person/organization/event/community turns up again.
 */
const GroundingResearchResult = require("../models/GroundingResearchResult");
const Organization = require("../models/Organization");
const vertexGroundingService = require("./vertexGroundingService");
const { ingestContacts } = require("./contactIngestionService");
const auditService = require("./auditService");

function fingerprintKey({ type, name, organizationDomain }) {
  return `${type}:${String(name || "").trim().toLowerCase()}:${String(organizationDomain || "").trim().toLowerCase()}`;
}

/**
 * Runs a real, billed Vertex Grounding call and stages every result into
 * the review queue. Never creates a Contact/Organization/lead — only
 * pending_review rows. Merges into an existing open (pending_review) row
 * for the same entity instead of duplicating it.
 */
async function search({ workspaceId, userId, auth, query, resultTypes, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const vertex = dependencies.vertexGroundingService || vertexGroundingService;
  const { results, groundingCitations } = await vertex.groundedSearch({ workspaceId, userId, query, resultTypes, correlationId }, dependencies);

  const existing = await Model.find({ workspaceId, status: "pending_review" }).select("type name organizationDomain evidenceUrls confidence").lean();
  const existingByKey = new Map(existing.map((row) => [fingerprintKey(row), row]));

  let created = 0, merged = 0;
  for (const result of results) {
    const key = fingerprintKey(result);
    const match = existingByKey.get(key);
    if (match) {
      const mergedUrls = [...new Set([...(match.evidenceUrls || []), ...(result.evidenceUrls || [])])];
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: match._id }, { $set: { evidenceUrls: mergedUrls, confidence: result.confidence === "corroborated" || match.confidence === "corroborated" ? "corroborated" : "single_source", summary: result.summary || match.summary } });
      merged += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Model.create({
      workspaceId, query: String(query || "").slice(0, 2000), type: result.type, name: result.name,
      organizationName: result.organizationName, organizationDomain: result.organizationDomain,
      summary: result.summary, evidenceUrls: result.evidenceUrls, confidence: result.confidence,
      status: "pending_review", createdByUserId: userId, correlationId,
    });
    created += 1;
  }

  return { created, merged, total: results.length, groundingCitations };
}

async function listResults({ workspaceId, status, type }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const filter = { workspaceId };
  if (status) filter.status = status;
  if (type) filter.type = type;
  return Model.find(filter).sort({ createdAt: -1 }).limit(200).lean();
}

/**
 * Saves one reviewed result with source attribution and deduplication:
 * person -> a real Contact via the SAME ingestContacts() pipeline the
 * existing (Jarvis/ChatGPT) People Research flow already uses, so
 * email-less public-web finds are handled identically and email-based
 * dedup still applies whenever an email exists. organization -> a real
 * Organization, deduplicated by domain via the model's own existing sparse
 * unique index. community/event have no equivalent CRM entity in this app
 * today — "saved" honestly means kept in this review queue's own record
 * (with all its evidence) rather than inventing a new CRM entity type.
 */
async function saveResult({ workspaceId, userId, resultId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const OrganizationModel = dependencies.Organization || Organization;
  const ingest = dependencies.ingestContacts || ingestContacts;
  const row = await Model.findOne({ _id: resultId, workspaceId });
  if (!row) { const error = new Error("Grounding result not found"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  if (row.status !== "pending_review") { const error = new Error("This result has already been reviewed"); error.code = "GROUNDING_RESULT_ALREADY_REVIEWED"; throw error; }

  let savedContactId = null, savedOrganizationId = null;
  if (row.type === "person") {
    const [firstName, ...rest] = String(row.name).trim().split(/\s+/);
    const summary = await ingest({
      contacts: [{
        "First Name": firstName || row.name, "Last Name": rest.join(" "), "Company Name": row.organizationName,
        "Website": row.organizationDomain, "Primary Email Source": row.evidenceUrls?.[0] || "",
      }],
      source: "vertex_grounding",
    });
    savedContactId = summary.createdContacts?.[0]?.id || summary.updatedContacts?.[0]?.id || null;
    if (!savedContactId) { const error = new Error(summary.errors?.[0]?.message || "Unable to save this person to Contacts"); error.code = "GROUNDING_RESULT_SAVE_FAILED"; throw error; }
  } else if (row.type === "organization") {
    const organization = row.organizationDomain
      ? await OrganizationModel.findOneAndUpdate(
          { workspaceId, domain: row.organizationDomain },
          { $set: { name: row.organizationName || row.name, source: "vertex_grounding" }, $setOnInsert: { workspaceId, domain: row.organizationDomain } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
      : await OrganizationModel.create({ workspaceId, name: row.organizationName || row.name, source: "vertex_grounding" });
    savedOrganizationId = organization._id;
  }
  // community / event: no CRM entity to create — the row itself, marked
  // saved below, IS the saved record, with its full evidence intact.

  row.status = "saved";
  row.reviewedByUserId = userId;
  row.reviewedAt = new Date();
  row.savedContactId = savedContactId;
  row.savedOrganizationId = savedOrganizationId;
  await row.save();

  await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { status: "saved", type: row.type, savedContactId, savedOrganizationId }, provider: "vertex", success: true });
  return row;
}

async function dismissResult({ workspaceId, userId, resultId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const row = await Model.findOneAndUpdate(
    { _id: resultId, workspaceId, status: "pending_review" },
    { $set: { status: "dismissed", reviewedByUserId: userId, reviewedAt: new Date() } },
    { new: true },
  );
  if (!row) { const error = new Error("Grounding result not found or already reviewed"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  return row;
}

module.exports = { search, listResults, saveResult, dismissResult };
