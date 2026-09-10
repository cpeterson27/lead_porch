const assert = require("node:assert/strict");
const fs = require("node:fs");
const service = require("./services/publicApplicationService");

const query = (value) => ({ lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

async function run() {
  const legacy = service.publicConfig({ publicApplication: { heading: "Apply for coaching", intro: "Tell us where you are and where you want to go." } });
  assert.equal(legacy.heading, "Apply to Join a Program");
  assert.match(legacy.intro, /Choose the program/);

  let savedContact, createdApplication, createdOpportunity, activities = 0;
  class Contact {
    constructor(values) { Object.assign(this, values, { _id: "contact-1" }); }
    async save() { savedContact = this; return this; }
    static async findOne() { return null; }
  }
  const program = { _id: "program-1", name: "Student Program" };
  const application = { _id: "application-1", async save() { return this; } };
  const models = {
    Contact,
    SocialIdentity: { updateMany: async () => { throw new Error("unexpected identity merge"); } },
    CoachingProgram: { findOne: () => query(program) },
    WorkspaceConfig: { findOne: () => query({ publicApplication: { enabled: true } }) },
    WorkspaceMembership: { findOne: () => query(null) },
    CoachingApplication: { findOne: () => query(null), create: async (values) => { createdApplication = values; Object.assign(application, values); return application; } },
    SalesOpportunity: { findOne: () => query(null), create: async (values) => { createdOpportunity = { _id: "opportunity-1", ...values }; return createdOpportunity; } },
    CommunicationConsent: { findOneAndUpdate: async () => { throw new Error("SMS consent was not selected"); } },
    CrmActivity: { create: async () => { activities += 1; } },
    TrackedLink: { findOne: () => query(null) },
    referralService: { attributeReferral: async () => { throw new Error("No referral was submitted"); } },
    applicationNotificationService: { notify: async () => ({}) },
    Enrollment: { create: async () => { throw new Error("Public application must not enroll a student"); } },
    CoachAssignment: { create: async () => { throw new Error("Public application must not assign a coach"); } },
  };
  const result = await service.submit({ workspaceId: "workspace-1", input: { firstName: "Prospective", lastName: "Student", email: "student@example.test", coachingProgramId: "program-1", privacyTermsAccepted: true, idempotencyKey: "student-application-1" } }, models);
  assert.equal(result._id, "application-1"); assert.equal(savedContact.email, "student@example.test");
  assert(savedContact.sources.includes("public_application")); assert.equal(createdApplication.contactId, "contact-1");
  assert.equal(createdOpportunity.applicationId, "application-1"); assert.equal(createdOpportunity.primaryContactId, "contact-1"); assert.equal(activities, 1);

  const publicRoute = fs.readFileSync("./routes/publicSite.js", "utf8");
  const managementRoute = fs.readFileSync("./routes/publicManagement.js", "utf8");
  assert(publicRoute.includes("applicationService.publicConfig(config)"));
  assert(managementRoute.includes("applicationService.publicConfig(config)") && managementRoute.includes("$set: { publicApplication: values }"));
  for (const source of [fs.readFileSync("./services/publicApplicationService.js", "utf8"), publicRoute]) {
    assert(!source.includes('require("../models/Enrollment")')); assert(!source.includes("CoachAssignment.create"));
  }
  console.log("One public student application config, canonical Contact/Application/Opportunity creation, and no automatic enrollment or coach assignment passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
