// Live regression coverage for routes/socialAutomation.js: GET/PATCH /automations must be scoped to the
// caller's own workspace. Before this fix, SocialAutomation.findById()/find({}) had no workspaceId filter
// at all, so any authenticated user of any workspace could read or edit another workspace's automations
// by ID — confirmed exploitable live before the fix, confirmed blocked after it.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/socialAutomation");
const SocialAutomation = require("./models/SocialAutomation");

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
  } finally {
    await SocialAutomation.deleteMany({ _id: { $in: [docA._id, docB._id] } });
    await mongoose.disconnect();
  }
}
run()
  .then(() => console.log("Social automation routes: workspace isolation on GET/PATCH, contentBriefId filtering, and legitimate same-workspace edits all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
