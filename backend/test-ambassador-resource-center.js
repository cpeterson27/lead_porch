// Regression coverage for the Ambassador Resource Center: upload/version/
// replace/archive, the visibility matrix (internal/all-ambassadors/named/
// students/public, any combination), Jarvis-approval as a separate
// permission from ambassador visibility, malware/type/size validation, and
// the download-access audit trail. Cloudinary calls are mocked — no real
// network call is made in this file. The real Cloudinary "authenticated
// upload" + "private download" flow has not been exercised against a live
// account; see the module header in services/ambassadorResourceService.js.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const resourceService = require("./services/ambassadorResourceService");
const AmbassadorResourceFile = require("./models/AmbassadorResourceFile");
const AmbassadorResourceAccess = require("./models/AmbassadorResourceAccess");
const AmbassadorProfile = require("./models/AmbassadorProfile");
const Contact = require("./models/Contact");
const Enrollment = require("./models/Enrollment");
const CoachingProgram = require("./models/CoachingProgram");
const User = require("./models/User");

const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const originalApiKey = process.env.CLOUDINARY_API_KEY;
const originalApiSecret = process.env.CLOUDINARY_API_SECRET;

const TINY_PDF = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n%mock pdf content for tests\n").toString("base64");
const FAKE_EXECUTABLE = "data:application/pdf;base64," + Buffer.from("MZ\x90\x00fake exe disguised as pdf").toString("base64");
const MISMATCHED_TYPE = "data:image/png;base64," + Buffer.from("not actually a png").toString("base64");

function mockHttp(overrides = {}) {
  return {
    post: overrides.post || (async () => ({ data: { public_id: "ambassador-resources/mock-id", format: "pdf", bytes: 1234 } })),
    get: overrides.get || (async () => ({ data: Buffer.from("mock file bytes") })),
  };
}

async function run() {
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const adminUserId = new mongoose.Types.ObjectId();
  const ambassadorUser = await User.create({ name: "Ambassador One", email: `amb-res-${Date.now()}@example.test`, passwordHash: "x" });
  const namedAmbassadorUser = await User.create({ name: "Named Ambassador", email: `amb-res-named-${Date.now()}@example.test`, passwordHash: "x" });
  const studentUser = await User.create({ name: "Enrolled Student", email: `student-res-${Date.now()}@example.test`, passwordHash: "x" });
  const outsiderUser = await User.create({ name: "Outsider", email: `outsider-res-${Date.now()}@example.test`, passwordHash: "x" });

  try {
    await runWithWorkspace(workspaceId, async () => {
      const ambassadorProfile = await AmbassadorProfile.create({ workspaceId, userId: ambassadorUser._id, displayName: "Ambassador One", status: "active", referralCode: `res-a-${Date.now()}`, referralSlug: `res-a-${Date.now()}-slug` });
      const namedProfile = await AmbassadorProfile.create({ workspaceId, userId: namedAmbassadorUser._id, displayName: "Named Ambassador", status: "active", referralCode: `res-b-${Date.now()}`, referralSlug: `res-b-${Date.now()}-slug` });
      const program = await CoachingProgram.create({ workspaceId, name: "Test Program", status: "active" });
      const studentContact = await Contact.create({ name: "Enrolled Student", email: studentUser.email, sources: ["manual"], status: "active" });
      await Enrollment.create({ workspaceId, contactId: studentContact._id, coachingProgramId: program._id, status: "active", startsAt: new Date(), programVersion: 1, programSnapshot: { name: program.name } });

      // Type/size/malware validation.
      await assert.rejects(() => resourceService.create({ workspaceId, userId: adminUserId, title: "Bad", category: "training", fileDataUri: FAKE_EXECUTABLE }, undefined, mockHttp()), (error) => error.code === "RESOURCE_FILE_UNSAFE");
      await assert.rejects(() => resourceService.create({ workspaceId, userId: adminUserId, title: "Bad", category: "training", fileDataUri: MISMATCHED_TYPE }, undefined, mockHttp()), (error) => error.code === "RESOURCE_FILE_TYPE_MISMATCH");
      await assert.rejects(() => resourceService.create({ workspaceId, userId: adminUserId, title: "Bad", category: "not_a_real_category", fileDataUri: TINY_PDF }, undefined, mockHttp()), (error) => error.code === "RESOURCE_CATEGORY_INVALID");

      // Create v1, visible only to named ambassador + students (not to the general ambassador, not public).
      let uploadedFolder;
      const http = mockHttp({ post: async (url, body) => { uploadedFolder = true; return { data: { public_id: "ambassador-resources/doc-1", format: "pdf", bytes: 999 } }; } });
      const resource = await resourceService.create({
        workspaceId, userId: adminUserId, title: "Program Outline", category: "program_outlines", kind: "guide",
        coachingProgramIds: [program._id],
        visibility: { internalOnly: false, allAmbassadors: false, namedAmbassadorIds: [namedProfile._id], studentsOrProgramMembers: true, public: false },
        requiresAcknowledgment: false, fileDataUri: TINY_PDF, fileName: "outline.pdf",
      }, undefined, http);
      assert.ok(uploadedFolder);
      assert.equal(resource.currentVersion, 1);
      assert.equal(resource.versions[0].cloudinaryPublicId, "ambassador-resources/doc-1");
      assert.equal(resource.jarvisApproved, false, "Jarvis approval must default off and be independent of visibility");

      // Visibility matrix: general ambassador (not named) cannot see it; named ambassador and enrolled student can.
      const generalView = await resourceService.listForViewer({ workspaceId, userId: ambassadorUser._id, ambassadorProfileId: ambassadorProfile._id });
      assert.equal(generalView.length, 0, "a non-named ambassador must not see a named-only resource");
      const namedView = await resourceService.listForViewer({ workspaceId, userId: namedAmbassadorUser._id, ambassadorProfileId: namedProfile._id });
      assert.equal(namedView.length, 1);
      const studentView = await resourceService.listForViewer({ workspaceId, userId: studentUser._id, ambassadorProfileId: null });
      assert.equal(studentView.length, 1, "an enrolled student must see a resource visible to students/program members");
      const outsiderView = await resourceService.listForViewer({ workspaceId, userId: outsiderUser._id, ambassadorProfileId: null });
      assert.equal(outsiderView.length, 0);

      // Jarvis approval is a separate switch — approving it must not change ambassador visibility.
      const approved = await resourceService.setJarvisApproval({ workspaceId, resourceId: resource._id, approved: true });
      assert.equal(approved.jarvisApproved, true);
      const stillNotVisibleToGeneral = await resourceService.listForViewer({ workspaceId, userId: ambassadorUser._id, ambassadorProfileId: ambassadorProfile._id });
      assert.equal(stillNotVisibleToGeneral.length, 0, "Jarvis-approving a resource must not change who can see it");

      // Access is denied and audited correctly for someone without visibility.
      await assert.rejects(
        () => resourceService.recordAccessAndGetDownload({ workspaceId, resourceId: resource._id, userId: outsiderUser._id, ambassadorProfileId: null }, undefined, mockHttp()),
        (error) => error.code === "RESOURCE_ACCESS_DENIED",
      );

      // A permitted viewer downloads it — the service fetches the bytes
      // directly (never a stored/permanent Cloudinary URL, and nothing the
      // client could reuse later), and the access is logged with actor + version.
      const fileBytes = Buffer.from("mock pdf bytes");
      const download = await resourceService.recordAccessAndGetDownload({ workspaceId, resourceId: resource._id, userId: namedAmbassadorUser._id, ambassadorProfileId: namedProfile._id }, undefined, mockHttp({ get: async () => ({ data: fileBytes }) }));
      assert.deepEqual(download.buffer, fileBytes);
      assert.equal(download.fileName, "outline.pdf");
      const accessLog = await AmbassadorResourceAccess.findOne({ workspaceId, resourceFileId: resource._id, userId: namedAmbassadorUser._id, action: "download" }).lean();
      assert.ok(accessLog);
      assert.equal(accessLog.version, 1);

      // Version, replace, and archive.
      const versioned = await resourceService.addVersion({ workspaceId, resourceId: resource._id, userId: adminUserId, fileDataUri: TINY_PDF, fileName: "outline-v2.pdf", changeNotes: "Fixed a typo" }, undefined, mockHttp({ post: async () => ({ data: { public_id: "ambassador-resources/doc-1-v2", format: "pdf", bytes: 1001 } }) }));
      assert.equal(versioned.currentVersion, 2);
      assert.equal(versioned.versions.length, 2);
      assert.equal(versioned.versions[0].cloudinaryPublicId, "ambassador-resources/doc-1", "the prior version must be preserved, not overwritten");

      // A binding agreement requiring acknowledgment.
      const agreement = await resourceService.create({ workspaceId, userId: adminUserId, title: "Ambassador Agreement", category: "policies_and_agreements", kind: "binding_agreement", visibility: { internalOnly: false, allAmbassadors: true }, requiresAcknowledgment: true, fileDataUri: TINY_PDF }, undefined, mockHttp());
      await assert.rejects(() => resourceService.acknowledge({ workspaceId, resourceId: resource._id, userId: ambassadorUser._id }), (error) => error.code === "RESOURCE_ACK_NOT_REQUIRED");
      const ack = await resourceService.acknowledge({ workspaceId, resourceId: agreement._id, userId: ambassadorUser._id });
      assert.equal(ack.acknowledged, true);
      const history = await resourceService.accessHistory({ workspaceId, resourceId: agreement._id });
      assert.equal(history[0].action, "acknowledged");

      const archived = await resourceService.archive({ workspaceId, resourceId: resource._id, userId: adminUserId });
      assert.equal(archived.status, "archived");
      const afterArchive = await resourceService.listForAdmin({ workspaceId });
      assert.equal(afterArchive.find((row) => String(row._id) === String(resource._id)), undefined, "an archived resource must not appear in the default admin list");
      await assert.rejects(
        () => resourceService.recordAccessAndGetDownload({ workspaceId, resourceId: resource._id, userId: namedAmbassadorUser._id, ambassadorProfileId: namedProfile._id }, undefined, mockHttp()),
        (error) => error.code === "RESOURCE_NOT_FOUND",
        "an archived resource must no longer be downloadable",
      );

      console.log("Ambassador Resource Center: file safety validation, versioning, the full visibility matrix, Jarvis-approval independence, access-denial, download audit trail, acknowledgment, and archive all passed.");
    });
  } finally {
    await AmbassadorResourceFile.deleteMany({ workspaceId });
    await AmbassadorResourceAccess.deleteMany({ workspaceId });
    await AmbassadorProfile.deleteMany({ workspaceId });
    await CoachingProgram.deleteMany({ workspaceId });
    await Contact.deleteMany({ workspaceId });
    await Enrollment.deleteMany({ workspaceId });
    await User.deleteMany({ _id: { $in: [ambassadorUser._id, namedAmbassadorUser._id, studentUser._id, outsiderUser._id] } });
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME; else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
    if (originalApiKey === undefined) delete process.env.CLOUDINARY_API_KEY; else process.env.CLOUDINARY_API_KEY = originalApiKey;
    if (originalApiSecret === undefined) delete process.env.CLOUDINARY_API_SECRET; else process.env.CLOUDINARY_API_SECRET = originalApiSecret;
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
