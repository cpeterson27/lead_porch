/**
 * Contact Routes
 * Manage contacts and campaign recipient lists
 */

const express = require("express");
const mongoose = require("mongoose");
const contactService = require("../services/contactService");
const ContactImportReceipt = require("../models/ContactImportReceipt");
const { ingestContacts, previewContactIngestion, canonicalFieldMap } = require("../services/contactIngestionService");
const emailVerificationService = require("../services/emailVerificationService");
const EmailVerificationBatch = require("../models/EmailVerificationBatch");
const Contact = require("../models/Contact");
const Campaign = require("../models/Campaign");
const Outreach = require("../models/Outreach");
const CrmActivity = require("../models/CrmActivity");
const { applyResearchClassification } = require("../services/contactResearchService");
const { assessEmail } = require("../services/emailRiskService");
const { extractBusinessCard, extractDigitalBusinessCard } = require("../services/businessCardExtractionService");
const { generateLinkedinDraft } = require("../services/linkedinOutreachService");
const { getConnectionPriorities } = require("../services/campaignAudienceService");
const { authenticatedUserId } = require("../authorization/accessPolicy");
const agentExecutionService = require("../services/agentExecutionService");

const router = express.Router();

router.post("/business-card/extract", async (req, res) => {
  try {
    const contact = await extractBusinessCard(req.body?.image);
    return res.json({ success: true, data: contact });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Unable to read the business card image" });
  }
});

router.post("/business-card/resolve", async (req, res) => {
  try {
    const contact = await extractDigitalBusinessCard(req.body?.url);
    return res.json({ success: true, data: contact });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Unable to read the digital business card" });
  }
});

router.post("/email-risk/check", async (req, res) => {
  try {
    const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : [req.body?.email]).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 500);
    if (!emails.length) return res.status(400).json({ success: false, message: "Provide at least one email address." });
    const results = [];
    for (const email of emails) results.push(await assessEmail(email));
    return res.json({ success: true, data: { results, policy: "Growth Operator does not probe mailboxes or claim an address is verified from DNS alone." } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Unable to assess email risk." });
  }
});

router.get("/imports/latest", async (req, res) => {
  const latest = await ContactImportReceipt.findOne({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).lean();
  if (!latest || Date.now() - new Date(latest.createdAt).getTime() > 86400000) return res.json({ data: null });
  return res.json({ data: { ...latest.summary, receiptId: latest._id, completedAt: latest.createdAt } });
});

/**
 * POST /api/contacts
 * Create contact (or update if duplicate by email+source)
 */
router.post("/", async (req, res) => {
  try {
    const {
      name,
      firstName,
      lastName,
      email,
      company,
      organizationId,
      source,
      externalId,
      tags,
      status,
    } = req.body;

    if (!email || !source) {
      return res
        .status(400)
        .json({ success: false, message: "Email and source are required" });
    }

    const existingContact = await Contact.findOne({ email: String(email).trim().toLowerCase() }).select("_id").lean();
    const contact = await contactService.upsertContact({
      name: name || `${firstName || ""} ${lastName || ""}`.trim(),
      firstName,
      lastName,
      email,
      company,
      organizationId: organizationId
        ? mongoose.Types.ObjectId(organizationId)
        : null,
      source,
      externalId,
      tags: tags || [],
      status: status || "active",
    });

    if (!existingContact) await CrmActivity.create({ contactId: contact._id, type: "system", title: "Contact created", source: "crm", createdBy: authenticatedUserId(req), metadata: { eventType: "contact.created", source } });
    res
      .status(201)
      .json({
        success: true,
        data: contact,
        message: "Contact created/updated",
      });
  } catch (err) {
    if (err.message.includes("duplicate key")) {
      return res
        .status(409)
        .json({ success: false, message: "Duplicate contact" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/contacts
 * List contacts with filters
 */
router.get("/", async (req, res) => {
  try {
    const {
      email,
      externalId,
      source,
      organizationId,
      status,
      tags,
      limit = 50,
      skip = 0,
      researchStatus,
      qualifyContact,
      emailStatus,
      campaignId,
      search,
      contactMethod,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = status ? { status } : { status: { $ne: "archived" } };
    if (email) query.email = email;
    if (externalId) query.externalId = externalId;
    if (source) query.$or = [{ source }, { sourceProvider: source }, { sources: source }];
    if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
      query.organizationId = mongoose.Types.ObjectId(organizationId);
    }
    if (status) query.status = status;
    if (tags) query.tags = { $in: typeof tags === "string" ? [tags] : tags };
    if (researchStatus) query.researchStatus = researchStatus;
    if (qualifyContact !== undefined) query.qualifyContact = String(qualifyContact) === "true";
    if (emailStatus) query.emailStatus = emailStatus;
    if (campaignId && mongoose.Types.ObjectId.isValid(campaignId)) query.campaignIds = campaignId;
    if (search) {
      const safeSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 120);
      if (safeSearch) {
        const searchConditions = ["name", "firstName", "lastName", "email", "company", "title", "notes"].map((field) => ({ [field]: { $regex: safeSearch, $options: "i" } }));
        query.$and = [...(query.$and || []), { $or: searchConditions }];
      }
    }
    if (contactMethod === "email") query.email = { $exists: true, $nin: [null, ""] };
    if (contactMethod === "linkedin") query.linkedin = { $exists: true, $nin: [null, ""] };
    if (contactMethod === "both") query.$and = [...(query.$and || []), { email: { $exists: true, $nin: [null, ""] } }, { linkedin: { $exists: true, $nin: [null, ""] } }];
    if (contactMethod === "none") query.$and = [...(query.$and || []), { $or: [{ email: { $in: [null, ""] } }, { email: { $exists: false } }] }, { $or: [{ linkedin: { $in: [null, ""] } }, { linkedin: { $exists: false } }] }];

    const allowedSorts = new Set(["createdAt", "updatedAt", "name", "company", "lastContacted"]);
    const resolvedSort = allowedSorts.has(sortBy) ? sortBy : "createdAt";
    const resolvedDirection = sortOrder === "asc" ? 1 : -1;

    const total = await Contact.countDocuments(query);
    const contacts = await Contact.find(query)
      .limit(Math.min(parseInt(limit) || 50, 500))
      .skip(parseInt(skip) || 0)
      .sort({ [resolvedSort]: resolvedDirection, _id: resolvedDirection });

    res.json({
      success: true,
      data: contacts,
      pagination: { total, limit, skip },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/email-verification/batches", async (req, res) => {
  try {
    const emails = emailVerificationService.cleanEmails(req.body?.emails);
    const emailFingerprint = emailVerificationService.fingerprintEmails(emails);
    const existing = await EmailVerificationBatch.findOne({
      emailFingerprint,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (existing) {
      return res.status(200).json({
        success: true,
        data: {
          id: existing.providerBatchId,
          total: existing.total,
          complete: existing.complete,
          reused: true,
        },
      });
    }

    const data = await emailVerificationService.createBatch(emails);
    await EmailVerificationBatch.create({
      providerBatchId: data.id,
      emailFingerprint,
      emails,
      total: data.total,
    });
    return res.status(202).json({ success: true, data });
  } catch (err) {
    const providerStatus = err.response?.status;
    const providerMessage = String(
      err.response?.data?.message ||
      err.response?.data?.error ||
      "",
    ).trim();
    const status = err.code === "email_verification_not_configured"
      ? 503
      : providerStatus
        ? 502
        : 400;
    const message = err.code === "email_verification_not_configured"
      ? "Email verification is not configured on the server."
      : providerStatus === 401 || providerStatus === 403
        ? "Emailable rejected the API key. Confirm the live private key in Render."
        : providerStatus === 402
          ? "Emailable does not have enough credits for this batch. Add credits or verify a smaller file."
          : providerStatus === 400
            ? providerMessage || "Emailable rejected the batch details."
            : providerStatus
              ? providerMessage || "Emailable could not start email verification."
              : err.message || "Unable to start email verification";
    return res.status(status).json({
      success: false,
      message,
    });
  }
});

router.post("/email-verification/batches/recover", async (req, res) => {
  const emails = emailVerificationService.cleanEmails(req.body?.emails);
  if (!emails.length) return res.status(400).json({ success: false, message: "At least one email is required" });
  const saved = await EmailVerificationBatch.findOne({
    emailFingerprint: emailVerificationService.fingerprintEmails(emails),
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!saved) return res.status(404).json({ success: false, message: "No saved verification batch matches this CSV" });
  return res.json({
    success: true,
    data: {
      id: saved.providerBatchId,
      processed: saved.processed,
      total: saved.total,
      complete: saved.complete,
      counts: saved.counts,
      results: saved.results,
    },
  });
});

router.get("/email-verification/batches/:batchId", async (req, res) => {
  try {
    const data = await emailVerificationService.getBatch(req.params.batchId);
    await EmailVerificationBatch.findOneAndUpdate(
      { providerBatchId: req.params.batchId },
      {
        processed: data.processed,
        total: data.total,
        complete: data.complete,
        counts: data.counts,
        results: data.results,
      },
    );
    return res.json({ success: true, data });
  } catch (err) {
    const status = err.code === "email_verification_not_configured" ? 503 : 502;
    return res.status(status).json({
      success: false,
      message: "Unable to retrieve email verification results",
    });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const active = { status: { $ne: "archived" } };
    const audienceUnknownCriteria = {
      $and: [
        { $or: [{ audienceProfiles: { $exists: false } }, { audienceProfiles: { $size: 0 } }] },
        { $or: [{ title: { $exists: false } }, { title: "" }] },
        { $or: [{ industry: { $exists: false } }, { industry: "" }] },
        { $or: [{ company: { $exists: false } }, { company: "" }] },
        { $or: [{ seniority: { $exists: false } }, { seniority: "" }] },
        { $or: [{ keywords: { $exists: false } }, { keywords: { $size: 0 } }] },
        { $or: [{ lists: { $exists: false } }, { lists: { $size: 0 } }] },
      ],
    };
    const [
      total,
      approved,
      verified,
      risky,
      undeliverable,
      withoutEmail,
      needsResearch,
      readyForReview,
      qualified,
      campaignAssigned,
      audienceUnknown,
      needsAttention,
      emailAttention,
      audienceAttention,
      readyToAssign,
      missingFields,
    ] = await Promise.all([
      Contact.countDocuments(active),
      Contact.countDocuments({ status: "active" }),
      Contact.countDocuments({ ...active, emailStatus: "verified", email: { $type: "string", $ne: "" } }),
      Contact.countDocuments({ ...active, emailStatus: "risky" }),
      Contact.countDocuments({ ...active, emailStatus: "undeliverable" }),
      Contact.countDocuments({ ...active, $or: [{ email: { $exists: false } }, { email: "" }, { email: null }] }),
      Contact.countDocuments({ ...active, researchStatus: "needs_research" }),
      Contact.countDocuments({ ...active, researchStatus: "ready_for_review" }),
      Contact.countDocuments({ ...active, researchStatus: "qualified", qualifyContact: true }),
      Contact.countDocuments({ ...active, "campaignIds.0": { $exists: true } }),
      Contact.countDocuments({ ...active, ...audienceUnknownCriteria }),
      Contact.countDocuments({
        ...active,
        $or: [
          { emailStatus: { $ne: "verified" } },
          { email: { $exists: false } },
          { email: "" },
          audienceUnknownCriteria,
        ],
      }),
      Contact.countDocuments({
        ...active,
        $or: [
          { emailStatus: { $ne: "verified" } },
          { email: { $exists: false } },
          { email: "" },
        ],
      }),
      Contact.countDocuments({
        ...active,
        emailStatus: "verified",
        email: { $type: "string", $ne: "" },
        ...audienceUnknownCriteria,
      }),
      Contact.countDocuments({
        ...active,
        emailStatus: "verified",
        email: { $type: "string", $ne: "" },
        "campaignIds.0": { $exists: false },
        $nor: [audienceUnknownCriteria],
      }),
      Contact.aggregate([
        { $match: active },
        { $unwind: "$missingFields" },
        { $group: { _id: "$missingFields", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);
    return res.json({
      success: true,
      data: {
        total,
        approved,
        verified,
        risky,
        undeliverable,
        withoutEmail,
        needsResearch,
        readyForReview,
        qualified,
        campaignAssigned,
        audienceUnknown,
        needsAttention,
        emailAttention,
        audienceAttention,
        readyToAssign,
        missingFields: Object.fromEntries(missingFields.map((item) => [item._id, item.count])),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Unable to summarize contacts" });
  }
});

router.get("/priorities/ranked", async (req, res) => {
  try {
    if (!req.query.campaignId) return res.status(400).json({ success: false, message: "Choose a campaign to rank connections." });
    const result = await getConnectionPriorities(req.query.campaignId);
    return res.json({ success: true, data: { campaign: { _id: result.campaign._id, name: result.campaign.name, audience: result.campaign.audience || [] }, counts: result.counts, connections: result.ranked } });
  } catch (error) {
    return res.status(error.message === "Campaign not found" ? 404 : 400).json({ success: false, message: error.message || "Unable to rank connections" });
  }
});

router.patch("/bulk/assign-campaign", async (req, res) => {
  try {
    const contactIds = [...new Set(Array.isArray(req.body?.contactIds) ? req.body.contactIds : [])];
    const { campaignId } = req.body || {};
    if (!contactIds.length || contactIds.length > 500) {
      return res.status(400).json({ success: false, message: "Select between 1 and 500 contacts" });
    }
    if (!mongoose.Types.ObjectId.isValid(campaignId) || contactIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: "Invalid contact or campaign ID" });
    }
    const campaign = await Campaign.findById(campaignId).select("_id name");
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const contacts = await Contact.find({ _id: { $in: contactIds }, status: { $ne: "archived" } });
    let assigned = 0;
    let skipped = 0;
    for (const contact of contacts) {
      if (!contact.name || !contact.email || contact.emailStatus !== "verified") {
        skipped += 1;
        continue;
      }
      if (!contact.campaignIds.some((id) => String(id) === String(campaign._id))) {
        contact.campaignIds.push(campaign._id);
      }
      contact.qualifyContact = true;
      applyResearchClassification(contact);
      await contact.save();
      assigned += 1;
    }
    skipped += contactIds.length - contacts.length;
    return res.json({
      success: true,
      data: { assigned, skipped, campaignId: campaign._id, campaignName: campaign.name },
      message: `${assigned} contact${assigned === 1 ? "" : "s"} qualified and assigned to ${campaign.name}`,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Unable to assign selected contacts" });
  }
});

router.patch("/bulk/confirm-and-assign", async (req, res) => {
  try {
    const contactIds = [...new Set(Array.isArray(req.body?.contactIds) ? req.body.contactIds : [])];
    const { campaignId, emailAttested, fitAttested } = req.body || {};
    if (!contactIds.length || contactIds.length > 500) {
      return res.status(400).json({ success: false, message: "Select between 1 and 500 contacts" });
    }
    if (emailAttested !== true || fitAttested !== true) {
      return res.status(400).json({ success: false, message: "Confirm both the email addresses and campaign fit for the selected group" });
    }
    if (!mongoose.Types.ObjectId.isValid(campaignId) || contactIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: "Invalid contact or campaign ID" });
    }
    const campaign = await Campaign.findById(campaignId).select("_id name");
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const contacts = await Contact.find({
      _id: { $in: contactIds },
      status: { $nin: ["archived", "invalid", "unsubscribed"] },
      email: { $type: "string", $ne: "" },
    });
    const confirmedAt = new Date();
    let updated = 0;
    for (const contact of contacts) {
      contact.emailStatus = "verified";
      contact.primaryEmailVerificationSource = "owner_confirmation";
      contact.emailConfidence = "personally_confirmed";
      contact.primaryEmailLastVerifiedAt = confirmedAt;
      contact.qualifyContact = true;
      if (!contact.campaignIds.some((id) => String(id) === String(campaign._id))) {
        contact.campaignIds.push(campaign._id);
      }
      applyResearchClassification(contact);
      await contact.save();
      updated += 1;
    }
    return res.json({
      success: true,
      data: {
        confirmedAndAssigned: updated,
        skipped: contactIds.length - updated,
        campaignId: campaign._id,
        campaignName: campaign.name,
      },
      message: `${updated} contact${updated === 1 ? "" : "s"} owner-confirmed and assigned to ${campaign.name}`,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Unable to confirm and assign selected contacts" });
  }
});

/**
 * GET /api/contacts/:id
 * Get single contact
 */
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid contact ID" });
    }

    const contact = await contactService.getContact(req.params.id);
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/contacts/:id/ai-research
 * Lead Agent: read this contact's CRM record, activity history, and opportunities, and produce a
 * written summary and recommended approach. Read-only — proposes nothing, changes nothing.
 */
router.post("/:id/ai-research", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid contact ID" });
    const contactId = req.params.id;
    const result = await agentExecutionService.runAgent({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user._id,
      auth: req.auth,
      agent: "lead",
      task: "research_contact",
      input: { contactId },
      operationalContext:
        "Base every claim strictly on the supplied tool results. Do not invent history, intent, or facts absent from the data. If activity or opportunity history is empty, say so plainly rather than speculating.",
      correlationId: `contact-research:${contactId}`,
      options: {
        tools: [
          { toolId: "crm.get_contact", input: { contactId } },
          { toolId: "crm.list_activity", input: { contactId, limit: 25 } },
          { toolId: "crm.list_opportunities", input: { contactId } },
        ],
        responseSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            keySignals: { type: "array", items: { type: "string" } },
            recommendedApproach: { type: "string" },
            riskFlags: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "keySignals", "recommendedApproach", "riskFlags"],
          additionalProperties: false,
        },
        schemaName: "contact_research",
      },
    });
    res.json({ success: true, data: result.output, metadata: result.metadata });
  } catch (err) {
    const isBillingLimit = err.status === 429 || err.statusCode === 429;
    const status = isBillingLimit
      ? 429
      : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code)
        ? 403
        : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code)
          ? 400
          : 500;
    res.status(status).json({
      success: false,
      message: isBillingLimit
        ? "OpenAI credits are empty. Add API credits to use AI research."
          : err.message,
    });
  }
});

/**
 * PATCH /api/contacts/:id
 * Update contact
 */
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid contact ID" });
    }

    const before = await Contact.findById(req.params.id).select("status stage organizationId").lean();
    const contact = await contactService.updateContact(req.params.id, req.body);
    const changes = ["status", "stage"]
      .filter((field) => req.body[field] !== undefined && String(before?.[field] || "") !== String(contact[field] || ""))
      .map((field) => `${field}: ${before?.[field] || "not set"} → ${contact[field] || "not set"}`);
    if (changes.length) await CrmActivity.create({ contactId: contact._id, organizationId: contact.organizationId || null, type: "status_change", title: "Contact relationship updated", body: changes.join("\n"), source: "crm", createdBy: authenticatedUserId(req) });
    res.json({ success: true, data: contact, message: "Contact updated" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete contact
 */
router.post("/:id/archive", async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: "Contact not found" });
    contact.status = "archived";
    await contact.save();
    return res.json({ success: true, data: contact, message: "Contact archived" });
  } catch (err) { return res.status(400).json({ success: false, message: "Unable to archive contact" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid contact ID" });
    }

    const outreachCount = await Outreach.countDocuments({ contactId: req.params.id });
    if (outreachCount && !req.body?.confirmCascade) return res.status(409).json({ success: false, message: `Cannot permanently delete: ${outreachCount} outreach record(s) depend on this contact.`, outreachCount });
    await contactService.deleteContact(req.params.id);
    res.json({ success: true, message: "Contact deleted" });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

router.post("/merge", async (req, res) => {
  try {
    const { keepId, mergeId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(keepId) || !mongoose.Types.ObjectId.isValid(mergeId)) {
      return res.status(400).json({ success: false, message: "Two valid contact IDs are required" });
    }
    const contact = await contactService.mergeContacts(keepId, mergeId);
    res.json({ success: true, data: contact, message: "Contacts merged" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "Unable to merge contacts" });
  }
});

/**
 * POST /api/contacts/check-duplicate
 * Check for duplicate contact
 */
router.post("/check-duplicate", async (req, res) => {
  try {
    const { email, source } = req.body;

    if (!email || !source) {
      return res
        .status(400)
        .json({ success: false, message: "Email and source required" });
    }

    const isDuplicate = await contactService.isDuplicate(email, source);
    res.json({ success: true, data: { isDuplicate } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/contacts/campaign/:campaignId/recipients
 * Get campaign recipient list from contacts
 */
router.get("/campaign/:campaignId/recipients", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.campaignId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid campaign ID" });
    }

    const { organizationId, source, tags, limit = 500 } = req.query;
    const filters = {};

    if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
      filters.organizationId = mongoose.Types.ObjectId(organizationId);
    }
    if (source) filters.source = source;
    if (tags) filters.tags = typeof tags === "string" ? [tags] : tags;
    filters.limit = Math.min(parseInt(limit) || 500, 500);

    const recipients = await contactService.getCampaignRecipients(
      req.params.campaignId,
      filters,
    );
    res.json({
      success: true,
      data: recipients,
      count: recipients.length,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/contacts/stats
 * Get contact statistics
 */
router.get("/stats", async (req, res) => {
  try {
    const stats = await contactService.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/contacts/sync
 * Sync contacts from external source
 */
router.post("/sync", async (req, res) => {
  try {
    const { source, contacts } = req.body;

    if (!source || !Array.isArray(contacts)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Source and contacts array required",
        });
    }

    const result = await contactService.syncContactsFromSource(
      source,
      contacts,
    );
    res.json({
      success: true,
      data: result,
      message: `Synced: ${result.created} created, ${result.updated} updated, ${result.duplicates} duplicates`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/ingest", async (req, res) => {
  try {
    const result = await ingestContacts(req.body);
    if (result.importBatchId) {
      await ContactImportReceipt.findOneAndUpdate(
        { workspaceId: req.auth.workspaceId, importBatchId: result.importBatchId },
        { $set: { userId: req.auth.user._id, importFileName: result.importFileName || "", summary: result } },
        { upsert: true, new: true },
      );
    }
    return res.json({ success: true, data: result });
  }
  catch (err) { return res.status(400).json({ success: false, message: err.message || "Unable to import contacts" }); }
});

router.post("/ingest/preview", async (req, res) => {
  try { return res.json({ success: true, data: await previewContactIngestion(req.body) }); }
  catch (err) { return res.status(400).json({ success: false, message: err.message || "Unable to preview contact import" }); }
});

router.get("/import/field-map", (req, res) => res.json({ success: true, data: canonicalFieldMap }));

router.post("/:id/linkedin-draft", async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: "Contact not found" });
    if (!contact.linkedin) return res.status(400).json({ success: false, message: "Add this contact’s LinkedIn URL first." });
    const tone = req.body?.tone || "warm_direct";
    contact.linkedinOutreach = { ...(contact.linkedinOutreach?.toObject?.() || contact.linkedinOutreach || {}), draft: generateLinkedinDraft(contact, tone), tone, status: "drafted", approvedAt: null, lastGeneratedAt: new Date() };
    await contact.save();
    return res.json({ success: true, data: contact, message: "LinkedIn draft prepared. Nothing was sent." });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Unable to generate LinkedIn draft" });
  }
});

router.patch("/:id/linkedin-outreach", async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: "Contact not found" });
    const allowedStatuses = ["not_started", "drafted", "approved", "sent", "replied", "not_interested"];
    const status = allowedStatuses.includes(req.body?.status) ? req.body.status : contact.linkedinOutreach?.status || "not_started";
    const draft = String(req.body?.draft ?? contact.linkedinOutreach?.draft ?? "").trim().slice(0, 3000);
    if (status === "approved" && !draft) return res.status(400).json({ success: false, message: "Write or generate a draft before approving it." });
    contact.linkedinOutreach = { ...(contact.linkedinOutreach?.toObject?.() || contact.linkedinOutreach || {}), draft, status, tone: String(req.body?.tone || contact.linkedinOutreach?.tone || "warm_direct"), followUpAt: req.body?.followUpAt ? new Date(req.body.followUpAt) : contact.linkedinOutreach?.followUpAt || null, approvedAt: status === "approved" ? new Date() : contact.linkedinOutreach?.approvedAt || null, sentAt: status === "sent" ? new Date() : contact.linkedinOutreach?.sentAt || null };
    await contact.save();
    return res.json({ success: true, data: contact, message: "LinkedIn outreach updated. Nothing was sent." });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Unable to update LinkedIn outreach" });
  }
});

module.exports = router;
