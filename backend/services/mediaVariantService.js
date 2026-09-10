/**
 * Non-destructive per-platform media variants. Every variant is a derived
 * Cloudinary transformation URL computed from the ALREADY-uploaded original
 * — nothing here re-uploads, overwrites, or modifies the source asset, and
 * nothing here ever stretches an image or video out of its real aspect
 * ratio (Cloudinary's c_fill crops, c_pad extends the background; neither
 * distorts).
 */

// Real, documented per-platform placements. Each entry is a target aspect
// ratio (not a hardcoded pixel blow-up) — width/height are the reference
// size Cloudinary renders to, capped to the source below so nothing is
// upscaled past what was actually uploaded.
const PLATFORM_SPECS = Object.freeze({
  instagram: [
    { placement: "feed_square", width: 1080, height: 1080 },
    { placement: "feed_portrait", width: 1080, height: 1350 },
    { placement: "story", width: 1080, height: 1920 },
  ],
  facebook: [
    { placement: "feed_square", width: 1080, height: 1080 },
    { placement: "feed_landscape", width: 1200, height: 630 },
  ],
  linkedin: [
    { placement: "feed_landscape", width: 1200, height: 627 },
    { placement: "feed_square", width: 1200, height: 1200 },
  ],
  x: [
    { placement: "feed_landscape", width: 1600, height: 900 },
    { placement: "feed_square", width: 1200, height: 1200 },
  ],
});

function detectOrientation(width, height) {
  const w = Number(width), h = Number(height);
  if (!w || !h) return "";
  const ratio = w / h;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
}

/**
 * Pick the placement spec whose aspect ratio is closest to the source, so a
 * portrait photo doesn't get force-fit into a landscape frame by default —
 * the caller can still request a specific placement explicitly.
 */
function bestPlacementFor(provider, sourceWidth, sourceHeight) {
  const specs = PLATFORM_SPECS[provider];
  if (!specs) return null;
  if (!sourceWidth || !sourceHeight) return specs[0];
  const sourceRatio = sourceWidth / sourceHeight;
  return specs.reduce((best, spec) => {
    const specRatio = spec.width / spec.height;
    const diff = Math.abs(Math.log(specRatio / sourceRatio));
    return !best || diff < best.diff ? { ...spec, diff } : best;
  }, null);
}

function cloudinaryBase(url) {
  const match = String(url || "").match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/(image|video)\/upload)\/(?:v\d+\/)?(.+)$/);
  if (!match) return null;
  return { prefix: match[1], resourceType: match[2], suffix: match[3] };
}

/**
 * Build one non-destructive derived variant URL. `mode: "crop"` fills the
 * target frame using smart (content-aware) cropping — it never stretches,
 * it crops what doesn't fit. `mode: "contain"` pads to fit the whole
 * original into the frame using an auto-extended background — nothing is
 * cropped or stretched, empty space is filled in instead.
 */
function buildVariantUrl({ url, width, height, mode = "crop" }) {
  const parsed = cloudinaryBase(url);
  if (!parsed) { const error = new Error("Only Cloudinary-hosted assets support generated platform variants"); error.code = "MEDIA_VARIANT_UNSUPPORTED_HOST"; throw error; }
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const transform = mode === "contain"
    ? `c_pad,b_auto:predominant,w_${w},h_${h},q_auto,f_auto`
    : `c_fill,g_auto,w_${w},h_${h},q_auto,f_auto`;
  return { url: `${parsed.prefix}/${transform}/${parsed.suffix}`, width: w, height: h, mode, resourceType: parsed.resourceType };
}

/**
 * Generate one variant per requested platform for a single media item,
 * choosing the best-fit placement automatically unless one is specified.
 * Never upscales past the real source dimensions when the source is smaller
 * than every documented placement for that platform.
 */
function generatePlatformVariants({ media, platforms, mode }) {
  if (!media?.url) { const error = new Error("A media url is required"); error.code = "MEDIA_VARIANT_SOURCE_REQUIRED"; throw error; }
  const results = [];
  for (const provider of platforms) {
    const spec = bestPlacementFor(provider, media.width, media.height);
    if (!spec) continue;
    const capped = media.width && media.height && media.width < spec.width && media.height < spec.height
      ? { width: media.width, height: media.height }
      : { width: spec.width, height: spec.height };
    const variant = buildVariantUrl({ url: media.url, width: capped.width, height: capped.height, mode: mode || (media.orientation === detectOrientation(spec.width, spec.height) ? "crop" : "contain") });
    results.push({ provider, placement: spec.placement, mode: variant.mode, url: variant.url, width: variant.width, height: variant.height, generatedAt: new Date() });
  }
  return results;
}

/** Replace exactly one platform's variant (e.g. the user picked a different crop mode), leaving every other variant and the original untouched. */
function replaceVariant({ media, provider, placement, mode = "crop", width, height }) {
  const spec = PLATFORM_SPECS[provider]?.find((item) => item.placement === placement) || bestPlacementFor(provider, media.width, media.height);
  if (!spec) { const error = new Error(`No known placement for ${provider}`); error.code = "MEDIA_VARIANT_UNKNOWN_PLACEMENT"; throw error; }
  const variant = buildVariantUrl({ url: media.url, width: width || spec.width, height: height || spec.height, mode });
  return { provider, placement: spec.placement, mode: variant.mode, url: variant.url, width: variant.width, height: variant.height, generatedAt: new Date() };
}

module.exports = { PLATFORM_SPECS, detectOrientation, bestPlacementFor, buildVariantUrl, generatePlatformVariants, replaceVariant };
