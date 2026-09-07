/**
 * Contact Service
 *
 * Handles contacts from:
 * - Monday CRM
 * - Growth Operator research and imports
 * - Eventbrite
 * - Future integrations
 *
 * Architecture:
 * ONE PERSON = ONE CONTACT RECORD
 */


const Contact = require("../models/Contact");
const MarketingCampaign = require("../models/MarketingCampaign");
const CrmActivity = require("../models/CrmActivity");
const { applyResearchClassification } = require("./contactResearchService");

const integrationContactFields = ["phone", "title", "industry", "city", "state", "country", "linkedin", "website", "stage", "notes"];


// =====================================
// CLEAN CONTACT NAME
// =====================================

function cleanName(name = "") {

  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

}





class ContactService {



  /**
   * Create or update contact
   *
   * Duplicate rule:
   * email only
   */
  async upsertContact(contactData) {


    const {
      email,
      source,
      externalId,
    } = contactData;



    if (!email || !source) {

      throw new Error(
        "Email and source are required"
      );

    }



    const normalizedEmail =
      email.toLowerCase().trim();



    let contact =
      await Contact.findOne({
        email: normalizedEmail,
      });





    // =====================================
    // UPDATE EXISTING CONTACT
    // =====================================

    if (contact) {


      if (contactData.name) {

        contact.name =
          cleanName(contactData.name);

      }



      if (contactData.firstName) {

        contact.firstName =
          cleanName(contactData.firstName);

      }



      if (contactData.lastName) {

        contact.lastName =
          cleanName(contactData.lastName);

      }



      if (contactData.company) {

        contact.company =
          contactData.company.trim();

      }

      for (const field of integrationContactFields) {
        if (contactData[field] !== undefined && contactData[field] !== "") contact[field] = contactData[field];
      }





      contact.sources =
        [
          ...new Set([
            ...(contact.sources || []),
            source,
          ])
        ];





      if (externalId) {

        contact.externalIds = {

          ...(contact.externalIds || {}),

          [source]:
            externalId,

        };

      }





      if (contactData.type) {

        contact.type =
          contactData.type;

      }





      if (contactData.tags?.length) {

        contact.tags =
          [
            ...new Set([
              ...(contact.tags || []),
              ...contactData.tags,
            ])
          ];

      }





      if (contactData.status) {

        contact.status =
          contactData.status;

      }

      let participationChanged = false;
      if (contactData.eventParticipation?.attendeeId) {
        const participation = contactData.eventParticipation;
        const existingIndex = (contact.eventParticipations || []).findIndex((item) => item.provider === participation.provider && item.attendeeId === participation.attendeeId);
        participationChanged = existingIndex < 0 || contact.eventParticipations[existingIndex].status !== participation.status;
        if (existingIndex >= 0) contact.eventParticipations[existingIndex] = participation;
        else contact.eventParticipations.push(participation);
      }





      await contact.save();

      if (participationChanged) await CrmActivity.create({ contactId: contact._id, type: "system", title: contactData.eventParticipation.status === "attended" ? "Event attended" : "Event registered", source: "integration", metadata: { eventType: contactData.eventParticipation.status === "attended" ? "event.attended" : "event.registered", provider: "eventbrite", eventId: contactData.eventParticipation.eventId, attendeeId: contactData.eventParticipation.attendeeId } });


      return contact;

    }








    // =====================================
    // CREATE NEW CONTACT
    // =====================================

    contact =
      await Contact.create({

        name:
          cleanName(
            contactData.name || "Unknown"
          ),


        firstName:
          cleanName(
            contactData.firstName || ""
          ),


        lastName:
          cleanName(
            contactData.lastName || ""
          ),


        email:
          normalizedEmail,


        company:
          contactData.company?.trim() || "",


        organizationId:
          contactData.organizationId || null,


        sources:
          [
            source
          ],


        externalIds:
          externalId
          ? {
              [source]:
                externalId,
            }
          : {},


        type:
          contactData.type || "lead",


        tags:
          contactData.tags?.length
          ? contactData.tags
          : [source],


        status:
          contactData.status || "active",

        eventParticipations: contactData.eventParticipation ? [contactData.eventParticipation] : [],

        ...Object.fromEntries(integrationContactFields
          .filter((field) => contactData[field] !== undefined && contactData[field] !== "")
          .map((field) => [field, contactData[field]])),

      });



    if (contactData.eventParticipation?.attendeeId) await CrmActivity.create({ contactId: contact._id, type: "system", title: contactData.eventParticipation.status === "attended" ? "Event attended" : "Event registered", source: "integration", metadata: { eventType: contactData.eventParticipation.status === "attended" ? "event.attended" : "event.registered", provider: "eventbrite", eventId: contactData.eventParticipation.eventId, attendeeId: contactData.eventParticipation.attendeeId } });

    return contact;


  }








  /**
   * Get campaign recipients
   */
  async getCampaignRecipients(
    campaignId,
    filters = {}
  ) {


    const campaign =
      await MarketingCampaign.findById(
        campaignId
      );



    if (!campaign) {

      throw new Error(
        "Campaign not found"
      );

    }




    const query = {

      status: "active",

      type: "lead",

    };





    if (filters.source) {

      query.sources = {

        $in:[
          filters.source
        ]

      };

    }





    if (filters.tags?.length) {

      query.tags = {

        $in:
          filters.tags

      };

    }





    return Contact.find(query)

      .limit(
        filters.limit || 500
      )

      .select(
        "email name firstName company sources"
      );


  }










  /**
   * Get contacts
   */
  async getContacts(filters = {}) {


    const query = {};



    if (filters.email) {

      query.email =
        filters.email.toLowerCase();

    }



    if (filters.source) {

      query.sources = {

        $in:[
          filters.source
        ]

      };

    }



    if (filters.status) {

      query.status =
        filters.status;

    }



    if (filters.type) {

      query.type =
        filters.type;

    }



    if (filters.tags?.length) {

      query.tags = {

        $in:
          filters.tags

      };

    }



    return Contact.find(query);

  }










  async getContact(id) {


    const contact =
      await Contact.findById(id);



    if (!contact) {

      throw new Error(
        "Contact not found"
      );

    }



    return contact;

  }










  async updateContact(id, updates) {

    if (updates.employeeCount !== undefined) {
      const rawEmployeeCount = String(updates.employeeCount ?? "").trim();
      if (!rawEmployeeCount) updates.employeeCount = null;
      else {
        const values = rawEmployeeCount.match(/\d[\d,]*/g)?.map((value) => Number(value.replaceAll(",", ""))).filter(Number.isFinite) || [];
        if (!values.length) throw new Error("Company size must be a number or a range such as 1–10.");
        updates.employeeCount = Math.max(...values);
      }
    }


    const contact =
      await Contact.findById(id);



    if (!contact) {

      throw new Error(
        "Contact not found"
      );

    }





    if (updates.firstName !== undefined || updates.lastName !== undefined) {
      const firstName = cleanName(
        updates.firstName !== undefined ? updates.firstName : contact.firstName
      );
      const lastName = cleanName(
        updates.lastName !== undefined ? updates.lastName : contact.lastName
      );
      const fullName = [firstName, lastName].filter(Boolean).join(" ");
      if (!fullName) {
        throw new Error("A first or last name is required");
      }
      updates.firstName = firstName;
      updates.lastName = lastName;
      updates.name = fullName;
    } else if (updates.name) {

      updates.name =
        cleanName(updates.name);

    }

    const confirmEmailManually = updates.confirmEmailManually === true;
    delete updates.confirmEmailManually;
    const currentEmail = String(contact.email || "").trim().toLowerCase();
    const nextEmail = updates.email === undefined
      ? currentEmail
      : String(updates.email || "").trim().toLowerCase();

    if (updates.email !== undefined) updates.email = nextEmail;
    if (nextEmail !== currentEmail) {
      updates.emailStatus = "";
      updates.primaryEmailVerificationSource = "";
      updates.emailConfidence = "";
      updates.primaryEmailLastVerifiedAt = null;
    }

    if (confirmEmailManually) {
      if (!nextEmail) throw new Error("Add an email address before confirming it");
      updates.emailStatus = "verified";
      updates.primaryEmailVerificationSource = "owner_confirmation";
      updates.emailConfidence = "personally_confirmed";
      updates.primaryEmailLastVerifiedAt = new Date();
    }





    const requestedLifecycleStage = updates.stage !== undefined
      ? String(updates.stage || "").trim()
      : null;

    Object.assign(
      contact,
      updates
    );

    applyResearchClassification(contact);
    // Research readiness and CRM lifecycle are related but not identical.
    // A deliberate user move in the pipeline must remain authoritative.
    if (requestedLifecycleStage !== null) contact.stage = requestedLifecycleStage;
    await contact.save();



    return contact;

  }










  async deleteContact(id) {
    // Conversation history and activity log entries only exist because of
    // this contact, so they're removed with it. SocialIdentity rows are
    // different: they're detached (contactId cleared), not deleted. Fully
    // deleting them would silently forget any "same person" link a human
    // recorded via merge, and a fresh message from that provider identity
    // would then fragment into a new, unlinked contact all over again.
    const SocialIdentity = require("../models/SocialIdentity");
    const ConversationThread = require("../models/ConversationThread");
    const ConversationMessage = require("../models/ConversationMessage");
    const threads = await ConversationThread.find({ contactIds: id }).select("_id").lean();
    const threadIds = threads.map((thread) => thread._id);
    if (threadIds.length) {
      await ConversationMessage.deleteMany({ threadId: { $in: threadIds } });
      await ConversationThread.deleteMany({ _id: { $in: threadIds } });
    }
    await ConversationMessage.deleteMany({ contactId: id });
    await SocialIdentity.updateMany({ contactId: id }, { $set: { contactId: null } });
    await CrmActivity.deleteMany({ contactId: id });

    const result =
      await Contact.findByIdAndDelete(id);

    if (!result) {

      throw new Error(
        "Contact not found"
      );

    }


  }

  /**
   * Merge two contacts into one.
   *
   * Instagram and Facebook Messenger assign the same real person completely
   * unrelated ids (an Instagram-scoped id vs. a Page-scoped id) with no
   * shared identifier between them, so the same person messaging through
   * both channels can create two separate contacts. There is no reliable
   * automatic signal to detect this — it takes a human recognizing it's the
   * same person, so this merge is an explicit, user-initiated action.
   */
  async mergeContacts(keepId, mergeId) {
    if (String(keepId) === String(mergeId))
      throw new Error("Choose two different contacts to merge");
    const keep = await Contact.findById(keepId);
    const merge = await Contact.findById(mergeId);
    if (!keep || !merge) throw new Error("Contact not found");

    const SocialIdentity = require("../models/SocialIdentity");
    const ConversationThread = require("../models/ConversationThread");
    const ConversationMessage = require("../models/ConversationMessage");
    const { identityKey } = require("./socialLeadAutomationService");

    // Record the link on the identity rows themselves, independent of which
    // Contact currently owns them — so if either contact is later deleted
    // (e.g. to start a test over), a fresh message from either provider
    // identity still finds its way back to one shared contact instead of
    // fragmenting into two again.
    const keepIdentities = await SocialIdentity.find({ contactId: keep._id });
    const mergeIdentities = await SocialIdentity.find({ contactId: merge._id });
    const keepKeys = keepIdentities.map((row) => identityKey(row));
    const mergeKeys = mergeIdentities.map((row) => identityKey(row));
    if (keepKeys.length && mergeKeys.length) {
      await SocialIdentity.updateMany(
        { _id: { $in: mergeIdentities.map((row) => row._id) } },
        { $addToSet: { linkedIdentityKeys: { $each: keepKeys } } },
      );
      await SocialIdentity.updateMany(
        { _id: { $in: keepIdentities.map((row) => row._id) } },
        { $addToSet: { linkedIdentityKeys: { $each: mergeKeys } } },
      );
    }

    await SocialIdentity.updateMany({ contactId: merge._id }, { $set: { contactId: keep._id } });
    await ConversationMessage.updateMany({ contactId: merge._id }, { $set: { contactId: keep._id } });
    await ConversationThread.updateMany({ contactIds: merge._id }, { $addToSet: { contactIds: keep._id } });
    await ConversationThread.updateMany({ contactIds: merge._id }, { $pull: { contactIds: merge._id } });
    await CrmActivity.updateMany({ contactId: merge._id }, { $set: { contactId: keep._id } });

    keep.sources = [...new Set([...(keep.sources || []), ...(merge.sources || [])])];
    if (merge.notes && !String(keep.notes || "").includes(merge.notes)) {
      keep.notes = [keep.notes, merge.notes].filter(Boolean).join("\n");
    }
    await keep.save();
    await Contact.findByIdAndDelete(merge._id);
    return keep;
  }









  /**
   * Sync contacts from integrations
   */
  async syncContactsFromSource(
    source,
    externalContacts
  ) {


    let created = 0;

    let updated = 0;





    for (const externalContact of externalContacts) {


      try {


        if (!externalContact.email) {

          continue;

        }





        const existing =
          await Contact.findOne({

            email:
              externalContact.email
                .toLowerCase()
                .trim(),

          });





        await this.upsertContact({

          name:
            cleanName(
              externalContact.name || ""
            ),


          firstName:
            cleanName(
              externalContact.firstName || ""
            ),


          lastName:
            cleanName(
              externalContact.lastName || ""
            ),


          email:
            externalContact.email,


          company:
            externalContact.company || "",

          ...Object.fromEntries(integrationContactFields
            .filter((field) => externalContact[field] !== undefined && externalContact[field] !== "")
            .map((field) => [field, externalContact[field]])),


          source,


          externalId:
            externalContact.externalId,


          type:
            externalContact.type || "lead",


          tags:
            externalContact.tags || [source],


          status:
            "active",

        });





        if (existing) {

          updated++;

        } else {

          created++;

        }




      } catch(error) {


        console.error(
          "CONTACT SYNC ERROR:",
          error.message
        );


      }


    }





    return {

      created,

      updated,

      duplicates: 0,

    };


  }










  async getStats() {


    return {

      total:
        await Contact.countDocuments(),

    };

  }


}





module.exports =
  new ContactService();
