const express = require("express");
const Contact = require("../models/Contact");
const { verifyUnsubscribeToken } = require("../utils/unsubscribe");
const router = express.Router();

const escape = (value) => String(value || "").replace(/[<>&"]/g, "");

async function preferences(req, res, oneClick = false) {
  try {
    const token = req.params.token || req.query.token;
    const payload = verifyUnsubscribeToken(token);
    const contact = await Contact.findOne({ _id: payload.contactId, email: payload.email });
    if (!contact) return res.status(404).send("This contact could not be found.");
    const isPreferenceForm = req.body?.action === "save_preferences";
    if (oneClick && !isPreferenceForm) {
      contact.status = "unsubscribed";
      contact.emailPreferences.marketingStatus = "unsubscribed";
      contact.emailPreferences.unsubscribedAt = new Date();
      contact.emailPreferences.unsubscribeSource = "email_one_click";
      contact.emailPreferences.topics = { eventInvitations: false, programOffers: false, educationalNewsletter: false };
      await contact.save();
      return res.status(200).end();
    }
    if (isPreferenceForm) {
      const topics = {
        eventInvitations: req.body.eventInvitations === "on",
        programOffers: req.body.programOffers === "on",
        educationalNewsletter: req.body.educationalNewsletter === "on",
      };
      const any = Object.values(topics).some(Boolean);
      contact.status = any ? "active" : "unsubscribed";
      contact.emailPreferences.marketingStatus = any ? "subscribed" : "unsubscribed";
      contact.emailPreferences.topics = topics;
      contact.emailPreferences.unsubscribedAt = any ? null : new Date();
      contact.emailPreferences.unsubscribeSource = any ? "" : "preference_center";
      await contact.save();
    }
    const topics = contact.emailPreferences?.topics || {};
    const checked = (value) => value ? " checked" : "";
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Email preferences</title></head><body style="margin:0;background:#f5f2eb;color:#17231f;font-family:Arial,sans-serif"><main style="max-width:620px;margin:8vh auto;background:white;border:1px solid #ded7ca;padding:48px"><p style="color:#997735;letter-spacing:.14em;text-transform:uppercase;font-size:12px">Ellie's Coaching</p><h1 style="font-family:Georgia,serif;font-weight:500">Choose what you receive</h1><p style="color:#68736f;line-height:1.7">Update marketing preferences for <strong>${escape(payload.email)}</strong>.</p>${isPreferenceForm ? "<p style=\"background:#edf7f2;padding:12px\">Your preferences were saved.</p>" : ""}<form method="post"><input type="hidden" name="action" value="save_preferences"><label style="display:block;padding:12px 0"><input type="checkbox" name="eventInvitations"${checked(topics.eventInvitations)}> Event invitations</label><label style="display:block;padding:12px 0"><input type="checkbox" name="programOffers"${checked(topics.programOffers)}> Program offers</label><label style="display:block;padding:12px 0"><input type="checkbox" name="educationalNewsletter"${checked(topics.educationalNewsletter)}> Educational newsletter</label><p style="color:#68736f;font-size:13px">Leave every option unchecked to unsubscribe from all marketing.</p><button style="background:#173f36;border:0;color:white;padding:13px 20px;font-weight:bold" type="submit">Save preferences</button></form></main></body></html>`);
  } catch (_error) {
    res.status(400).send("This unsubscribe link is invalid or incomplete.");
  }
}

router.get("/test-preview", (_req, res) => res.type("html").send("<!doctype html><title>Test email</title><main style='max-width:620px;margin:8vh auto;font:16px Arial,sans-serif;line-height:1.6'><h1>Test email only</h1><p>No contact was unsubscribed. Production campaign emails use each recipient’s own preference link.</p></main>"));
router.post("/test-preview", (_req, res) => res.status(200).end());
router.get("/:token", (req, res) => preferences(req, res, false));
router.post("/:token", (req, res) => preferences(req, res, true));

module.exports = router;
