// Live regression coverage for routes/socialAutomation.js:
// 1. GET/PATCH /automations must be scoped to the caller's own workspace. Before this fix,
//    SocialAutomation.findById()/find({}) had no workspaceId filter in the route code itself, so calling
//    these handlers outside the normal request pipeline (which wraps every request in the workspace's
//    async-local context that a Mongoose plugin uses to auto-scope queries) was exploitable across
//    workspaces — confirmed blocked after adding an explicit filter, which also hardens the route so it
//    no longer depends solely on that implicit mechanism.
// 2. A bare-domain CTA destination (no https://) must be normalized the same way the post's own CTA URL
//    already is, on both create and edit.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/socialAutomation");
const SocialAutomation = require("./models/SocialAutomation");
const SocialConnection = require("./models/SocialConnection");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

function findLayer(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.body = data;
    return res;
  };
  return res;
}
async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const wsA = new mongoose.Types.ObjectId();
  const wsB = new mongoose.Types.ObjectId();
  const actor = new mongoose.Types.ObjectId();
  const docA = await SocialAutomation.create({ workspaceId: wsA, name: "Workspace A automation", provider: "instagram", assetId: "assetA", triggerType: "comment_keyword", keywords: ["a"], enabled: true, createdBy: actor, updatedBy: actor });
  const docB = await SocialAutomation.create({ workspaceId: wsB, name: "Workspace B automation", provider: "instagram", assetId: "assetB", triggerType: "comment_keyword", keywords: ["b"], enabled: true, createdBy: actor, updatedBy: actor });
  const connectionA = await SocialConnection.create({ workspaceId: wsA, provider: "instagram", status: "connected", connectedByUserId: actor, selectedAssetIds: ["assetA"], assets: [{ id: "assetA", type: "instagram_business" }] });
  try {
    const patchLayer = findLayer("patch", "/automations/:id");
    const patchReq = { params: { id: String(docB._id) }, auth: { workspaceId: String(wsA), userId: String(actor) }, body: { name: "HACKED" } };
    const patchRes = fakeRes();
    await patchLayer.route.stack[0].handle(patchReq, patchRes, (error) => {
      if (error) throw error;
    });
    assert.equal(patchRes.statusCode, 404, "workspace A must not be able to reach workspace B's automation by ID");
    const reloadedB = await SocialAutomation.findById(docB._id).lean();
    assert.equal(reloadedB.name, "Workspace B automation", "the cross-workspace PATCH attempt must not have modified anything");

    const getLayer = findLayer("get", "/automations");
    const getReq = { auth: { workspaceId: String(wsA) }, query: {} };
    const getRes = fakeRes();
    await getLayer.route.stack[0].handle(getReq, getRes, (error) => {
      if (error) throw error;
    });
    assert.equal(getRes.body.data.length, 1, "the list route must return only the caller's own workspace's automations");
    assert.equal(getRes.body.data[0].name, "Workspace A automation");

    const contentBriefId = new mongoose.Types.ObjectId();
    await SocialAutomation.updateOne({ _id: docA._id }, { $set: { contentBriefId } });
    const filteredReq = { auth: { workspaceId: String(wsA) }, query: { contentBriefId: String(contentBriefId) } };
    const filteredRes = fakeRes();
    await getLayer.route.stack[0].handle(filteredReq, filteredRes, (error) => {
      if (error) throw error;
    });
    assert.equal(filteredRes.body.data.length, 1, "the contentBriefId filter must find the automation attached to a post");

    const legitimatePatchReq = { params: { id: String(docA._id) }, auth: { workspaceId: String(wsA), userId: String(actor) }, body: { keywords: ["deal", "apply"], triggerType: "comment_keyword" } };
    const legitimatePatchRes = fakeRes();
    await patchLayer.route.stack[0].handle(legitimatePatchReq, legitimatePatchRes, (error) => {
      if (error) throw error;
    });
    assert.equal(legitimatePatchRes.statusCode, 200, "editing your own workspace's automation must still work");
    assert.deepEqual(legitimatePatchRes.body.data.keywords, ["deal", "apply"]);

    // A bare domain like "elliescoaching.com" (no https://) is exactly what someone naturally types into
    // a button-link field — the post's own CTA URL field already tolerates this via normalizeUrl(); the
    // automation's CTA field must too, instead of throwing "must use this workspace's verified HTTPS
    // website" for input that's actually fine once normalized.
    const bareDomainPatchReq = { params: { id: String(docA._id) }, auth: { workspaceId: String(wsA), userId: String(actor) }, body: { cta: { label: "Apply", destination: "elliescoaching.com" } } };
    const bareDomainPatchRes = fakeRes();
    await patchLayer.route.stack[0].handle(bareDomainPatchReq, bareDomainPatchRes, (error) => {
      if (error) throw error;
    });
    assert.equal(bareDomainPatchRes.statusCode, 200, "a bare domain CTA destination must be accepted, not rejected");
    assert.equal(bareDomainPatchRes.body.data.cta.destination, "https://elliescoaching.com");

    const postLayer = findLayer("post", "/automations");
    const bareDomainPostReq = { auth: { workspaceId: String(wsA), userId: String(actor) }, body: { provider: "instagram", assetId: "assetA", name: "Bare domain on create", triggerType: "comment_keyword", keywords: ["deal"], cta: { label: "Apply", destination: "elliescoaching.com" } } };
    const bareDomainPostRes = fakeRes();
    await runWithWorkspace(String(wsA), () =>
      postLayer.route.stack[0].handle(bareDomainPostReq, bareDomainPostRes, (error) => {
        if (error) throw error;
      }),
    );
    assert.equal(bareDomainPostRes.statusCode, 201, "a bare domain CTA destination must be accepted on create too");
    assert.equal(bareDomainPostRes.body.data.cta.destination, "https://elliescoaching.com");
    await SocialAutomation.deleteOne({ _id: bareDomainPostRes.body.data._id });
  } finally {
    await SocialAutomation.deleteMany({ _id: { $in: [docA._id, docB._id] } });
    await SocialConnection.deleteOne({ _id: connectionA._id });
    await mongoose.disconnect();
  }
}
run()
  .then(() => console.log("Social automation routes: workspace isolation on GET/PATCH, contentBriefId filtering, and legitimate same-workspace edits all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
