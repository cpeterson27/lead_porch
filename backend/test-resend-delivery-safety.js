const assert = require("node:assert/strict");
const ResendAdapter = require("./services/integrations/email/ResendAdapter");

const originalFetch = global.fetch;

async function run() {
  let captured;
  try {
    global.fetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ id: "safe-message-id" }) };
    };
    const adapter = new ResendAdapter({ apiKey: "test-key" });
    const result = await adapter.sendEmail({
      from: "Sender <sender@example.com>",
      to: "recipient@example.com",
      subject: "Safe delivery",
      html: "<p>Hello</p>",
      idempotencyKey: "outreach/abc123",
    });
    assert.equal(result.messageId, "safe-message-id");
    assert.equal(captured.options.headers["Idempotency-Key"], "outreach/abc123");
    assert.ok(captured.options.signal instanceof AbortSignal);
  } finally {
    global.fetch = originalFetch;
  }
}

run().then(() => console.log("Resend delivery safety tests passed.")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
