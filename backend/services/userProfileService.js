const User = require("../models/User");
const AmbassadorProfile = require("../models/AmbassadorProfile");
const limits = { firstName: 80, lastName: 80, name: 120, phone: 50, jobTitle: 120, company: 160, bio: 3000, location: 160, timezone: 100, website: 2000 };
const networks = ["linkedin", "facebook", "instagram", "x"];
const selection = `${Object.keys(limits).join(" ")} email avatarUrl socialProfiles profileUpdatedAt createdAt lastLoginAt twoFactor`;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Legacy ambassador identity is read-only fallback until the user saves their canonical profile.
function resolveProfile(user = {}, legacy = {}) {
  const canonical = Boolean(user.profileUpdatedAt);
  const result = {};
  for (const key of Object.keys(limits)) result[key] = user[key] || (!canonical ? legacy[key === "location" ? "publicLocation" : key] : "") || "";
  result.name = user.name || legacy.displayName || "";
  result.socialProfiles = Object.fromEntries(networks.map((key) => [key, user.socialProfiles?.[key] || (!canonical ? legacy.socialProfiles?.[key] : "") || ""]));
  for (const key of networks) {
    const link = result.socialProfiles[key];
    if (/^@[A-Za-z0-9._-]+$/.test(link)) result.socialProfiles[key] = `https://${{ instagram: "instagram.com", facebook: "facebook.com", linkedin: "linkedin.com/in", x: "x.com" }[key]}/${link.slice(1)}`;
  }
  for (const key of ["email", "avatarUrl", "createdAt", "lastLoginAt"]) result[key] = user[key] || "";
  result.twoFactor = { enabled: Boolean(user.twoFactor?.enabled) };
  return result;
}
function validate(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw fail("Invalid profile");
  for (const key of Object.keys(changes)) if (!Object.hasOwn(limits, key) && key !== "socialProfiles") throw fail(`Field cannot be edited: ${key}`);
  const update = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "socialProfiles") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("Invalid social links");
      for (const [network, link] of Object.entries(value)) {
        if (!networks.includes(network)) throw fail("Unknown social network");
        update[`socialProfiles.${network}`] = validUrl(link, network);
      }
    } else {
      if (typeof value !== "string" || value.trim().length > limits[key]) throw fail(`Invalid ${key} (maximum ${limits[key]} characters)`);
      update[key] = value.trim();
    }
  }
  if (update.name === "") throw fail("Display name is required");
  if (update.website) update.website = validUrl(update.website, "website");
  if (update.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: update.timezone }); } catch { throw fail("Enter a valid timezone, such as America/Los_Angeles"); } }
  return update;
}
function validUrl(value, field) {
  if (typeof value !== "string" || value.length > 2000) throw fail(`Invalid ${field} URL`);
  if (!value.trim()) return "";
  try { const url = new URL(value.trim()); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error(); return url.href; } catch { throw fail(`${field} must be a complete HTTP or HTTPS URL`); }
}
async function load({ userId, workspaceId }, models = { User, AmbassadorProfile }) {
  if (!userId || !workspaceId) throw fail("Authentication required", 401);
  const user = await models.User.findById(userId).select(selection).lean();
  if (!user) throw fail("Profile not found", 404);
  const legacy = !user.profileUpdatedAt ? await models.AmbassadorProfile.findOne({ userId, workspaceId }).lean() : null;
  return resolveProfile(user, legacy || {});
}
async function save(context, changes, models = { User, AmbassadorProfile }) {
  const update = validate(changes);
  const current = await load(context, models);
  const base = Object.fromEntries(Object.keys(limits).map((key) => [key, current[key]]));
  for (const key of networks) base[`socialProfiles.${key}`] = current.socialProfiles[key];
  await models.User.updateOne({ _id: context.userId }, { $set: { ...base, ...update, profileUpdatedAt: new Date() } }, { runValidators: true });
  return load(context, models);
}
module.exports = { load, save, resolveProfile, validate, selection };
