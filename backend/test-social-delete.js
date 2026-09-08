const assert = require("node:assert/strict"), crypto = require("crypto");
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.META_GRAPH_API_VERSION = "v23.0";
const service = require("./services/socialPublishingService"),
  { encryptCredentials } = require("./utils/credentialEncryption");

const envelope = encryptCredentials({ accessToken: "ig-secret" });
const connection = {
  workspaceId: "ws1",
  provider: "instagram",
  status: "connected",
  assets: [{ id: "ig1", type: "instagram_business", parentId: "" }],
  credentialsEncrypted: envelope,
};
function doc() {
  return {
    _id: "c1",
    workspaceId: "ws1",
    body: "post body",
    social: {
      publications: [
        {
          provider: "instagram",
          assetId: "ig1",
          status: "published",
          providerPostId: "ig-post-1",
          attempts: [],
        },
      ],
    },
    save: async function () {
      return this;
    },
  };
}
function igError(code, subcode, message = "Unsupported delete request. Object does not exist.") {
  const error = new Error(message);
  error.response = { data: { error: { code, error_subcode: subcode, message } } };
  return error;
}
function models(http) {
  return { SocialConnection: { findOne: () => ({ select: async () => connection }) }, http };
}

(async () => {
  // A definitely-live, definitely-readable Instagram post rejecting DELETE with "does not exist" is a
  // real, permanent Meta platform limitation (confirmed live in production), not a transient failure —
  // it must not block removing the Lead Porch record.
  {
    const item = doc();
    const result = await service.deletePublished(
      { workspaceId: "ws1", item },
      models({ get: async () => ({ data: { id: "ig-post-1" } }), delete: async () => { throw igError(100, 33); } }),
    );
    assert.deepEqual(result.deleted, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /does not allow this connection to delete/);
    assert.equal(item.social.publications[0].status, "published", "an undeletable-but-still-live post must not be marked deleted");
  }

  // The exact same error signature when the post is genuinely already gone (pre-delete GET fails) is a
  // real success — nothing is left to delete.
  {
    const item = doc();
    const result = await service.deletePublished(
      { workspaceId: "ws1", item },
      models({ get: async () => { throw igError(100, 33); }, delete: async () => { throw igError(100, 33); } }),
    );
    assert.deepEqual(result.deleted, ["instagram"]);
    assert.equal(result.warnings.length, 0);
    assert.equal(item.social.publications[0].status, "deleted");
  }

  // The Page-linked "Meta allows publish but not delete" signature (error code 10) is the same permanent
  // limitation via a different connection type — also non-blocking.
  {
    const item = doc();
    const result = await service.deletePublished(
      { workspaceId: "ws1", item },
      models({ get: async () => ({ data: { id: "ig-post-1" } }), delete: async () => { throw igError(10, undefined, "Permissions error"); } }),
    );
    assert.deepEqual(result.deleted, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(item.social.publications[0].status, "published");
  }

  // A genuinely different failure (expired token, network error, unexpected code) must still block
  // deletion so the user can fix the real problem and retry, exactly as before.
  {
    const item = doc();
    await assert.rejects(
      () =>
        service.deletePublished(
          { workspaceId: "ws1", item },
          models({ get: async () => ({ data: { id: "ig-post-1" } }), delete: async () => { throw igError(190, undefined, "Invalid OAuth access token"); } }),
        ),
      /Could not delete every published copy/,
    );
    assert.equal(item.social.publications[0].status, "published");
  }

  console.log("Instagram post deletion: known unsupported-delete and already-gone signatures resolve without blocking the Lead Porch record; genuine failures still block and can be retried.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
