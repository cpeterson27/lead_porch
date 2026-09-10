// Regression coverage for routes/providers.js: the status endpoint never exposes credential
// values, capability gating is enforced, and a disabled provider returns a clean 503 through the
// real route (not just the service layer) without ever constructing an HTTP client.
require("dotenv").config();
const assert = require("node:assert/strict");
const axios = require("axios");
const router = require("./routes/providers");

const originalApolloEnabled = process.env.APOLLO_ENABLED;
const originalApolloKey = process.env.APOLLO_API_KEY;
const originalCreate = axios.create;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function runRoute(path, method, req) {
  const res = fakeRes();
  // Run the router-level middleware (requireCapability) before the path-specific handler,
  // the same way Express would.
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
  try {
    delete process.env.APOLLO_ENABLED;
    delete process.env.APOLLO_API_KEY;
    delete require.cache[require.resolve("./services/apolloService")];

    // 1. Capability gate: no discovery.manage -> 403, never reaches the handler.
    const forbiddenRes = await runRoute("/status", "get", { auth: { workspaceId: "w1", effectivePermissions: [] } });
    assert.equal(forbiddenRes.statusCode, 403);

    // 2. Status must report disabled/unconfigured and never leak the key itself.
    const statusRes = await runRoute("/status", "get", { auth: { workspaceId: "w1", effectivePermissions: ["discovery.manage"] } });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.body.data.apollo.enabled, false);
    assert.equal(statusRes.body.data.apollo.configured, false);
    assert.ok(!JSON.stringify(statusRes.body).includes(process.env.APOLLO_API_KEY || "unset"));

    // 3. A disabled-provider request must return a clean 503 and must never construct an HTTP client.
    let created = false;
    axios.create = () => { created = true; throw new Error("must not construct an HTTP client while disabled"); };
    const searchRes = await runRoute("/apollo/people/search", "post", { auth: { workspaceId: "w1", effectivePermissions: ["discovery.manage"] }, body: { filters: {} }, get: () => "" });
    assert.equal(searchRes.statusCode, 503);
    assert.equal(searchRes.body.code, "APOLLO_DISABLED");
    assert.equal(created, false);
    axios.create = originalCreate;
  } finally {
    axios.create = originalCreate;
    if (originalApolloEnabled === undefined) delete process.env.APOLLO_ENABLED; else process.env.APOLLO_ENABLED = originalApolloEnabled;
    if (originalApolloKey === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = originalApolloKey;
    delete require.cache[require.resolve("./services/apolloService")];
  }
}

run()
  .then(() => console.log("Provider routes: capability gating, credential-free status reporting, and clean disabled-provider 503s all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
