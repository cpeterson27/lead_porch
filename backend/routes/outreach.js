const express = require("express");

const Outreach = require("../models/Outreach");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const EmailEvent = require("../models/EmailEvent");
const EmailSuppression = require("../models/EmailSuppression");

const { renderEmailContent, sendEmail, sendTestEmail } = require("../services/email");
const { requireRole } = require("../middleware/auth");
const { regenerateCampaignOutreach } = require("../services/outreachGenerationService");


const router = express.Router();


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
        // htmlBody is the full rendered email (~20-22KB each, ~90% of this
        // document's size) — the list view never displays it, and clicking
        // into a single email already re-fetches its rendered HTML fresh via
        // GET /:id/preview (see the `review()` handler in Outreach.jsx).
        // Dropping it here cuts a 300+ item load from several MB to a few
        // hundred KB, which matters a lot on the current free-tier database.
        .select("-htmlBody")
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

    const {
      outreach,
      createdCount,
      updatedCount,
      skippedExisting,
      skippedMissingEmail,
      routingSummary,
    } = await regenerateCampaignOutreach(campaign, {
      onlyMissing,
      actorUserId: req.auth.user._id,
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
    const { campaignId, outreachIds } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: "campaignId required" });
    if (outreachIds !== undefined && !Array.isArray(outreachIds)) {
      return res.status(400).json({ error: "outreachIds must be an array" });
    }
    const filter = {
      campaignId,
      status: { $in: ["pending", "failed"] },
      deliveryStatus: { $nin: ["bounced", "suppressed", "complained"] },
    };
    if (Array.isArray(outreachIds)) {
      if (!outreachIds.length) return res.status(400).json({ error: "Select at least one draft" });
      filter._id = { $in: outreachIds };
    }
    const result = await Outreach.updateMany(
      filter,
      { $set: { status: "approved", deliveryStatus: "", failedAt: null, errorMessage: "" } },
    );
    return res.json({
      approvedCount: result.modifiedCount || 0,
      message: `${result.modifiedCount || 0} draft${result.modifiedCount === 1 ? "" : "s"} prepared to send`,
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
      outreachIds,
      allowUnverified,
      deliveryPurpose = "marketing",
      prospectingAttested = false,
    } = req.body;

    if (!Array.isArray(outreachIds) || !outreachIds.length || outreachIds.length > 100) {
      return res.status(400).json({ error: "Select between 1 and 100 approved drafts." });
    }

    if (!["marketing", "business_prospecting"].includes(deliveryPurpose)) {
      return res.status(400).json({ error: "Choose a valid sending purpose." });
    }
    if (deliveryPurpose === "business_prospecting" && prospectingAttested !== true) {
      return res.status(400).json({ error: "Confirm the cold business-outreach safeguards before sending." });
    }



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



    const processItem = async (item) => {

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
        return;
      }


      const result =
        await sendEmail(item, {
          allowUnverified: allowUnverified === true,
          deliveryPurpose,
        });



      if(result.success){

        item.status="sent";

        item.sentAt =
          new Date();

        item.messageId =
          result.id || "";
        item.deliveryStatus = "accepted";
        item.deliveryPurpose = deliveryPurpose;
        item.prospectingAttestedAt = deliveryPurpose === "business_prospecting" ? new Date() : null;


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
    };

    // Provider calls must not run as one long serial chain. Five workers keep
    // a 25/50-recipient UI batch inside the HTTP request window while the
    // provider-level idempotency key makes a retry safe after a network timeout.
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await processItem(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));

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
