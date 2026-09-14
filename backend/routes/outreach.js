const express = require("express");

const Outreach = require("../models/Outreach");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const EmailEvent = require("../models/EmailEvent");
const EmailSuppression = require("../models/EmailSuppression");

const { renderEmailContent, sendEmail, sendTestEmail } = require("../services/email");
const CampaignTemplateVersion = require("../models/CampaignTemplateVersion");
const { requireRole } = require("../middleware/auth");
const { selectAutomaticAudienceTemplate } = require("../services/campaignAudienceService");

const {
  generateOutreachDraft,
} = require("../utils/outreachGenerator");


const router = express.Router();


// ======================================
// CLEAN NAME
// ======================================

function cleanName(name = "") {

  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

}



// ======================================
// GET OUTREACH BY CAMPAIGN
// ======================================

router.get("/", async (req, res) => {

  try {

    const filter = {};


    if (req.query.campaignId) {

      filter.campaignId =
        req.query.campaignId;

    }


    const outreach =
      await Outreach.find(filter)
        .populate("contactId", "email emailStatus primaryEmailVerificationSource")
        .sort({
          createdAt: -1
        })
        .lean();

    const replacements = await Outreach.find({
      retryOf: { $in: outreach.map((item) => item._id) },
    }).sort({ createdAt: -1 }).lean();
    const replacementByOriginal = new Map();
    replacements.forEach((replacement) => {
      const key = String(replacement.retryOf || "");
      if (key && !replacementByOriginal.has(key)) replacementByOriginal.set(key, replacement);
    });


    console.log(
      "FETCHING OUTREACH:",
      outreach.length
    );


    res.json(outreach.map((item) => ({
      ...item,
      replacement: replacementByOriginal.get(String(item._id)) || null,
    })));


  } catch(error) {

    console.error(
      "FETCH OUTREACH ERROR:",
      error
    );


    res.status(500).json({
      error:"Failed fetching outreach"
    });

  }

});

router.get("/analytics/summary", async (_req, res) => {
  try {
    const [campaigns, outreach, latestEvent] = await Promise.all([
      Campaign.find().select("name metrics status").sort({ createdAt: -1 }).lean(),
      Outreach.find({ status: { $in: ["sent", "replied"] } })
        .select("campaignId status deliveryStatus sentAt deliveredAt openedAt clickedAt bouncedAt complainedAt repliedAt replyCategory")
        .lean(),
      EmailEvent.findOne().sort({ occurredAt: -1 }).select("occurredAt type").lean(),
    ]);
    const totals = outreach.reduce((result, item) => {
      result.sent += 1;
      if (item.deliveredAt) result.delivered += 1;
      if (item.openedAt) result.opened += 1;
      if (item.clickedAt) result.clicked += 1;
      if (item.bouncedAt) result.bounced += 1;
      if (item.complainedAt) result.complained += 1;
      if (item.status === "replied") result.replied += 1;
      return result;
    }, { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, complained: 0 });
    const byCampaign = campaigns.map((campaign) => {
      const rows = outreach.filter((item) => String(item.campaignId) === String(campaign._id));
      return {
        id: campaign._id,
        name: campaign.name,
        status: campaign.status,
        sent: rows.length,
        delivered: rows.filter((item) => item.deliveredAt).length,
        opened: rows.filter((item) => item.openedAt).length,
        clicked: rows.filter((item) => item.clickedAt).length,
        replied: rows.filter((item) => item.status === "replied").length,
        bounced: rows.filter((item) => item.bouncedAt).length,
      };
    });
    return res.json({
      totals,
      byCampaign,
      webhook: {
        lastEventAt: latestEvent?.occurredAt || null,
        lastEventType: latestEvent?.type || "",
        healthy: Boolean(latestEvent),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to load outreach analytics." });
  }
});

router.get("/:id/preview", async (req, res) => {
  try {
    const outreach = await Outreach.findById(req.params.id);
    if (!outreach) return res.status(404).json({ error: "Outreach email not found." });
    const rendered = await renderEmailContent(outreach, { preview: true });
    return res.json({ subject: outreach.subject, html: rendered.html });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to preview outreach email." });
  }
});

router.post("/:id/test", requireRole("owner", "admin"), async (req, res) => {
  try {
    const outreach = await Outreach.findById(req.params.id);
    if (!outreach) {
      return res.status(404).json({ error: "Outreach email not found." });
    }
    const result = await sendTestEmail(outreach);
    if (!result.success) {
      return res.status(400).json({ error: result.message || "Unable to send test email." });
    }
    return res.json({
      message: result.message,
      messageId: result.id,
      recipient: result.recipient,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to send test email." });
  }
});

router.post("/record-consent", requireRole("owner", "admin"), async (req, res) => {
  try {
    const { campaignId, attested } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: "Campaign is required." });
    if (attested !== true) {
      return res.status(400).json({ error: "Confirm that every campaign contact included in this update gave permission." });
    }
    const consentSource = "campaign_owner_confirmation";
    const recordedAt = new Date();
    const campaign = await Campaign.findById(campaignId).select("campaignKind emailTemplate");
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    const outreach = await Outreach.find({
      campaignId,
      status: { $in: ["pending", "approved", "failed"] },
      contactId: { $ne: null },
    }).select("contactId");
    const contactIds = [...new Set(outreach.map((item) => String(item.contactId)))];
    const topic = campaign.emailTemplate?.topic
      || (campaign.campaignKind === "program" ? "program_offers" : "event_invitations");
    const topicField = {
      event_invitations: "eventInvitations",
      program_offers: "programOffers",
      educational_newsletter: "educationalNewsletter",
    }[topic];
    const result = await Contact.updateMany(
      { _id: { $in: contactIds }, status: { $nin: ["archived", "invalid"] } },
      {
        $set: {
          status: "active",
          "emailPreferences.marketingStatus": "subscribed",
          "emailPreferences.consentSource": consentSource,
          "emailPreferences.consentAt": recordedAt,
          "emailPreferences.unsubscribedAt": null,
          "emailPreferences.unsubscribeSource": "",
          [`emailPreferences.topics.${topicField}`]: true,
        },
      },
    );
    return res.json({
      updatedCount: result.modifiedCount || 0,
      eligibleCount: result.matchedCount || 0,
      topic,
      message: `Recorded permission for ${result.modifiedCount || 0} campaign contact${result.modifiedCount === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to record campaign permission." });
  }
});



// ======================================
// GENERATE OUTREACH
// ======================================

router.post("/generate", async (req,res)=>{

  try {

    const {
      campaignId,
      onlyMissing = false,
    } = req.body;



    if(!campaignId){

      return res.status(400).json({
        error:"campaignId required"
      });

    }



    const campaign =
      await Campaign.findById(
        campaignId
      );



    if(!campaign){

      return res.status(404).json({
        error:"Campaign not found"
      });

    }

    if (campaign.campaignKind !== "program") {
      const eventbriteUrl = String(campaign.registrationLinks?.eventbrite?.url || "").trim();
      const meetupUrl = String(campaign.registrationLinks?.meetup?.url || "").trim();
      const missing = [!eventbriteUrl && "Eventbrite", !meetupUrl && "Meetup"].filter(Boolean);
      if (missing.length) return res.status(400).json({ error: `Add the ${missing.join(" and ")} link${missing.length === 1 ? "" : "s"} to this campaign before generating event emails. Every event draft must include both registration links.` });
    }

    let generalTemplate = campaign.emailTemplate?.currentVersion
      ? await CampaignTemplateVersion.findOne({
        campaignId: campaign._id,
        version: campaign.emailTemplate.currentVersion,
      })
      : null;
    if (!generalTemplate) {
      const template = require("../services/campaignMasterTemplate").effectiveTemplate(campaign);
      const version = (await CampaignTemplateVersion.findOne({ campaignId: campaign._id }).sort({ version: -1 }).select("version"))?.version + 1 || 1;
      generalTemplate = await CampaignTemplateVersion.create({
        campaignId: campaign._id,
        version,
        subject: template.subject,
        body: template.body,
        designJson: template.designJson || null,
        callToAction: template.callToAction,
        callToActionUrl: template.callToActionUrl,
        topic: template.topic,
        approvedByUserId: req.auth.user._id,
        approvedAt: new Date(),
      });
      campaign.emailTemplate = { ...template, status: "approved", currentVersion: version, approvedAt: generalTemplate.approvedAt };
      campaign.activeAudienceTemplateKey = "general";
      await campaign.save();
    }
    const audienceTemplateDefinitions = Object.entries(campaign.emailAudienceTemplates || {})
      .filter(([, template]) => template?.status === "approved" && template?.currentVersion && template?.audienceLabel);
    const audienceTemplateVersions = await CampaignTemplateVersion.find({
      campaignId: campaign._id,
      version: { $in: audienceTemplateDefinitions.map(([, template]) => template.currentVersion) },
    });
    const audienceTemplates = audienceTemplateDefinitions
      .map(([key, definition]) => ({
        key,
        label: definition.audienceLabel,
        template: audienceTemplateVersions.find((version) => version.version === definition.currentVersion),
      }))
      .filter((item) => item.template);



    const contacts =
      await Contact.find({
        type: "lead",
        status: { $nin: ["archived", "unsubscribed", "invalid", "rejected"] },
        emailStatus: "verified",
        email: { $exists: true, $nin: ["", null] },
        campaignIds: campaign._id,
      });



    console.log(
      "Active leads found:",
      contacts.length
    );



    let createdCount = 0;
    let updatedCount = 0;
    let skippedExisting = 0;
    let skippedMissingEmail = 0;
    const routingSummary = {};



    for(const contact of contacts){


      if(!contact.email){

        skippedMissingEmail++;

        continue;

      }



      const email =
        contact.email
          .toLowerCase()
          .trim();



      const exists =
        await Outreach.findOne({

          campaignId: campaign._id,

          contactEmail: email

        });



      const cleanedContact = {

        ...contact.toObject(),

        name:
          cleanName(
            contact.name ||
            contact.firstName ||
            "there"
          ),

        company:
          cleanName(
            contact.company ||
            ""
          )

      };

      const automaticTemplate = selectAutomaticAudienceTemplate(cleanedContact, audienceTemplates);
      const overrideKey = String(cleanedContact.campaignTemplateOverrides?.[String(campaign._id)] || "auto");
      const routedTemplate = overrideKey === "general"
        ? null
        : overrideKey !== "auto"
          ? audienceTemplates.find((candidate) => candidate.key === overrideKey) || automaticTemplate
          : automaticTemplate;
      const recipientTemplate = routedTemplate?.template || generalTemplate;
      const recipientAudienceKey = overrideKey === "general" ? "general" : routedTemplate?.key || "general";
      const recipientAudienceLabel = overrideKey === "general" ? "Main campaign template" : routedTemplate?.label || "Main campaign template";
      routingSummary[recipientAudienceLabel] = (routingSummary[recipientAudienceLabel] || 0) + 1;
      campaign.content = {
        subject: recipientTemplate.subject,
        body: recipientTemplate.body,
        callToAction: recipientTemplate.callToAction,
        callToActionUrl: recipientTemplate.callToActionUrl,
      };



      const draft =
        generateOutreachDraft(
          cleanedContact,
          campaign
        );

      if (exists) {
        if (onlyMissing) {
          skippedExisting++;
          continue;
        }
        if (["pending", "failed"].includes(exists.status)) {
          exists.organization = draft.organization;
          exists.contactName = draft.contactName;
          exists.contactRole = draft.contactRole;
          exists.reason = draft.reason;
          exists.subject = draft.subject;
          exists.emailDraft = draft.emailDraft;
          exists.htmlBody = draft.htmlBody || "";
          exists.designJson = recipientTemplate.designJson || null;
          exists.eventLink = draft.eventLink || "";
          exists.flyerUrl = draft.flyerUrl || "";
          exists.templateVersion = recipientTemplate.version;
          exists.templateAudienceKey = recipientAudienceKey;
          exists.templateAudienceLabel = recipientAudienceLabel;
          exists.emailTopic = recipientTemplate.topic;
          exists.status = "pending";
          exists.errorMessage = "";
          await exists.save();
          updatedCount++;
        } else {
          skippedExisting++;
        }
        continue;
      }

      await Outreach.create({

  campaignId: campaign._id,

  contactId: contact._id,

  organization:
    draft.organization,

  contactName:
    draft.contactName,

  contactEmail:
    email,

  contactRole:
    draft.contactRole,

  reason:
    draft.reason,

  subject:
    draft.subject,

  emailDraft:
    draft.emailDraft,

  htmlBody:
    draft.htmlBody || "",

  designJson:
    recipientTemplate.designJson || null,

  eventLink:
    draft.eventLink || "",

  flyerUrl:
    draft.flyerUrl || "",

  templateVersion: recipientTemplate.version,

  templateAudienceKey: recipientAudienceKey,

  templateAudienceLabel: recipientAudienceLabel,

  emailTopic: recipientTemplate.topic,

  status:
    "pending"

});



      createdCount++;

    }




    const outreach =
      await Outreach.find({

        campaignId:
          campaign._id

      })
      .sort({
        createdAt:-1
      });



    console.log({

      createdCount,
      updatedCount,

      skippedExisting,

      skippedMissingEmail,

      totalCampaignOutreach:
        outreach.length

    });



    console.log(
      "======================================"
    );



    res.json({

      outreach,

      createdCount,
      updatedCount,

      skippedExisting,

      skippedMissingEmail,

      routingSummary

    });



  } catch(error){

    console.error(
      "GENERATE OUTREACH ERROR:",
      error
    );


    res.status(500).json({
      error:"Failed generating outreach"
    });

  }

});




// ======================================
// APPROVE
// ======================================

router.patch("/bulk/approve", async (req, res) => {
  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: "campaignId required" });
    const result = await Outreach.updateMany(
      { campaignId, status: "pending" },
      { $set: { status: "approved", errorMessage: "" } },
    );
    return res.json({
      approvedCount: result.modifiedCount || 0,
      message: `${result.modifiedCount || 0} pending draft${result.modifiedCount === 1 ? "" : "s"} approved`,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to approve pending drafts" });
  }
});

router.delete("/bulk/pending", requireRole("owner", "admin"), async (req, res) => {
  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: "campaignId required" });
    const result = await Outreach.deleteMany({ campaignId, status: "pending" });
    return res.json({
      deletedCount: result.deletedCount || 0,
      message: `${result.deletedCount || 0} pending draft${result.deletedCount === 1 ? "" : "s"} deleted`,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to delete pending drafts" });
  }
});

router.patch("/:id/approve", async(req,res)=>{

  try {

    const updated =
      await Outreach.findByIdAndUpdate(

        req.params.id,

        {
          status:"approved"
        },

        {
          new:true
        }

      );



    if(!updated){

      return res.status(404).json({
        error:"Outreach not found"
      });

    }


    res.json(updated);


  } catch(error){

    console.error(
      "APPROVE ERROR:",
      error
    );


    res.status(500).json({
      error:"Failed approving outreach"
    });

  }

});




// ======================================
// SEND APPROVED
// ======================================

router.post("/send", async(req,res)=>{

  try {

    const {
      outreachIds
    } = req.body;



    const items =
      await Outreach.find({

        _id:{
          $in: outreachIds
        },

        status:"approved"

      });



    let sentCount = 0;
    let failedCount = 0;
    const failures = [];



    for(const item of items){

      const contact = item.contactId
        ? await Contact.findById(item.contactId).select("status emailStatus emailBounced")
        : await Contact.findOne({ email: String(item.contactEmail || "").toLowerCase() }).select("status emailStatus emailBounced");
      if (
        contact &&
        (["invalid", "unsubscribed", "archived"].includes(contact.status) ||
          contact.emailBounced === true ||
          contact.emailStatus === "undeliverable")
      ) {
        item.status = "failed";
        item.deliveryStatus = "suppressed";
        item.failedAt = new Date();
        item.errorMessage = "Suppressed because this address previously bounced or cannot receive marketing email.";
        failedCount++;
        failures.push({ outreachId: item._id, email: item.contactEmail, message: item.errorMessage });
        await item.save();
        continue;
      }


      const result =
        await sendEmail(item);



      if(result.success){

        item.status="sent";

        item.sentAt =
          new Date();

        item.messageId =
          result.id || "";
        item.deliveryStatus = "accepted";


        sentCount++;

      } else {

        item.status="failed";
        item.deliveryStatus = "failed";
        item.failedAt = new Date();

        item.errorMessage =
          result.message;
        failedCount++;
        failures.push({
          outreachId: item._id,
          email: item.contactEmail,
          message: result.message,
        });

      }


      await item.save();

    }

    if (sentCount > 0 && items[0]?.campaignId) {
      await Campaign.updateOne(
        { _id: items[0].campaignId },
        { $inc: { "metrics.sent": sentCount } },
      );
    }



    res.json({

      success:true,

      sentCount,
      failedCount,
      failures

    });



  } catch(error){

    console.error(
      "SEND ERROR:",
      error
    );


    res.status(500).json({
      error:"Failed sending emails"
    });

  }

});




// ======================================
// UPDATE
// ======================================

router.post("/:id/replace-email", async (req, res) => {
  try {
    const newEmail = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: "Enter a complete email address." });
    }

    const original = await Outreach.findById(req.params.id);
    if (!original) return res.status(404).json({ error: "Outreach record not found." });
    if (!["bounced", "failed", "suppressed"].includes(original.deliveryStatus)) {
      return res.status(409).json({ error: "Only an undeliverable address can be replaced from this workflow." });
    }
    if (!original.contactId) {
      return res.status(409).json({ error: "This message is not linked to a contact record." });
    }
    if (newEmail === String(original.contactEmail || "").toLowerCase()) {
      return res.status(400).json({ error: "Enter a different email address." });
    }
    if (await EmailSuppression.exists({ email: newEmail })) {
      return res.status(409).json({ error: "That replacement address is suppressed because it previously bounced or generated a complaint." });
    }

    const duplicate = await Contact.findOne({
      _id: { $ne: original.contactId },
      email: newEmail,
    }).select("name email");
    if (duplicate) {
      return res.status(409).json({
        error: `That address already belongs to ${duplicate.name || duplicate.email}. No duplicate was created.`,
      });
    }

    const existingContact = await Contact.findById(original.contactId);
    if (!existingContact) return res.status(404).json({ error: "Contact record not found." });
    const alreadyVerified = existingContact.email === newEmail && existingContact.emailStatus === "verified";
    const directlyConfirmed = req.body?.confirmDirectSource === true;
    if (!alreadyVerified && !directlyConfirmed) {
      return res.status(400).json({
        error: "Confirm that this exact address came from an official company source or directly from the person. Guessed address patterns cannot be sent.",
      });
    }
    const contact = await Contact.findByIdAndUpdate(
      existingContact._id,
      {
        $set: {
          email: newEmail,
          status: "active",
          emailStatus: "verified",
          emailBounced: false,
          primaryEmailSource: alreadyVerified
            ? existingContact.primaryEmailSource
            : "manual_correction",
          primaryEmailVerificationSource: alreadyVerified
            ? existingContact.primaryEmailVerificationSource
            : "owner_confirmation",
          emailConfidence: alreadyVerified
            ? existingContact.emailConfidence
            : "directly_confirmed",
          primaryEmailLastVerifiedAt: alreadyVerified
            ? existingContact.primaryEmailLastVerifiedAt
            : new Date(),
        },
      },
      { new: true, runValidators: true },
    );

    let draft = await Outreach.findOne({
      campaignId: original.campaignId,
      contactId: original.contactId,
      contactEmail: newEmail,
      status: { $in: ["pending", "approved"] },
    });
    if (!draft) {
      draft = await Outreach.create({
        campaignId: original.campaignId,
        contactId: original.contactId,
        retryOf: original._id,
        organization: original.organization,
        contactName: original.contactName,
        contactEmail: newEmail,
        contactRole: original.contactRole,
        reason: `Replacement address for bounced message to ${original.contactEmail}.`,
        subject: original.subject,
        emailDraft: original.emailDraft,
        htmlBody: original.htmlBody,
        designJson: original.designJson || null,
        eventLink: original.eventLink,
        flyerUrl: original.flyerUrl,
        templateVersion: original.templateVersion,
        templateAudienceKey: original.templateAudienceKey,
        templateAudienceLabel: original.templateAudienceLabel,
        emailTopic: original.emailTopic,
        status: "pending",
        deliveryStatus: "",
      });
    }

    return res.json({
      contact,
      draft,
      original,
      message: "Email updated and a replacement draft was prepared for review. Nothing was sent.",
    });
  } catch (error) {
    console.error("REPLACE BOUNCED EMAIL ERROR:", error);
    return res.status(500).json({ error: "Unable to replace the email address." });
  }
});

router.patch("/:id", async(req,res)=>{

  try {


    const updated =
      await Outreach.findByIdAndUpdate(

        req.params.id,

        req.body,

        {
          new:true
        }

      );



    res.json(updated);


  } catch(error){


    console.error(
      "UPDATE ERROR:",
      error
    );


    res.status(500).json({
      error:"Failed updating outreach"
    });

  }

});



module.exports = router;
