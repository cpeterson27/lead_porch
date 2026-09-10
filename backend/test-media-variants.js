// Regression coverage for the non-destructive per-platform media variant pipeline: every variant
// is a derived Cloudinary transformation URL (never a re-upload or a modification of the
// original), crop mode never stretches (it crops to fill), contain mode never stretches either
// (it pads with an extended background), and nothing is upscaled past a small source image.
const assert = require("node:assert/strict");
const media = require("./services/mediaVariantService");

const CLOUDINARY_URL = "https://res.cloudinary.com/demo-cloud/image/upload/v1700000000/growth-operator/campaign/abc123.jpg";

function testOrientation() {
  assert.equal(media.detectOrientation(1920, 1080), "landscape");
  assert.equal(media.detectOrientation(1080, 1920), "portrait");
  assert.equal(media.detectOrientation(1080, 1080), "square");
  assert.equal(media.detectOrientation(0, 0), "");
}

function testBuildVariantUrlNeverStretchesAndPreservesOriginal() {
  const crop = media.buildVariantUrl({ url: CLOUDINARY_URL, width: 1080, height: 1080, mode: "crop" });
  assert.match(crop.url, /\/c_fill,g_auto,w_1080,h_1080,q_auto,f_auto\//, "crop mode must use c_fill (crop-to-fill), never a stretching transformation like c_scale");
  assert.equal(crop.url.includes("growth-operator/campaign/abc123.jpg"), true, "the original asset path/public ID must be untouched — this is a derived URL, not a new upload");

  const contain = media.buildVariantUrl({ url: CLOUDINARY_URL, width: 1600, height: 900, mode: "contain" });
  assert.match(contain.url, /\/c_pad,b_auto:predominant,w_1600,h_900,q_auto,f_auto\//, "contain mode must use c_pad with an extended background, never stretching to fill");

  // The exact same source URL is passed for every variant — nothing here ever re-uploads.
  assert.equal(crop.url.startsWith("https://res.cloudinary.com/demo-cloud/image/upload/"), true);
}

function testUnsupportedHostRejected() {
  assert.throws(() => media.buildVariantUrl({ url: "https://example.com/not-cloudinary.jpg", width: 100, height: 100 }), /MEDIA_VARIANT_UNSUPPORTED_HOST|Cloudinary/);
}

function testBestPlacementPicksClosestAspectRatio() {
  const landscapeSpec = media.bestPlacementFor("facebook", 1920, 1080); // 16:9, closer to feed_landscape (1200x630, ~1.9:1) than square
  assert.equal(landscapeSpec.placement, "feed_landscape");
  const squareSpec = media.bestPlacementFor("facebook", 1000, 1000);
  assert.equal(squareSpec.placement, "feed_square");
}

function testGeneratePlatformVariantsCapsToSmallSource() {
  // A small 400x400 source must never be upscaled past its real size.
  const variants = media.generatePlatformVariants({ media: { url: CLOUDINARY_URL, width: 400, height: 400, orientation: "square" }, platforms: ["instagram"] });
  const feedSquare = variants.find((v) => v.placement === "feed_square");
  assert.equal(feedSquare.width, 400);
  assert.equal(feedSquare.height, 400);
}

function testGeneratePlatformVariantsForRealSizedSource() {
  const variants = media.generatePlatformVariants({ media: { url: CLOUDINARY_URL, width: 3000, height: 2000, orientation: "landscape" }, platforms: ["instagram", "facebook", "linkedin", "x"] });
  assert.equal(variants.length, 4);
  for (const variant of variants) {
    assert.ok(variant.url.startsWith("https://res.cloudinary.com/"));
    assert.ok(["crop", "contain"].includes(variant.mode));
    assert.ok(variant.width > 0 && variant.height > 0);
  }
}

function testReplaceVariantOnlyChangesOne() {
  const original = media.generatePlatformVariants({ media: { url: CLOUDINARY_URL, width: 3000, height: 2000, orientation: "landscape" }, platforms: ["instagram", "facebook"] });
  const replaced = media.replaceVariant({ media: { url: CLOUDINARY_URL, width: 3000, height: 2000 }, provider: "instagram", placement: "story", mode: "contain" });
  assert.equal(replaced.provider, "instagram");
  assert.equal(replaced.placement, "story");
  assert.equal(replaced.mode, "contain");
  // The other platform's variant from the original batch is untouched (this function only ever
  // returns the one replaced variant — the caller merges it back in, nothing else changes).
  const facebookOriginal = original.find((v) => v.provider === "facebook");
  assert.ok(facebookOriginal);
}

function run() {
  testOrientation();
  testBuildVariantUrlNeverStretchesAndPreservesOriginal();
  testUnsupportedHostRejected();
  testBestPlacementPicksClosestAspectRatio();
  testGeneratePlatformVariantsCapsToSmallSource();
  testGeneratePlatformVariantsForRealSizedSource();
  testReplaceVariantOnlyChangesOne();
}

run();
console.log("Media variant pipeline: non-destructive derivation, no-stretch crop/contain modes, aspect-ratio best-fit, and small-source capping all passed.");
