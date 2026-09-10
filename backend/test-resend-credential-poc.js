require("dotenv").config();
const assert = require("assert");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Contact = require("./models/Contact");
const IntegrationConnection = require("./models/IntegrationConnection");
const integrationHub = require("./services/integrationHub");
const ResendAdapter = require("./services/integrations/email/ResendAdapter");
const emailService = require("./services/email");
const {
  encryptCredentials,
  decryptCredentials,
} = require("./utils/credentialEncryption");

const originalEnvironment = {
  resendApiKey: process.env.RESEND_API_KEY,
  credentialSource: process.env.INTEGRATION_CREDENTIAL_SOURCE_RESEND,
  encryptionKey: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
};
const originalFindOne = IntegrationConnection.findOne;
const originalFetch = global.fetch;
const originalExecute = integrationHub.execute;

function setEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function mockConnection(connection) {
  IntegrationConnection.findOne = () => ({
    select: async () => connection,
  });
}

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    // Campaign email requires a real CRM contact for the recipient.
    await Contact.deleteMany({ email: "recipient@example.com" });
    await Contact.create({
      name: "Test Recipient",
      email: "recipient@example.com",
      sources: ["manual"],
      status: "active",
      emailStatus: "verified",
      emailPreferences: {
        marketingStatus: "subscribed",
        consentAt: new Date(),
        topics: { eventInvitations: true },
      },
    });
    const encryptionKey = crypto.randomBytes(32).toString("base64");
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", encryptionKey);

    const envelope = encryptCredentials({ apiKey: "test-resend-key" });
    assert.deepStrictEqual(
      decryptCredentials(envelope),
      { apiKey: "test-resend-key" },
    );
    assert.throws(
      () => decryptCredentials({ algorithm: "aes-256-gcm", version: 1 }),
      /Malformed credential encryption envelope/,
    );

    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", undefined);
    assert.throws(
      () => decryptCredentials(envelope),
      /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is not configured/,
    );
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "not-a-valid-key");
    assert.throws(
      () => decryptCredentials(envelope),
      /base64-encoded 32-byte key/,
    );
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", encryptionKey);

    setEnvironment("RESEND_API_KEY", undefined);
    setEnvironment("INTEGRATION_CREDENTIAL_SOURCE_RESEND", undefined);
    mockConnection(null);
    assert.deepStrictEqual(await integrationHub.resolveCredentials("resend"), {
      credentials: null,
      settings: {},
      source: "unconfigured",
    });

    let queriedConnection = false;
    IntegrationConnection.findOne = () => {
      queriedConnection = true;
      throw new Error("Environment-first resolution must not query MongoDB");
    };
    setEnvironment("RESEND_API_KEY", "environment-key");
    setEnvironment("INTEGRATION_CREDENTIAL_SOURCE_RESEND", undefined);
    let resolved = await integrationHub.resolveCredentials("resend");
    assert.strictEqual(resolved.source, "environment");
    assert.strictEqual(resolved.credentials.apiKey, "environment-key");
    assert.strictEqual(queriedConnection, false);

    setEnvironment("INTEGRATION_CREDENTIAL_SOURCE_RESEND", "env_first");
    resolved = await integrationHub.resolveCredentials("resend");
    assert.strictEqual(resolved.source, "environment");
    assert.strictEqual(resolved.credentials.apiKey, "environment-key");

    setEnvironment("INTEGRATION_CREDENTIAL_SOURCE_RESEND", "encrypted_first");
    mockConnection(null);
    resolved = await integrationHub.resolveCredentials("resend");
    assert.strictEqual(resolved.source, "environment");
    assert.strictEqual(resolved.credentials.apiKey, "environment-key");

    mockConnection({ credentialsEncrypted: envelope, settings: { sender: "test" } });
    resolved = await integrationHub.resolveCredentials("resend");
    assert.strictEqual(resolved.source, "encrypted");
    assert.strictEqual(resolved.credentials.apiKey, "test-resend-key");
    assert.deepStrictEqual(resolved.settings, { sender: "test" });

    mockConnection({
      credentialsEncrypted: { algorithm: "aes-256-gcm", version: 1 },
    });
    await assert.rejects(
      integrationHub.resolveCredentials("resend"),
      /Malformed credential encryption envelope/,
    );

    mockConnection({ credentialsEncrypted: envelope });
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", undefined);
    await assert.rejects(
      integrationHub.resolveCredentials("resend"),
      /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is not configured/,
    );
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "not-a-valid-key");
    await assert.rejects(
      integrationHub.resolveCredentials("resend"),
      /base64-encoded 32-byte key/,
    );
    setEnvironment("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", encryptionKey);

    const adapter = new ResendAdapter();
    global.fetch = async (_url, options) => {
      assert.strictEqual(options.headers.Authorization, "Bearer environment-key");
      return {
        ok: true,
        json: async () => ({ id: "test-message-id" }),
      };
    };
    const adapterResult = await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test",
      text: "Text",
      html: "<p>Test</p>",
    });
    assert.strictEqual(adapterResult.messageId, "test-message-id");

    integrationHub.execute = async () => ({ messageId: "legacy-shape-id" });
    const emailResult = await emailService.sendEmail({
      contactEmail: "recipient@example.com",
      emailDraft: "Test",
    });
    assert.deepStrictEqual(emailResult, {
      success: true,
      message: "Email sent successfully.",
      id: "legacy-shape-id",
    });

    console.log("Resend credential proof-of-concept tests passed");
  } finally {
    IntegrationConnection.findOne = originalFindOne;
    integrationHub.execute = originalExecute;
    global.fetch = originalFetch;
    setEnvironment("RESEND_API_KEY", originalEnvironment.resendApiKey);
    setEnvironment(
      "INTEGRATION_CREDENTIAL_SOURCE_RESEND",
      originalEnvironment.credentialSource,
    );
    setEnvironment(
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      originalEnvironment.encryptionKey,
    );
    await Contact.deleteMany({ email: "recipient@example.com" });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error("Resend credential proof-of-concept test failed");
  console.error(error.message);
  process.exitCode = 1;
});
