// Regression coverage for the new Lead Agent "research this contact" feature:
// 1. services/agentToolRegistry.js: crm.list_opportunities must support an optional contactId filter
//    without changing its existing no-filter behavior (purely additive).
// 2. routes/contacts.js POST /:id/ai-research: capability checks and error mapping must be correct.
// The final AI synthesis step depends on live OpenAI billing, which this test cannot control — so the
// success path accepts either a real structured result or the specific "credits are empty" message,
// and asserts it is never an unhandled crash or a generic 500.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/contacts");
const toolRegistry = require("./services/agentToolRegistry");
const SalesOpportunity = require("./models/SalesOpportunity");
const Contact = require("./models/Contact");

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
  const contactA = await Contact.create({ workspaceId, name: "Contact A" });
  const contactB = await Contact.create({ workspaceId, name: "Contact B" });
  const oppA = await SalesOpportunity.create({ workspaceId, name: "Deal for A", stageKey: "new", primaryContactId: contactA._id });
  const oppB = await SalesOpportunity.create({ workspaceId, name: "Deal for B", stageKey: "new", primaryContactId: contactB._id });
  try {
    // 1. Tool-level: contactId filter is additive and correct.
    const listOpportunities = toolRegistry.getTool("crm.list_opportunities");
    const filtered = await listOpportunities.handler({
      workspaceId,
      userId: "u1",
      auth: { effectivePermissions: ["sales.opportunities.view"] },
      input: { contactId: String(contactA._id) },
      models: { SalesOpportunity },
    });
    assert.equal(filtered.length, 1, "filtering by contactId must return only that contact's opportunities");
    assert.equal(String(filtered[0]._id), String(oppA._id));

    const unfiltered = await listOpportunities.handler({
      workspaceId,
      userId: "u1",
      auth: { effectivePermissions: ["sales.opportunities.view"] },
      input: {},
      models: { SalesOpportunity },
    });
    assert.equal(unfiltered.length, 2, "omitting contactId must preserve the original list-everything behavior");

    // 2. Route-level: invalid ID -> 400.
    const layer = router.stack.find((l) => l.route && l.route.path === "/:id/ai-research" && l.route.methods.post);
    const badIdReq = { params: { id: "not-a-real-id" }, auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["crm.view"] } };
    const badIdRes = fakeRes();
    await layer.route.stack[0].handle(badIdReq, badIdRes, () => {});
    assert.equal(badIdRes.statusCode, 400);

    // 3. Route-level: missing agent capability -> 403 (Lead Agent requires crm.view or discovery.manage).
    const forbiddenReq = { params: { id: String(contactA._id) }, auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: [] } };
    const forbiddenRes = fakeRes();
    await layer.route.stack[0].handle(forbiddenReq, forbiddenRes, () => {});
    assert.equal(forbiddenRes.statusCode, 403);

    // 4. Route-level: full permissions -> either a real structured result or a clean billing message,
    //    never a raw crash or generic failure.
    const okReq = { params: { id: String(contactA._id) }, auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["crm.view", "sales.opportunities.view"] } };
    const okRes = fakeRes();
    await layer.route.stack[0].handle(okReq, okRes, (error) => {
      if (error) throw error;
    });
    if (okRes.statusCode === 200) {
      assert.equal(typeof okRes.body.data.summary, "string");
      assert.ok(Array.isArray(okRes.body.data.keySignals));
    } else {
      assert.equal(okRes.statusCode, 429);
      assert.match(okRes.body.message, /OpenAI credits are empty/);
    }
  } finally {
    await SalesOpportunity.deleteMany({ workspaceId });
    await Contact.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}
run()
  .then(() => console.log("Contact AI research: tool contactId filter, invalid-ID handling, capability enforcement, and clean billing-error mapping all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
