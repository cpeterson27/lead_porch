// A comment thread that actually received a private reply is a real DM-channel exchange (the reply
// lands in the recipient's own Instagram/Facebook DM inbox), so it must also appear in Lead Porch's main
// Social Inbox list — in addition to still showing under the originating post's Comments panel, not
// instead of it. A plain comment thread with no private reply must stay out of the Inbox list, exactly
// as before. This also verifies the Inbox now resolves and returns which post a conversation came from.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const ConversationThread = require("./models/ConversationThread");
const ConversationMessage = require("./models/ConversationMessage");
const ContentBrief = require("./models/ContentBrief");
const router = require("./routes/socialWorkspace");

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
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const brief = await ContentBrief.create({
    workspaceId,
    type: "social",
    title: "Regression test post",
    body: "body",
    status: "published",
    createdBy: userId,
    updatedBy: userId,
  });
  const plainComment = await ConversationThread.create({
    workspaceId,
    provider: "meta",
    channel: "instagram",
    providerThreadId: "instagram:asset:user:comment:plain",
    contactIds: [],
    metadata: { interactionType: "comment", contentBriefId: brief._id },
    lastMessageAt: new Date(),
  });
  const repliedComment = await ConversationThread.create({
    workspaceId,
    provider: "meta",
    channel: "instagram",
    providerThreadId: "instagram:asset:user:comment:replied",
    contactIds: [],
    metadata: { interactionType: "comment", contentBriefId: brief._id, hasPrivateReply: true },
    lastMessageAt: new Date(),
  });
  const dmThread = await ConversationThread.create({
    workspaceId,
    provider: "meta",
    channel: "instagram",
    providerThreadId: "instagram:asset:user:dm",
    contactIds: [],
    metadata: { interactionType: "message" },
    lastMessageAt: new Date(),
  });
  try {
    const getLayer = findLayer("get", "/inbox");
    const req = { auth: { workspaceId: String(workspaceId) }, query: {} };
    const res = fakeRes();
    await getLayer.route.stack[0].handle(req, res, (error) => {
      if (error) throw error;
    });
    const ids = res.body.map((row) => String(row._id));
    assert.ok(ids.includes(String(dmThread._id)), "a normal DM thread must still appear in the main Inbox");
    assert.ok(
      ids.includes(String(repliedComment._id)),
      "a comment thread that received a real private reply must also appear in the main Inbox",
    );
    assert.ok(
      !ids.includes(String(plainComment._id)),
      "a plain comment with no private reply must stay out of the main Inbox, exactly as before",
    );
    const repliedRow = res.body.find((row) => String(row._id) === String(repliedComment._id));
    assert.equal(repliedRow.postTitle, "Regression test post", "the Inbox must resolve which post this conversation came from");

    const commentsReq = { auth: { workspaceId: String(workspaceId) }, query: { type: "comments" } };
    const commentsRes = fakeRes();
    await getLayer.route.stack[0].handle(commentsReq, commentsRes, (error) => {
      if (error) throw error;
    });
    const commentIds = commentsRes.body.map((row) => String(row._id));
    assert.ok(commentIds.includes(String(plainComment._id)), "the Comments view must still show every comment thread");
    assert.ok(
      commentIds.includes(String(repliedComment._id)),
      "a comment that also got a private reply must still show in the Comments view too, not move away from it",
    );
  } finally {
    await ConversationThread.deleteMany({ _id: { $in: [plainComment._id, repliedComment._id, dmThread._id] } });
    await ContentBrief.deleteOne({ _id: brief._id });
    await mongoose.disconnect();
  }
}
run()
  .then(() =>
    console.log(
      "Social inbox: comment threads with a real private reply appear in both the main Inbox and the Comments view; plain comments stay Comments-only; post attribution resolves correctly.",
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
