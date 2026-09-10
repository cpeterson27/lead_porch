// Regression coverage for the media-variant routes: generating and replacing platform variants
// must persist only the derived variant entries, never touch the original media url/publicId,
// and stay properly workspace-scoped and capability-gated.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/content");
const ContentBrief = require("./models/ContentBrief");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function runRoute(path, method, req) {
  const res = fakeRes();
  for (const layer of router.stack) {
    if (layer.route) continue;
    let calledNext = false, nextError = null;
    await layer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) return res;
  }
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const cloudinaryUrl = "https://res.cloudinary.com/demo-cloud/image/upload/v1700000000/growth-operator/campaign/photo.jpg";
  const item = await ContentBrief.create({
    workspaceId, title: "Test post", type: "social", body: "Hello", createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId(),
    social: { media: [{ type: "image", url: cloudinaryUrl, publicId: "growth-operator/campaign/photo", width: 3000, height: 2000, orientation: "landscape" }] },
  });
  const auth = { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["social.manage"] };

  try {
    // 1. Generate variants for two platforms.
    const genRes = await runRoute("/:id/media/:mediaIndex/variants", "post", { params: { id: String(item._id), mediaIndex: "0" }, auth, body: { platforms: ["instagram", "facebook"] } });
    assert.equal(genRes.statusCode, 200);
    assert.equal(genRes.body.data.platformVariants.length, 2);
    assert.equal(genRes.body.data.url, cloudinaryUrl, "the original media url must be untouched by variant generation");
    assert.equal(genRes.body.data.publicId, "growth-operator/campaign/photo");

    // 2. Replace just the Instagram variant — Facebook's must be untouched.
    const patchRes = await runRoute("/:id/media/:mediaIndex/variants/:provider", "patch", { params: { id: String(item._id), mediaIndex: "0", provider: "instagram" }, auth, body: { placement: "story", mode: "contain" } });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.body.data.platformVariants.length, 2);
    const ig = patchRes.body.data.platformVariants.find((v) => v.provider === "instagram");
    const fb = patchRes.body.data.platformVariants.find((v) => v.provider === "facebook");
    assert.equal(ig.placement, "story");
    assert.equal(ig.mode, "contain");
    assert.ok(fb, "the facebook variant from step 1 must survive an instagram-only replace");

    // 3. Cross-workspace isolation: another workspace must never see or modify this content.
    const otherWorkspaceReq = { params: { id: String(item._id), mediaIndex: "0" }, auth: { ...auth, workspaceId: String(new mongoose.Types.ObjectId()) }, body: { platforms: ["x"] } };
    const isolationRes = await runRoute("/:id/media/:mediaIndex/variants", "post", otherWorkspaceReq);
    assert.equal(isolationRes.statusCode, 404);

    // 4. Capability gate: no social.manage -> 403.
    const forbiddenRes = await runRoute("/:id/media/:mediaIndex/variants", "post", { params: { id: String(item._id), mediaIndex: "0" }, auth: { ...auth, effectivePermissions: [] }, body: {} });
    assert.equal(forbiddenRes.statusCode, 403);
  } finally {
    await ContentBrief.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Media variant routes: non-destructive generation/replacement, workspace isolation, and capability gating all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
