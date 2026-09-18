const crypto = require("crypto");
const Contact = require("../models/Contact");
const CoachingApplication = require("../models/CoachingApplication");
const CoachingProgram = require("../models/CoachingProgram");
const SalesOpportunity = require("../models/SalesOpportunity");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const CommunicationConsent = require("../models/CommunicationConsent");
const CrmActivity = require("../models/CrmActivity");
const TrackedLink = require("../models/TrackedLink");
const referralService = require("./referralCommissionService");
const SocialIdentity = require("../models/SocialIdentity");
const applicationNotificationService = require("./applicationNotificationService");
const deps = {
  Contact,
  SocialIdentity,
  CoachingApplication,
  CoachingProgram,
  SalesOpportunity,
  WorkspaceConfig,
  WorkspaceMembership,
  CommunicationConsent,
  CrmActivity,
  TrackedLink,
  referralService,
  applicationNotificationService,
};
function clean(value, max) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function email(value) {
  const result = clean(value, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw new Error("A valid email is required");
  return result;
}
function phone(value) {
  return clean(value, 80).replace(/[^+\d(). -]/g, "");
}
function utm(value = {}) {
  return {
    source: clean(value.source || value.utm_source, 160),
    medium: clean(value.medium || value.utm_medium, 160),
    campaign: clean(value.campaign || value.utm_campaign, 240),
    content: clean(value.content || value.utm_content, 240),
    term: clean(value.term || value.utm_term, 240),
  };
}
function normalizeReferralInput(value) {
  const raw = clean(value, 1000);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const pathMatch = parsed.pathname.match(/\/ref\/([^/?#]+)/i);
    const candidate =
      pathMatch?.[1] ||
      parsed.searchParams.get("ref") ||
      parsed.searchParams.get("referral") ||
      "";
    return clean(decodeURIComponent(candidate), 80).toLowerCase();
  } catch {
    const pathMatch = raw.match(/(?:^|\/)ref\/([^/?#]+)/i);
    const candidate = pathMatch?.[1] || raw;
    try {
      return clean(decodeURIComponent(candidate), 80).toLowerCase();
    } catch {
      return clean(candidate, 80).toLowerCase();
    }
  }
}
function publicConfig(config) {
  const app = config?.publicApplication || {},
    labels = app.questionLabels || {},
    heading =
      !app.heading || app.heading === "Apply for coaching"
        ? "Apply to Join a Program"
        : app.heading,
    intro =
      !app.intro ||
      app.intro === "Tell us where you are and where you want to go."
        ? "Choose the program that fits your goals and tell us a little about where you are today."
        : app.intro;
  return {
    enabled: app.enabled !== false,
    heading: clean(heading, 240),
    intro: clean(intro, 1200),
    confirmationMessage: clean(
      app.confirmationMessage ||
        "Thank you. Your student application has been received. Our team will review it and follow up with next steps.",
      1000,
    ),
    logoUrl: clean(app.logoUrl, 1000),
    questionLabels: {
      investingExperience: clean(
        labels.investingExperience || "Investing experience",
        160,
      ),
      currentSituation: clean(
        labels.currentSituation || "Current situation",
        160,
      ),
      goals: clean(labels.goals || "Goals", 160),
      desiredStartTimeline: clean(
        labels.desiredStartTimeline || "Desired start timeline",
        160,
      ),
      message: clean(labels.message || "Anything else we should know?", 160),
    },
    timelineOptions: (app.timelineOptions || [])
      .map((value) => clean(value, 160))
      .filter(Boolean)
      .slice(0, 20),
    nextStepCta: {
      label: clean(app.nextStepCta?.label, 120),
      url: clean(app.nextStepCta?.url, 1000),
    },
    privacyUrl: clean(app.privacyUrl || "/privacy", 1000),
    termsUrl: clean(app.termsUrl || "/terms", 1000),
  };
}
async function validAssignee(workspaceId, userId, models) {
  if (!userId) return null;
  const row = await models.WorkspaceMembership.findOne({
    workspaceId,
    userId,
    status: "active",
  }).lean();
  const roles = new Set([...(row?.roles || []), row?.role].filter(Boolean));
  return roles.has("owner") || roles.has("admin") || roles.has("closer")
    ? userId
    : null;
}
async function resolveAttribution({ workspaceId, input }, models) {
  const token = clean(input.trackedLinkToken || input.go_link, 180);
  const tracked = token
    ? await models.TrackedLink.findOne({
        workspaceId,
        token,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }).lean()
    : null;
  return {
    attribution: {
      referralCode: normalizeReferralInput(
        input.referralCode || tracked?.referralCode,
      ),
      trackedLinkToken: tracked ? token : "",
      provider: clean(tracked?.provider, 80),
      campaignId: tracked?.campaignId || null,
      contentId: clean(tracked?.contentId, 255),
      utm: { ...utm(input.utm), ...(tracked?.utm || {}) },
    },
    tracked,
  };
}
async function resolveApplicationContact(
  { workspaceId, normalizedEmail, tracked },
  models,
) {
  const emailContact = await models.Contact.findOne({
    workspaceId,
    email: normalizedEmail,
  });
  const trackedContact = tracked?.contactId
    ? await models.Contact.findOne({ _id: tracked.contactId, workspaceId })
    : null;
  if (!trackedContact) return emailContact;
  if (!emailContact || String(emailContact._id) === String(trackedContact._id))
    return trackedContact;
  emailContact.sources = [
    ...new Set([
      ...(emailContact.sources || []),
      ...(trackedContact.sources || []),
    ]),
  ];
  emailContact.tags = [
    ...new Set([...(emailContact.tags || []), ...(trackedContact.tags || [])]),
  ];
  if (
    !emailContact.socialAttribution?.first?.provider &&
    trackedContact.socialAttribution?.first?.provider
  )
    emailContact.socialAttribution = trackedContact.socialAttribution;
  await emailContact.save();
  if (models.SocialIdentity?.updateMany)
    await models.SocialIdentity.updateMany(
      { workspaceId, contactId: trackedContact._id },
      { $set: { contactId: emailContact._id } },
    );
  if (models.TrackedLink?.updateMany)
    await models.TrackedLink.updateMany(
      { workspaceId, contactId: trackedContact._id },
      { $set: { contactId: emailContact._id } },
    );
  trackedContact.status = "archived";
  trackedContact.email = undefined;
  trackedContact.additionalFields = {
    ...(trackedContact.additionalFields || {}),
    mergedIntoContactId: String(emailContact._id),
    mergedAt: new Date(),
  };
  await trackedContact.save();
  return emailContact;
}
async function submit(
  { workspaceId, input, requestFingerprint = "" },
  models = deps,
) {
  if (input.privacyTermsAccepted !== true)
    throw new Error("Privacy and terms acknowledgement is required");
  const normalizedEmail = email(input.email),
    firstName = clean(input.firstName, 120),
    lastName = clean(input.lastName, 120);
  if (!firstName || !lastName)
    throw new Error("First and last name are required");
  const program = await models.CoachingProgram.findOne({
    _id: input.coachingProgramId,
    workspaceId,
    status: "active",
    "publicPresentation.status": "published",
  }).lean();
  if (!program) throw new Error("Select an available coaching program");
  const config = await models.WorkspaceConfig.findOne({
    workspaceId,
    key: "primary",
  }).lean();
  if (config?.publicApplication?.enabled === false)
    throw new Error("Applications are not currently open");
  const suppliedKey = clean(input.idempotencyKey, 160),
    idempotencyKey =
      suppliedKey ||
      crypto
        .createHash("sha256")
        .update(
          `${workspaceId}|${normalizedEmail}|${requestFingerprint}|${Date.now()}`,
        )
        .digest("hex");
  const existing = await models.CoachingApplication.findOne({
    workspaceId,
    idempotencyKey,
  }).lean();
  if (existing) return existing;
  const attributionResult = await resolveAttribution(
      { workspaceId, input },
      models,
    ),
    attribution = attributionResult.attribution;
  if (
    attribution.referralCode &&
    models.referralService?.resolvePromoterByCode
  ) {
    const promoter = await models.referralService.resolvePromoterByCode({
      workspaceId,
      referralCode: attribution.referralCode,
    });
    if (!promoter)
      throw new Error(
        "That referral code or link is not valid for this application. Check it and try again.",
      );
  }
  let contact = await resolveApplicationContact(
    { workspaceId, normalizedEmail, tracked: attributionResult.tracked },
    models,
  );
  if (!contact)
    contact = new models.Contact({
      workspaceId,
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      email: normalizedEmail,
      type: "lead",
      status: "active",
      sources: ["public_application"],
      tags: ["coaching-applicant"],
    });
  else {
    contact.firstName = firstName;
    contact.lastName = lastName;
    contact.name = `${firstName} ${lastName}`;
    contact.email = normalizedEmail;
    contact.sources = [
      ...new Set([...(contact.sources || []), "public_application"]),
    ];
    contact.tags = [
      ...new Set([...(contact.tags || []), "coaching-applicant"]),
    ];
  }
  const applicantPhone = phone(input.phone);
  if (applicantPhone) contact.phone = applicantPhone;
  contact.emailPreferences = contact.emailPreferences || {};
  if (input.marketingEmailConsent === true) {
    contact.emailPreferences.marketingStatus = "subscribed";
    contact.emailPreferences.consentSource = "public_application";
    contact.emailPreferences.consentAt = new Date();
  }
  contact.additionalFields = {
    ...(contact.additionalFields || {}),
    applicationCompletedAt: new Date(),
    applicationProgramId: String(program._id),
  };
  await contact.save();
  const configured =
    (config?.publicApplication?.programAssignments || []).find(
      (row) => String(row.coachingProgramId) === String(program._id),
    )?.userId || config?.publicApplication?.defaultAssigneeUserId;
  const assignedUserId = await validAssignee(workspaceId, configured, models);
  const application = await models.CoachingApplication.create({
    workspaceId,
    contactId: contact._id,
    coachingProgramId: program._id,
    assignedUserId,
    answers: {
      investingExperience: clean(input.investingExperience, 3000),
      currentSituation: clean(input.currentSituation, 3000),
      goals: clean(input.goals, 3000),
      desiredStartTimeline: clean(input.desiredStartTimeline, 500),
      message: clean(input.message, 5000),
    },
    consent: {
      sms: input.smsConsent === true,
      marketingEmail: input.marketingEmailConsent === true,
      privacyTerms: true,
      capturedAt: new Date(),
    },
    attribution,
    idempotencyKey,
  });
  let opportunity = await models.SalesOpportunity.findOne({
    workspaceId,
    primaryContactId: contact._id,
    stageKey: { $nin: ["won", "lost"] },
    $or: [{ coachingProgramId: program._id }, { coachingProgramId: null }],
  });
  if (!opportunity)
    opportunity = await models.SalesOpportunity.create({
      workspaceId,
      name: `${program.name} application — ${contact.name}`,
      stageKey: "new",
      primaryContactId: contact._id,
      campaignId: attribution.campaignId,
      ownerId: assignedUserId,
      applicationId: application._id,
      coachingProgramId: program._id,
      nextAction: "Review student application",
      notes: application.answers.message,
      leadLifecycle: { status: "application", statusAt: new Date() },
      leadAttribution: {
        source: "public_application",
        campaignId: attribution.campaignId,
        socialProvider: attribution.provider,
      },
    });
  else {
    opportunity.applicationId = application._id;
    opportunity.coachingProgramId ||= program._id;
    opportunity.campaignId ||= attribution.campaignId;
    opportunity.ownerId ||= assignedUserId;
    opportunity.nextAction = "Review student application";
    opportunity.leadLifecycle = {
      ...(opportunity.leadLifecycle?.toObject?.() ||
        opportunity.leadLifecycle ||
        {}),
      status: "application",
      statusAt: new Date(),
    };
    opportunity.leadAttribution = {
      ...(opportunity.leadAttribution?.toObject?.() ||
        opportunity.leadAttribution ||
        {}),
      source: opportunity.leadAttribution?.source || "public_application",
      campaignId:
        opportunity.leadAttribution?.campaignId || attribution.campaignId,
      socialProvider:
        opportunity.leadAttribution?.socialProvider || attribution.provider,
    };
    await opportunity.save();
  }
  application.salesOpportunityId = opportunity._id;
  await application.save();
  if (input.smsConsent === true && applicantPhone)
    await models.CommunicationConsent.findOneAndUpdate(
      { workspaceId, channel: "sms", address: applicantPhone, purpose: "all" },
      {
        $set: {
          contactId: contact._id,
          status: "opted_in",
          source: "web_form",
          proof: "Ellie Coaching application checkbox",
          consentedAt: new Date(),
          revokedAt: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  if (attribution.referralCode)
    try {
      await models.referralService.attributeReferral({
        workspaceId,
        contactId: contact._id,
        referralCode: attribution.referralCode,
        source: "public_application",
        state: "applied",
        applicationId: application._id,
      });
    } catch (error) {
      if (error.code !== "REFERRAL_CODE_INVALID") throw error;
    }
  await models.CrmActivity.create({
    workspaceId,
    contactId: contact._id,
    campaignId: attribution.campaignId,
    type: "system",
    title: "Coaching application completed",
    source: "integration",
    metadata: {
      eventType: "application.completed",
      applicationId: application._id,
      opportunityId: opportunity._id,
      coachingProgramId: program._id,
      assignedUserId,
      provider: attribution.provider,
      contentId: attribution.contentId,
      utm: attribution.utm,
    },
  });
  try {
    await models.applicationNotificationService.notify({
      workspaceId,
      application,
      contact,
      program,
      opportunity,
      config,
      attribution,
    });
  } catch (error) {
    console.error("Application notification creation failed", {
      applicationId: String(application._id),
      type: error?.name || "Error",
    });
  }
  return application;
}
module.exports = {
  normalizeReferralInput,
  publicConfig,
  resolveApplicationContact,
  resolveAttribution,
  submit,
  utm,
};
