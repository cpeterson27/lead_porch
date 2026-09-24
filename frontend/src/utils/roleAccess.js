export function hasPermission(session, permission) { return Boolean(session?.effectivePermissions?.includes(permission)); }
export function hasAnyPermission(session, permissions) { return permissions.some((item) => hasPermission(session, item)); }
export function hasRole(session, role) { return (session?.roles || [session?.role]).includes(role); }
export function isSocialConnectionOnly(session) {
  const permissions = session?.effectivePermissions || [];
  return permissions.length === 1 && permissions[0] === "social.manage" && !hasRole(session, "owner") && !hasRole(session, "admin");
}
export function isCoachOnly(session) { return hasRole(session, "coach") && !hasRole(session, "closer") && !hasRole(session, "owner") && !hasRole(session, "admin"); }
export function isAmbassadorOnly(session) { return hasRole(session, "ambassador") && !hasRole(session, "coach") && !hasRole(session, "closer") && !hasRole(session, "owner") && !hasRole(session, "admin") && !hasRole(session, "member") && !hasRole(session, "viewer"); }
export function canManageCoaching(session) { return hasPermission(session, "coaching.view"); }
// Permission-based, not role-based: owner/admin already carry
// coaching.view_assigned via their full capability set, so this no longer
// requires the raw "coach" checkbox on top of that just to see the portal
// — that extra checkbox was the actual friction, since admin should see
// everything without having to also flag themselves as every individual
// role.
export function canUseCoachPortal(session) { return hasPermission(session, "coaching.view_assigned"); }
export function canUseSales(session) { return hasAnyPermission(session, ["crm.view", "crm.view_assigned", "sales.opportunities.view", "sales.opportunities.view_assigned"]); }
export function privateHomeForRole(session) { return isCoachOnly(session) ? "/coach" : isAmbassadorOnly(session) ? "/ambassador" : "/command-center"; }
