const Contact = require("../models/Contact");
const CrmActivity = require("../models/CrmActivity");

// Checklist section 8: lead-magnet delivery didn't exist at all — no
// capture page, no delivery mechanism. This is the real, working half:
// capture the opt-in, create/update the Contact the same way every other
// lead source in this app already does (see meetupService's RSVP sync for
// the same findOneAndUpdate-by-email pattern), and fire the trigger event
// for the Automations engine to send the actual delivery email. The
// delivery email's content/link is deliberately left as placeholder copy
// in the automation template — there's no real guide/PDF to link yet.
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }

async function optIn({ workspaceId, email, firstName }, models = { Contact, CrmActivity }) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw Object.assign(new Error("A valid email address is required"), { code: "LEAD_MAGNET_EMAIL_INVALID" });
  const cleanFirstName = String(firstName || "").trim().slice(0, 80);
  const contact = await models.Contact.findOneAndUpdate(
    { workspaceId, email: normalizedEmail },
    {
      $setOnInsert: { workspaceId, email: normalizedEmail, name: cleanFirstName || normalizedEmail, firstName: cleanFirstName, sourceProvider: "lead_magnet" },
      $addToSet: { sources: "lead_magnet", tags: "lead-magnet-optin" },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  await models.CrmActivity.create({ workspaceId, contactId: contact._id, type: "system", title: "Lead magnet requested", source: "crm", metadata: { eventType: "lead_magnet.requested" } });
  return { contactId: contact._id };
}

module.exports = { optIn };
