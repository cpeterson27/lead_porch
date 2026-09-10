// Regression coverage for POST /api/integrations/email/send-test: capability
// gating, field validation, provider-unavailable handling, and the success
// path — all against a mocked Resend adapter. No real network call or real
// email send is ever made in this file.
require("dotenv").config();
const assert = require("node:assert/strict");
const router = require("./routes/integrations");
const integrationRegistry = require("./services/integrations");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// Unlike routers that apply their capability gate inline per-route, this
// router applies it once via router.use() ahead of every route — so the
// walker must also run router-level middleware layers (those with no
// `.route`), not just the matched route's own handler stack.
async function runRoute(path, method, req) {
  const res = fakeRes();
  for (const layer of router.stack) {
    const handlers = layer.route ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null) : [layer];
    if (!handlers) continue;
    let stopped = false;
    for (const routeLayer of handlers) {
      let calledNext = false, nextError = null;
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

const authorized = { workspaceId: "w1", user: { _id: "u1" }, effectivePermissions: ["integrations.manage"] };

async function run() {
  const originalGet = integrationRegistry.get;
  try {
    // 1. Missing capability -> 403, no send attempted.
    let sendCalled = false;
    integrationRegistry.get = () => ({ sendEmail: async () => { sendCalled = true; } });
    const forbidden = await runRoute("/email/send-test", "post", {
      auth: { workspaceId: "w1", effectivePermissions: [] },
      body: { to: "owner@example.test", subject: "Test", html: "<p>Test</p>" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(sendCalled, false);

    // 2. Missing required fields -> 400, no send attempted.
    const missingFields = await runRoute("/email/send-test", "post", {
      auth: authorized,
      body: { to: "owner@example.test" },
    });
    assert.equal(missingFields.statusCode, 400);
    assert.equal(sendCalled, false);

    // 3. Resend not configured -> 404.
    integrationRegistry.get = () => null;
    const notConfigured = await runRoute("/email/send-test", "post", {
      auth: authorized,
      body: { to: "owner@example.test", subject: "Test", html: "<p>Test</p>" },
    });
    assert.equal(notConfigured.statusCode, 404);

    // 4. Success path: authorized, valid fields, configured provider -> 200,
    //    and the adapter is called with exactly the submitted fields.
    let captured = null;
    integrationRegistry.get = (id) => {
      assert.equal(id, "resend");
      return {
        sendEmail: async (payload) => { captured = payload; return { messageId: "mock-message-id" }; },
      };
    };
    const ok = await runRoute("/email/send-test", "post", {
      auth: authorized,
      body: { to: "owner@example.test", subject: "Test Email", html: "<p>Hello</p>" },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.success, true);
    assert.deepEqual(ok.body.data, { messageId: "mock-message-id" });
    assert.equal(captured.to, "owner@example.test");
    assert.equal(captured.subject, "Test Email");
    assert.equal(captured.html, "<p>Hello</p>");
  } finally {
    integrationRegistry.get = originalGet;
  }
}

run()
  .then(() => console.log("Resend send-test route: capability gate, field validation, provider-unavailable handling, and mocked success path all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
