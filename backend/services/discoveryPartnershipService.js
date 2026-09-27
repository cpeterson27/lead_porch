const GroundingResearchResult = require("../models/GroundingResearchResult");
const Contact = require("../models/Contact");
const CrmActivity = require("../models/CrmActivity");
const llmService = require("./llmService");

// Confirmed live: organizations/communities/events/podcasts/forums/
// directories found during a "person"-targeted Discovery search (they're
// deliberately included — a search for prospective students also looks for
// communities/organizations where those people gather) had NO automatic
// handling at all: saveResult() explicitly refuses to add anything but a
// "person" to a campaign, so 1,410+ of these piled up in pending_review
// forever with zero next step. The workspace's own review-queue UI already
// labels this bucket "Communities & partnerships... need a partnership
// approach" — this builds exactly that: real AI triage that extracts a
// contact only when one is actually present in the existing evidence
// (never invented), creates a real Contact, and fires a SEPARATE
// partnership-pitch automation (see automationTemplates.js's
// "partnership_outreach") rather than the student sales copy every other
// automation in this file sends. Anything not clearly relevant, or with no
// extractable contact, is resolved immediately (dismissed, or a much
// smaller "needs_review" pile) instead of sitting untouched forever.
const NON_PERSON_TYPES = ["organization", "community", "event", "podcast", "forum", "directory"];
const BATCH_SIZE = 10;

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resultId: { type: "string" },
          relevant: { type: "boolean", description: "true only if this is genuinely likely to be, or lead to, real prospective students for a real-estate investing coaching business — a community, event, podcast, forum, or organization that real estate investors would actually belong to or attend." },
          contactEmail: { type: "string", description: "A real contact email explicitly present in the given text/evidence. Empty string if none is given — never invent or guess one." },
          contactName: { type: "string", description: "A real named contact, admin, or host explicitly present in the given text. Empty string if none is given." },
          reasoning: { type: "string" },
        },
        required: ["resultId", "relevant", "contactEmail", "contactName", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

async function triageBatch({ workspaceId, rows }) {
  const payload = rows.map((row) => ({ resultId: String(row._id), type: row.type, name: row.name, organizationName: row.organizationName || "", summary: row.summary || "", evidenceUrls: row.evidenceUrls || [] }));
  return llmService.generateStructured({
    workspaceId,
    agent: "lead",
    feature: "discovery_partnership_triage",
    schema: TRIAGE_SCHEMA,
    schemaName: "partnership_triage",
    messages: [
      { role: "system", content: "You triage discovery results that are NOT individual people — organizations, communities, events, podcasts, forums, and directories found while searching for prospective students of a real-estate investing coaching business. These are potential PARTNERSHIP targets (places real estate investors gather), never direct sales prospects. For each item, decide if it's genuinely relevant to that audience, and extract a contact email/name ONLY when one is explicitly present in the given text or evidence — never invent or guess one." },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });
}

async function triageNonPersonResults({ workspaceId, discoveryRunId = null, limit = 500 } = {}) {
  const query = { workspaceId, type: { $in: NON_PERSON_TYPES }, status: "pending_review", qualificationLabel: "" };
  if (discoveryRunId) query.discoveryRunId = discoveryRunId;
  const rows = await GroundingResearchResult.find(query).limit(limit);
  const summary = { checked: rows.length, saved: 0, needsReview: 0, dismissed: 0, errors: 0 };
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    let byId;
    try {
      const outcome = await triageBatch({ workspaceId, rows: batch });
      byId = new Map((outcome.items || []).map((item) => [item.resultId, item]));
    } catch (error) {
      console.error("Partnership triage batch failed:", { workspaceId: String(workspaceId), message: error.message });
      summary.errors += batch.length;
      continue;
    }
    for (const row of batch) {
      const result = byId.get(String(row._id));
      if (!result) { summary.errors += 1; continue; }
      if (result.relevant && result.contactEmail) {
        try {
          const normalizedEmail = String(result.contactEmail).toLowerCase().trim();
          const contact = await Contact.findOneAndUpdate(
            { workspaceId, email: normalizedEmail },
            {
              $setOnInsert: { workspaceId, email: normalizedEmail, name: result.contactName || row.organizationName || row.name, firstName: String(result.contactName || "").trim().split(/\s+/)[0] || "", sourceProvider: `discovery_${row.type}` },
              $addToSet: { sources: `discovery_${row.type}`, tags: "partnership-lead" },
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
          );
          const idempotencyKey = `partnership-lead:${row._id}`;
          const existingActivity = await CrmActivity.findOne({ workspaceId, "metadata.idempotencyKey": idempotencyKey }).select("_id").lean();
          if (!existingActivity) await CrmActivity.create({ workspaceId, contactId: contact._id, type: "system", title: `Partnership lead qualified — ${row.name}`, source: "crm", metadata: { eventType: "partnership_lead.qualified", idempotencyKey, groundingResultId: row._id, discoveryType: row.type } });
          row.status = "saved";
          row.qualificationLabel = "qualified";
          row.savedContactId = contact._id;
          summary.saved += 1;
        } catch (error) {
          console.error("Partnership lead save failed:", { workspaceId: String(workspaceId), resultId: String(row._id), message: error.message });
          summary.errors += 1;
          continue;
        }
      } else if (result.relevant) {
        row.qualificationLabel = "needs_review";
        summary.needsReview += 1;
      } else {
        row.status = "dismissed";
        row.qualificationLabel = "not_a_fit";
        summary.dismissed += 1;
      }
      row.reviewedAt = new Date();
      await row.save();
    }
  }
  return summary;
}

module.exports = { triageNonPersonResults };
