const crypto = require("crypto");
const axios = require("axios");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_VIDEO_BYTES = 75 * 1024 * 1024;

function credentials() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  let apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  let apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (process.env.CLOUDINARY_URL?.trim()) {
    const parsed = new URL(process.env.CLOUDINARY_URL.trim());
    cloudName = parsed.hostname; apiKey = decodeURIComponent(parsed.username); apiSecret = decodeURIComponent(parsed.password);
  }
  if (!cloudName || !apiKey || !apiSecret) throw Object.assign(new Error("Image upload is not configured"), { code: "IMAGE_PROVIDER_UNAVAILABLE", status: 503 });
  return { cloudName, apiKey, apiSecret };
}
function validateDataImage(file) {
  const match = String(file || "").match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || !ALLOWED_TYPES.has(match[1].toLowerCase())) throw Object.assign(new Error("Choose a JPG, PNG, WEBP, or GIF image"), { code: "IMAGE_TYPE_INVALID", status: 400 });
  const bytes = Math.floor(match[2].length * 3 / 4) - ((match[2].match(/=+$/) || [""])[0].length);
  if (bytes < 1 || bytes > MAX_IMAGE_BYTES) throw Object.assign(new Error("Profile photos must be 5 MB or smaller"), { code: "IMAGE_SIZE_INVALID", status: 400 });
  return { mimeType: match[1].toLowerCase(), bytes };
}
function signature(values, secret) { return crypto.createHash("sha1").update(`${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&")}${secret}`).digest("hex"); }
function validateDataVideo(file) {
  const match = String(file || "").match(/^data:(video\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || !ALLOWED_VIDEO_TYPES.has(match[1].toLowerCase())) throw Object.assign(new Error("Choose an MP4, WEBM, or MOV video"), { code: "VIDEO_TYPE_INVALID", status: 400 });
  const bytes = Math.floor(match[2].length * 3 / 4) - ((match[2].match(/=+$/) || [""])[0].length);
  if (bytes < 1 || bytes > MAX_VIDEO_BYTES) throw Object.assign(new Error("Videos must be 75 MB or smaller"), { code: "VIDEO_SIZE_INVALID", status: 400 });
  return { mimeType: match[1].toLowerCase(), bytes };
}
async function uploadImage({ file, folder, transformation = "" }, http = axios) {
  validateDataImage(file); const { cloudName, apiKey, apiSecret } = credentials(); const timestamp = Math.floor(Date.now() / 1000);
  const signed = { folder, timestamp, ...(transformation ? { transformation } : {}) };
  const body = new FormData(); body.append("file", file); body.append("api_key", apiKey); body.append("timestamp", String(timestamp)); body.append("folder", folder); if (transformation) body.append("transformation", transformation); body.append("signature", signature(signed, apiSecret));
  const upload = await http.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, body, { maxBodyLength: 7 * 1024 * 1024 });
  return { url: upload.data.secure_url, publicId: upload.data.public_id, width: upload.data.width, height: upload.data.height };
}
async function uploadGeneratedSvg({ svg, folder }, http = axios) {
  const value = String(svg || ""); if (!value.startsWith("<svg") || Buffer.byteLength(value) > 14 * 1024 * 1024) throw Object.assign(new Error("Generated graphic is invalid"), { code: "GENERATED_IMAGE_INVALID", status: 400 });
  const { cloudName, apiKey, apiSecret } = credentials(); const timestamp = Math.floor(Date.now() / 1000); const signed = { folder, timestamp, format: "png" };
  const body = new FormData(); body.append("format", "png"); body.append("file", `data:image/svg+xml;base64,${Buffer.from(value).toString("base64")}`); body.append("api_key", apiKey); body.append("timestamp", String(timestamp)); body.append("folder", folder); body.append("signature", signature(signed, apiSecret));
  const upload = await http.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, body, { maxBodyLength: 20 * 1024 * 1024 });
  return { url: upload.data.secure_url, publicId: upload.data.public_id, width: upload.data.width, height: upload.data.height };
}
async function uploadVideo({ file, folder }, http = axios) {
  validateDataVideo(file); const { cloudName, apiKey, apiSecret } = credentials(); const timestamp = Math.floor(Date.now() / 1000);
  const signed = { folder, timestamp }; const body = new FormData(); body.append("file", file); body.append("api_key", apiKey); body.append("timestamp", String(timestamp)); body.append("folder", folder); body.append("signature", signature(signed, apiSecret));
  const upload = await http.post(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, body, { maxBodyLength: 102 * 1024 * 1024 });
  return { url: upload.data.secure_url, publicId: upload.data.public_id, width: upload.data.width, height: upload.data.height, duration: upload.data.duration };
}
function createVideoUploadSignature({ folder }) {
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    cloudName,
    apiKey,
    timestamp,
    folder,
    signature: signature({ folder, timestamp }, apiSecret),
    maxBytes: MAX_VIDEO_BYTES,
  };
}
async function removeImage(publicId, http = axios) {
  if (!publicId) return { removed: false }; const { cloudName, apiKey, apiSecret } = credentials(); const timestamp = Math.floor(Date.now() / 1000); const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: apiKey, signature: signature({ public_id: publicId, timestamp }, apiSecret) });
  await http.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, body, { headers: { "Content-Type": "application/x-www-form-urlencoded" } }); return { removed: true };
}
module.exports = { ALLOWED_TYPES, ALLOWED_VIDEO_TYPES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, createVideoUploadSignature, credentials, removeImage, uploadGeneratedSvg, uploadImage, uploadVideo, validateDataImage, validateDataVideo };
