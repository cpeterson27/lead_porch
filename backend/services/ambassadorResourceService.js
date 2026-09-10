/**
 * Ambassador Resource Center: private, versioned file storage for program
 * guides, brand assets, training, and binding agreements. File bodies are
 * never stored in MongoDB — only Cloudinary metadata per version. Downloads
 * are always proxied through an authorization-checked backend route that
 * fetches the file bytes from Cloudinary server-side at request time (see
 * downloadBytesFor below) and streams them to the client — the browser
 * never receives a Cloudinary URL or credential of any kind.
 *
 * The upload (authenticated/private delivery) and signed-download flow
 * below has been verified live against a real Cloudinary account via
 * scripts/ambassador-resource-smoke-test.js: uploads as type "authenticated"
 * are confirmed genuinely inaccessible via the public delivery URL, and the
 * signed download request (Admin-API-style timestamp+signature over
 * public_id/timestamp/type — resource_type is routing-only and must NOT be
 * part of the signature) correctly returns the file bytes.
 */
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const AmbassadorResourceFile = require("../models/AmbassadorResourceFile");
const AmbassadorResourceAccess = require("../models/AmbassadorResourceAccess");
const AmbassadorProfile = require("../models/AmbassadorProfile");
const Contact = require("../models/Contact");
const Enrollment = require("../models/Enrollment");
const User = require("../models/User");
const { credentials } = require("./imageAssetService");
const auditService = require("./auditService");

const CATEGORIES = ["start_here", "ambassador_program", "program_outlines", "brand_assets", "approved_talking_points", "campaigns", "training", "policies_and_agreements"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
]);
const deps = { AmbassadorResourceFile, AmbassadorResourceAccess, AmbassadorProfile, Contact, Enrollment, User };

function fail(message, code, status = 400) { return Object.assign(new Error(message), { code, status }); }

function signature(values, secret) { return crypto.createHash("sha1").update(`${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&")}${secret}`).digest("hex"); }

function resourceTypeFor(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "raw";
}

/**
 * A crude malware guard, not a substitute for a real scanner: reject files
 * whose declared type doesn't match their actual magic bytes, and reject
 * executable/script signatures outright. Real deployments should still run
 * these through a dedicated scanning service before trusting them.
 */
function validateFileSafety(buffer, mimeType) {
  const magicChecks = {
    "application/pdf": (buf) => buf.slice(0, 5).toString("latin1") === "%PDF-",
    "image/jpeg": (buf) => buf[0] === 0xff && buf[1] === 0xd8,
    "image/png": (buf) => buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a",
    "image/gif": (buf) => buf.slice(0, 3).toString("latin1") === "GIF",
  };
  const dangerousSignatures = ["4d5a", "7f454c46"]; // MZ (Windows PE) and ELF executables
  const headHex = buffer.slice(0, 4).toString("hex");
  if (dangerousSignatures.some((sig) => headHex.startsWith(sig))) throw fail("This file cannot be accepted", "RESOURCE_FILE_UNSAFE");
  const check = magicChecks[mimeType];
  if (check && !check(buffer)) throw fail("The file content does not match its declared type", "RESOURCE_FILE_TYPE_MISMATCH");
}

function parseDataUri(fileDataUri) {
  const match = String(fileDataUri || "").match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw fail("A valid file is required", "RESOURCE_FILE_INVALID");
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw fail("Only PDF, DOCX, image, or video files are accepted", "RESOURCE_FILE_TYPE_INVALID");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length < 1 || buffer.length > MAX_FILE_BYTES) throw fail(`Files must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller`, "RESOURCE_FILE_SIZE_INVALID");
  validateFileSafety(buffer, mimeType);
  return { buffer, mimeType, resourceType: resourceTypeFor(mimeType) };
}

async function uploadToCloudinary({ buffer, mimeType, resourceType, fileName, workspaceId }, http = axios) {
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `ambassador-resources/${workspaceId}`;
  const signed = { folder, timestamp, type: "authenticated" };
  const body = new FormData();
  body.append("file", buffer, { filename: fileName, contentType: mimeType });
  body.append("api_key", apiKey);
  body.append("timestamp", String(timestamp));
  body.append("folder", folder);
  body.append("type", "authenticated");
  body.append("signature", signature(signed, apiSecret));
  const upload = await http.post(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, body, { headers: body.getHeaders ? body.getHeaders() : undefined, maxBodyLength: MAX_FILE_BYTES + 1024 });
  return { publicId: upload.data.public_id, format: upload.data.format || "", sizeBytes: upload.data.bytes || buffer.length };
}

async function create({ workspaceId, userId, title, description = "", category, kind = "guide", coachingProgramIds = [], visibility = {}, requiresAcknowledgment = false, fileDataUri, fileName, changeNotes = "" }, models = deps, http = axios) {
  if (!CATEGORIES.includes(category)) throw fail("Choose a valid resource category", "RESOURCE_CATEGORY_INVALID");
  if (!title?.trim()) throw fail("A title is required", "RESOURCE_TITLE_REQUIRED");
  const { buffer, mimeType, resourceType } = parseDataUri(fileDataUri);
  const uploaded = await uploadToCloudinary({ buffer, mimeType, resourceType, fileName: fileName || title, workspaceId }, http);
  const version = { version: 1, cloudinaryPublicId: uploaded.publicId, resourceType, format: uploaded.format, fileName: String(fileName || title).slice(0, 260), mimeType, sizeBytes: uploaded.sizeBytes, effectiveDate: new Date(), changeNotes: changeNotes.trim(), uploadedByUserId: userId, uploadedAt: new Date() };
  const resource = await models.AmbassadorResourceFile.create({
    workspaceId, title: title.trim(), description: description.trim(), category, kind, coachingProgramIds,
    visibility: { internalOnly: visibility.internalOnly !== false, allAmbassadors: Boolean(visibility.allAmbassadors), namedAmbassadorIds: visibility.namedAmbassadorIds || [], studentsOrProgramMembers: Boolean(visibility.studentsOrProgramMembers), public: Boolean(visibility.public) },
    requiresAcknowledgment: Boolean(requiresAcknowledgment), currentVersion: 1, versions: [version], createdByUserId: userId, updatedByUserId: userId,
  });
  await auditService.record({ workspaceId, actorUserId: userId, action: "resource.file.uploaded", targetType: "AmbassadorResourceFile", targetId: resource._id, after: { title: resource.title, category, version: 1 }, success: true });
  return resource;
}

async function addVersion({ workspaceId, resourceId, userId, fileDataUri, fileName, changeNotes = "" }, models = deps, http = axios) {
  const resource = await models.AmbassadorResourceFile.findOne({ _id: resourceId, workspaceId });
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  const { buffer, mimeType, resourceType } = parseDataUri(fileDataUri);
  const uploaded = await uploadToCloudinary({ buffer, mimeType, resourceType, fileName: fileName || resource.title, workspaceId }, http);
  const nextVersion = resource.currentVersion + 1;
  resource.versions.push({ version: nextVersion, cloudinaryPublicId: uploaded.publicId, resourceType, format: uploaded.format, fileName: String(fileName || resource.title).slice(0, 260), mimeType, sizeBytes: uploaded.sizeBytes, effectiveDate: new Date(), changeNotes: changeNotes.trim(), uploadedByUserId: userId, uploadedAt: new Date() });
  resource.currentVersion = nextVersion;
  resource.updatedByUserId = userId;
  await resource.save();
  await auditService.record({ workspaceId, actorUserId: userId, action: "resource.file.versioned", targetType: "AmbassadorResourceFile", targetId: resource._id, before: { version: nextVersion - 1 }, after: { version: nextVersion }, success: true });
  return resource;
}

async function updateMetadata({ workspaceId, resourceId, userId, changes = {} }, models = deps) {
  const update = { updatedByUserId: userId };
  for (const field of ["title", "description", "category", "kind", "requiresAcknowledgment", "coachingProgramIds"]) if (changes[field] !== undefined) update[field] = changes[field];
  if (changes.visibility) update.visibility = { internalOnly: changes.visibility.internalOnly !== false, allAmbassadors: Boolean(changes.visibility.allAmbassadors), namedAmbassadorIds: changes.visibility.namedAmbassadorIds || [], studentsOrProgramMembers: Boolean(changes.visibility.studentsOrProgramMembers), public: Boolean(changes.visibility.public) };
  if (update.category && !CATEGORIES.includes(update.category)) throw fail("Choose a valid resource category", "RESOURCE_CATEGORY_INVALID");
  const resource = await models.AmbassadorResourceFile.findOneAndUpdate({ _id: resourceId, workspaceId }, { $set: update }, { new: true, runValidators: true });
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  return resource;
}

async function setJarvisApproval({ workspaceId, resourceId, approved }, models = deps) {
  const resource = await models.AmbassadorResourceFile.findOneAndUpdate({ _id: resourceId, workspaceId }, { $set: { jarvisApproved: Boolean(approved) } }, { new: true });
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  await auditService.record({ workspaceId, action: "resource.jarvis_approval.changed", targetType: "AmbassadorResourceFile", targetId: resource._id, after: { jarvisApproved: resource.jarvisApproved }, success: true });
  return resource;
}

async function archive({ workspaceId, resourceId, userId }, models = deps) {
  const resource = await models.AmbassadorResourceFile.findOneAndUpdate({ _id: resourceId, workspaceId }, { $set: { status: "archived", archivedAt: new Date(), archivedByUserId: userId } }, { new: true });
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  await auditService.record({ workspaceId, actorUserId: userId, action: "resource.file.archived", targetType: "AmbassadorResourceFile", targetId: resource._id, success: true });
  return resource;
}

async function listForAdmin({ workspaceId, category, status }, models = deps) {
  const filter = { workspaceId };
  if (category) filter.category = category;
  filter.status = status || "active";
  return models.AmbassadorResourceFile.find(filter).sort({ category: 1, title: 1 }).lean();
}

/**
 * "Students/program members" is resolved via the requesting user's linked
 * CRM Contact having an active Enrollment — this codebase has no separate
 * "student account" concept, so an active enrollment is the closest real
 * signal available today.
 */
async function isEnrolledStudent({ workspaceId, userId }, models = deps) {
  const user = await models.User.findById(userId).select("email").lean();
  if (!user?.email) return false;
  const contact = await models.Contact.findOne({ workspaceId, email: user.email }).select("_id").lean();
  if (!contact) return false;
  return models.Enrollment.exists({ workspaceId, contactId: contact._id, status: "active" });
}

function isVisible(resource, { ambassadorProfileId, studentEligible, isPublicViewer }) {
  if (resource.status !== "active") return false;
  if (resource.visibility.public) return true;
  if (isPublicViewer) return false;
  if (resource.visibility.allAmbassadors && ambassadorProfileId) return true;
  if (ambassadorProfileId && (resource.visibility.namedAmbassadorIds || []).some((id) => String(id) === String(ambassadorProfileId))) return true;
  if (resource.visibility.studentsOrProgramMembers && studentEligible) return true;
  return false;
}

async function listForViewer({ workspaceId, userId, ambassadorProfileId, search = "" }, models = deps) {
  const studentEligible = await isEnrolledStudent({ workspaceId, userId }, models);
  const all = await models.AmbassadorResourceFile.find({ workspaceId, status: "active" }).sort({ category: 1, title: 1 }).lean();
  const visible = all.filter((resource) => isVisible(resource, { ambassadorProfileId, studentEligible, isPublicViewer: false }));
  const term = search.trim().toLowerCase();
  const filtered = term ? visible.filter((resource) => `${resource.title} ${resource.description}`.toLowerCase().includes(term)) : visible;
  return filtered.map((resource) => ({ ...resource, versions: undefined, latestVersion: resource.versions.find((v) => v.version === resource.currentVersion) }));
}

/**
 * Fetches the file BYTES directly from Cloudinary via a signed
 * Admin-API-style request (timestamp + signature over public_id, timestamp,
 * and type — resource_type is routing-only, never part of the signature).
 * Verified live against a real Cloudinary account with
 * scripts/ambassador-resource-smoke-test.js: this endpoint returns the file
 * content itself, not a URL. The caller streams these bytes straight to the
 * client — Cloudinary's URL/credentials are never exposed to the browser.
 */
async function downloadBytesFor({ publicId, resourceType }, http = axios) {
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp, type: "authenticated" };
  const response = await http.get(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/download`, { params: { ...params, api_key: apiKey, signature: signature(params, apiSecret) }, responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

async function recordAccessAndGetDownload({ workspaceId, resourceId, userId, ambassadorProfileId, action = "download" }, models = deps, http = axios) {
  const resource = await models.AmbassadorResourceFile.findOne({ _id: resourceId, workspaceId, status: "active" }).lean();
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  const studentEligible = await isEnrolledStudent({ workspaceId, userId }, models);
  if (!isVisible(resource, { ambassadorProfileId, studentEligible, isPublicViewer: false })) throw fail("You do not have access to this resource", "RESOURCE_ACCESS_DENIED", 403);
  const version = resource.versions.find((v) => v.version === resource.currentVersion);
  await models.AmbassadorResourceAccess.create({ workspaceId, resourceFileId: resource._id, version: resource.currentVersion, userId, action });
  await auditService.record({ workspaceId, actorUserId: userId, action: action === "download" ? "resource.file.downloaded" : "resource.file.viewed", targetType: "AmbassadorResourceFile", targetId: resource._id, metadata: { version: resource.currentVersion }, success: true });
  if (action === "download") return { buffer: await downloadBytesFor({ publicId: version.cloudinaryPublicId, resourceType: version.resourceType }, http), fileName: version.fileName, mimeType: version.mimeType };
  return { resource, version };
}

async function acknowledge({ workspaceId, resourceId, userId }, models = deps) {
  const resource = await models.AmbassadorResourceFile.findOne({ _id: resourceId, workspaceId, status: "active" }).lean();
  if (!resource) throw fail("Resource not found", "RESOURCE_NOT_FOUND", 404);
  if (!resource.requiresAcknowledgment) throw fail("This resource does not require acknowledgment", "RESOURCE_ACK_NOT_REQUIRED");
  await models.AmbassadorResourceAccess.create({ workspaceId, resourceFileId: resource._id, version: resource.currentVersion, userId, action: "acknowledged" });
  await auditService.record({ workspaceId, actorUserId: userId, action: "resource.file.acknowledged", targetType: "AmbassadorResourceFile", targetId: resource._id, metadata: { version: resource.currentVersion }, success: true });
  return { acknowledged: true, version: resource.currentVersion, at: new Date() };
}

async function accessHistory({ workspaceId, resourceId }, models = deps) {
  return models.AmbassadorResourceAccess.find({ workspaceId, resourceFileId: resourceId }).populate("userId", "name email").sort({ occurredAt: -1 }).limit(500).lean();
}

module.exports = { CATEGORIES, MAX_FILE_BYTES, acknowledge, accessHistory, addVersion, archive, create, isVisible, isEnrolledStudent, listForAdmin, listForViewer, recordAccessAndGetDownload, setJarvisApproval, updateMetadata };
