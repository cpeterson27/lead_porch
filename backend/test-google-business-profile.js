const assert = require("assert");
const service = require("./services/googleBusinessProfileService");

function queryResult(value) {
  return { select: async () => value };
}

async function run() {
  const saved = [];
  const rejected = [];
  const connection = {
    status: "connected",
    credentialsEncrypted: "encrypted",
    oauth: { expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    settings: {
      accountName: "accounts/123",
      locationName: "locations/456",
      locationTitle: "Ellie's Coaching",
      mapsUri: "https://maps.google.com/?cid=123",
    },
    async save() { this.didSave = true; },
  };
  const models = {
    IntegrationConnection: {
      findOne() { return queryResult(connection); },
    },
    Testimonial: {
      async findOneAndUpdate(filter, update) { saved.push({ filter, update }); },
      async updateMany(filter, update) { rejected.push({ filter, update }); },
    },
  };
  const adapter = {
    async request(token, url) {
      assert.equal(token, "access-token");
      assert.match(url, /accounts\/123\/locations\/456\/reviews/);
      return {
        totalReviewCount: 1,
        averageRating: 5,
        reviews: [{
          reviewId: "review-1",
          reviewer: { displayName: "A Client", profilePhotoUrl: "https://example.com/avatar.jpg" },
          starRating: "FIVE",
          comment: "Ellie made the next step clear.",
          createTime: "2026-09-20T12:00:00.000Z",
          updateTime: "2026-09-20T12:00:00.000Z",
          reviewReplyUrl: "https://business.google.com/review/1",
        }],
      };
    },
  };
  const cryptoOps = {
    decryptCredentials() { return { accessToken: "access-token", refreshToken: "refresh-token" }; },
    encryptCredentials(value) { return value; },
  };

  const result = await service.syncReviews("workspace-1", models, adapter, cryptoOps);
  assert.deepEqual(result.imported, 1);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.averageRating, 5);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].filter, {
    workspaceId: "workspace-1",
    source: "google_business_profile",
    externalId: "review-1",
  });
  assert.equal(saved[0].update.$set.status, "approved");
  assert.equal(saved[0].update.$set.featured, true);
  assert.equal(saved[0].update.$set.rating, 5);
  assert.equal(saved[0].update.$set.body, "Ellie made the next step clear.");
  assert.equal(saved[0].update.$set.sourceUrl, "https://maps.google.com/?cid=123");
  assert.deepEqual(rejected[0].filter.externalId, { $nin: ["review-1"] });
  assert.equal(connection.didSave, true);
  assert.equal(connection.settings.lastSyncedAt instanceof Date, true);

  console.log("Google Business Profile review sync checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
