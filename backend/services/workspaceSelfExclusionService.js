/**
 * Server-side self-match exclusion for Discovery People Research: before
 * ANY provider result (Vertex, OpenAI Web Search, PDL Person Search,
 * Apollo People Search) is saved to the GroundingResearchResult review
 * queue, exclude a result that is actually the workspace owner, an
 * employee/team member, the workspace's own business, or a match on the
 * workspace's own domain(s) or an approved program's brand name — never a
 * real prospect.
 *
 * Every signal is derived from THIS workspace's own current, real data —
 * active WorkspaceMembership rows and their User records, WorkspaceConfig,
 * the Workspace document, and approved Offers & Programs notes — never
 * hardcoded to any one workspace or business name. For Ellie's Coaching
 * this naturally resolves to excluding the owner's real name, "Ellie's
 * Coaching"/its legal business name, and its own website domain, because
 * that is what its own workspace data actually contains — not because
 * those strings are special-cased here.
 *
 * Matching is deliberately EXACT (normalized: trimmed, case-insensitive)
 * on name/email/domain/business-name equality — never fuzzy or substring
 * matching — so a legitimate prospect who merely shares a first name, or
 * works at a similarly-but-not-identically-named company, is never
 * wrongly excluded.
 */
const WorkspaceMembership = require("../models/WorkspaceMembership");
const User = require("../models/User");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const Workspace = require("../models/Workspace");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function domainOf(email) {
  const at = String(email || "").split("@")[1];
  return at ? at.trim().toLowerCase() : "";
}

function hostOf(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Web-grounded results (Vertex/OpenAI) often report a person's name with
 * role/company context appended by the model's own summarization — e.g.
 * "Ellie Baxter, Founder of Ellie's Coaching" or "Ellie Baxter (Ellie's
 * Coaching)" — never a bare name the way PDL/Apollo's structured fields do.
 * This strips that trailing context at the first clear separator so the
 * EXACT-match check below still catches it. It never fuzzily shortens an
 * unrelated name: with no separator present, the string is returned as-is.
 */
function stripTrailingContext(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cut = raw.search(/\s*[,(|]|\s[-–—]\s|\bat\b/i);
  return (cut > 0 ? raw.slice(0, cut) : raw).trim();
}

/**
 * Reads a Mongoose model's own schema-declared defaults for the given
 * field names — used when a workspace has no WorkspaceConfig document yet,
 * so a still-unconfigured workspace's business name (e.g. this app's own
 * "Ellie's Coaching" default) is never silently missing from self-match
 * signals just because no config row was ever saved. Generic: reads
 * whatever the schema actually declares, never a hardcoded business name.
 */
function schemaDefault(Model, field, workspaceId) {
  try {
    return new Model({ workspaceId }).get(field);
  } catch {
    return "";
  }
}

/**
 * Gathers this workspace's own identity signals: active team members'
 * names/emails/email-domains, the workspace's configured business
 * name(s) and website domain, and approved Offers & Programs brand names.
 */
async function getWorkspaceSelfSignals({ workspaceId }, dependencies = {}) {
  const MembershipModel = dependencies.WorkspaceMembership || WorkspaceMembership;
  const UserModel = dependencies.User || User;
  const ConfigModel = dependencies.WorkspaceConfig || WorkspaceConfig;
  const WorkspaceModel = dependencies.Workspace || Workspace;
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;

  const memberships = await MembershipModel.find({ workspaceId, status: "active" }).select("userId").lean();
  const userIds = [...new Set(memberships.map((m) => String(m.userId)).filter(Boolean))];
  const users = userIds.length ? await UserModel.find({ _id: { $in: userIds } }).select("name email").lean() : [];

  const [config, workspace, programNotes] = await Promise.all([
    ConfigModel.findOne({ workspaceId, key: "primary" }).select("workspaceName legalBusinessName websiteUrl").lean(),
    WorkspaceModel.findById(workspaceId).select("name publicHosts").lean(),
    NoteModel.find({ workspaceId, category: "offers-programs", status: "approved" }).select("title").lean(),
  ]);

  const names = new Set(users.map((u) => normalize(u.name)).filter(Boolean));
  const emails = new Set(users.map((u) => normalize(u.email)).filter(Boolean));
  const domains = new Set(users.map((u) => domainOf(u.email)).filter(Boolean));
  // A workspace with no saved WorkspaceConfig document (never configured,
  // or configured before this row existed) still has real schema-default
  // values for workspaceName/legalBusinessName — falling back to those
  // rather than leaving this signal empty is what made this app's own
  // default business name ("Ellie's Coaching") invisible to self-match
  // checks for a workspace that never explicitly saved a config row.
  const websiteUrl = config?.websiteUrl || "";
  const workspaceName = config?.workspaceName || (config ? "" : schemaDefault(ConfigModel, "workspaceName", workspaceId));
  const legalBusinessName = config?.legalBusinessName || (config ? "" : schemaDefault(ConfigModel, "legalBusinessName", workspaceId));
  const websiteHost = hostOf(websiteUrl);
  if (websiteHost) domains.add(websiteHost);
  for (const host of (workspace?.publicHosts || [])) {
    const hostName = hostOf(host);
    if (hostName) domains.add(hostName);
  }

  const businessNames = new Set(
    [workspaceName, legalBusinessName, workspace?.name, ...programNotes.map((note) => note.title)]
      .map(normalize)
      .filter(Boolean),
  );

  return { names, emails, domains, businessNames };
}

/**
 * Checks one candidate result against the workspace's self signals.
 * Returns { isSelf, reasons } — reasons is a short, human-readable list
 * for logging/reporting, never exposed to any provider or third party.
 */
function isSelfMatch(candidate = {}, signals) {
  if (!signals) return { isSelf: false, reasons: [] };
  const reasons = [];
  const name = normalize(candidate.name);
  // Web-grounded (Vertex/OpenAI) candidates often carry role/company context
  // appended to the name itself (e.g. "Ellie Baxter, Founder of Ellie's
  // Coaching") — an exact match against the bare name alone would miss
  // this, so the trailing-context-stripped form is checked too. Still an
  // EXACT set-membership check, never substring/fuzzy — a name that merely
  // shares a first name or contains a signal name as a substring never
  // matches.
  const strippedName = normalize(stripTrailingContext(candidate.name));
  const email = normalize(candidate.email);
  const emailDomain = domainOf(candidate.email);
  const orgDomain = normalize(candidate.organizationDomain);
  const orgName = normalize(candidate.organizationName);

  if (name && signals.names.has(name)) reasons.push("name matches a workspace team member");
  else if (strippedName && strippedName !== name && signals.names.has(strippedName)) reasons.push("name matches a workspace team member");
  if (email && signals.emails.has(email)) reasons.push("email matches a workspace team member");
  if (emailDomain && signals.domains.has(emailDomain)) reasons.push("email domain matches the workspace's own domain");
  if (orgDomain && signals.domains.has(orgDomain)) reasons.push("organization domain matches the workspace's own domain");
  if (orgName && signals.businessNames.has(orgName)) reasons.push("organization name matches the workspace's own business");
  if (name && signals.businessNames.has(name)) reasons.push("name matches the workspace's own business");
  else if (strippedName && strippedName !== name && signals.businessNames.has(strippedName)) reasons.push("name matches the workspace's own business");

  return { isSelf: reasons.length > 0, reasons };
}

/**
 * Filters a list of candidates (any shape with name/email/organizationName/
 * organizationDomain fields), returning the kept list and a count of how
 * many were excluded as self-matches — for reporting back to the owner.
 */
function excludeSelfMatches(candidates, signals) {
  const kept = [];
  const excluded = [];
  for (const candidate of candidates) {
    const { isSelf } = isSelfMatch(candidate, signals);
    if (isSelf) excluded.push(candidate);
    else kept.push(candidate);
  }
  return { kept, excludedCount: excluded.length, excluded };
}

module.exports = { getWorkspaceSelfSignals, isSelfMatch, excludeSelfMatches };
