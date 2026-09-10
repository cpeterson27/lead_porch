const CAPABILITIES = Object.freeze([
  "team.view", "team.manage", "crm.view", "crm.view_assigned", "crm.manage", "crm.manage_assigned",
  "sales.applications.view", "sales.applications.view_assigned", "sales.applications.manage", "sales.applications.manage_assigned",
  "sales.opportunities.view", "sales.opportunities.view_assigned", "sales.opportunities.manage", "sales.opportunities.manage_assigned",
  "coaching.view", "coaching.view_assigned", "coaching.notes.create", "coaching.notes.edit_own", "coaching.handoffs.create", "coaching.assignments.manage",
  "communications.view", "communications.view_assigned", "communications.send_individual", "communications.bulk_manage",
  "referrals.view_own", "referrals.manage", "commissions.view_own", "commissions.manage",
  "ambassadors.view_own", "ambassadors.view", "ambassadors.manage", "community.view_ambassador",
  "calendar.manage_own", "calendar.manage_workspace", "zoom.manage_own", "zoom.manage_workspace",
  "discovery.manage", "outreach.manage", "campaigns.manage", "social.manage", "automations.manage", "analytics.view", "jarvis.manage",
  "integrations.manage", "payments.view", "payments.manage", "workspace.manage", "system.monitor",
]);

const ALL = new Set(CAPABILITIES);
const ROLE_DEFAULTS = Object.freeze({
  owner: CAPABILITIES,
  admin: CAPABILITIES,
  coach: ["coaching.view_assigned", "coaching.notes.create", "coaching.notes.edit_own", "coaching.handoffs.create", "communications.view_assigned", "communications.send_individual", "referrals.view_own", "commissions.view_own", "calendar.manage_own", "zoom.manage_own"],
  ambassador: ["ambassadors.view_own", "referrals.view_own", "commissions.view_own", "community.view_ambassador"],
  closer: ["crm.view_assigned", "crm.manage_assigned", "sales.applications.view_assigned", "sales.applications.manage_assigned", "sales.opportunities.view_assigned", "sales.opportunities.manage_assigned", "communications.view_assigned", "communications.send_individual"],
  member: ["crm.view", "crm.manage", "sales.opportunities.view", "sales.opportunities.manage", "communications.view", "communications.send_individual", "campaigns.manage", "outreach.manage", "discovery.manage", "analytics.view"],
  viewer: ["crm.view", "sales.opportunities.view", "communications.view", "analytics.view"],
});
const OWNER_PROTECTED = Object.freeze(["team.view", "team.manage", "workspace.manage"]);

function validCapabilities(values) { return [...new Set((Array.isArray(values) ? values : []).filter((value) => ALL.has(value)))]; }
function normalizeRoles(membership = {}) {
  const roles = [...new Set([...(Array.isArray(membership.roles) ? membership.roles : []), membership.role].filter((role) => ROLE_DEFAULTS[role]))];
  return roles.length ? roles : ["member"];
}
function roleDefaultsForWorkspace(workspace = {}) {
  const configured = workspace?.rolePermissionTemplates;
  const read = (role) => configured?.get ? configured.get(role) : configured?.[role];
  return Object.fromEntries(Object.keys(ROLE_DEFAULTS).map((role) => [role,
    role === "owner" ? ROLE_DEFAULTS.owner : validCapabilities(read(role) ?? ROLE_DEFAULTS[role]),
  ]));
}
function effectivePermissions(membership = {}, workspace = membership.workspaceId) {
  const roles = normalizeRoles(membership);
  const defaults = roleDefaultsForWorkspace(workspace);
  const result = new Set(roles.flatMap((role) => defaults[role] || []));
  validCapabilities(membership.permissionOverrides?.allow).forEach((item) => result.add(item));
  validCapabilities(membership.permissionOverrides?.deny).forEach((item) => result.delete(item));
  if (roles.includes("owner")) OWNER_PROTECTED.forEach((item) => result.add(item));
  return CAPABILITIES.filter((item) => result.has(item));
}
function hasCapability(auth, capability) { return Boolean(auth?.effectivePermissions?.includes(capability)); }
function hasAnyCapability(auth, capabilities) { return capabilities.some((item) => hasCapability(auth, item)); }
function hasRole(auth, role) { return Array.isArray(auth?.roles) ? auth.roles.includes(role) : auth?.role === role; }
function legacyRoleFor(roles) { return ["owner", "admin", "coach", "closer", "ambassador", "member", "viewer"].find((role) => roles.includes(role)) || "member"; }
function validateMembershipChange({ currentRoles, requestedRoles, requestedStatus, self = false, actorRoles = [], activeOwnerCount = 1 }) {
  const actorIsOwner = actorRoles.includes("owner"), targetIsOwner = currentRoles.includes("owner"), grantsOwner = requestedRoles.includes("owner") && !targetIsOwner;
  if (!actorIsOwner && (targetIsOwner || grantsOwner)) { const error = new Error("Only an owner can grant, change, or deactivate owner access"); error.code = "OWNER_ESCALATION_BLOCKED"; throw error; }
  if (targetIsOwner && (!requestedRoles.includes("owner") || requestedStatus === "suspended") && activeOwnerCount <= 1) { const error = new Error("The last active workspace owner cannot be deactivated or have owner access removed"); error.code = "OWNER_LOCKOUT_BLOCKED"; throw error; }
  if (self && targetIsOwner && requestedStatus === "suspended") { const error = new Error("A workspace owner cannot deactivate their own membership"); error.code = "OWNER_LOCKOUT_BLOCKED"; throw error; }
}

module.exports = { CAPABILITIES, OWNER_PROTECTED, ROLE_DEFAULTS, effectivePermissions, hasAnyCapability, hasCapability, hasRole, legacyRoleFor, normalizeRoles, roleDefaultsForWorkspace, validCapabilities, validateMembershipChange };
