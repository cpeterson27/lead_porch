const assert = require("node:assert/strict");
const fs = require("node:fs");
const service = require("./services/workspaceMemberService");

const membership = (values) => ({ role: values.roles[0], status: "suspended", ...values, async deleteOne() { this.deleted = true; } });

async function run() {
  const routeSource = fs.readFileSync("./routes/workspace.js", "utf8");
  const deleteMembersRoute = routeSource.indexOf('router.delete(\n  "/members/:id"');
  assert.notEqual(deleteMembersRoute, -1, "DELETE /members/:id route not found");
  const deleteMembersRouteBody = routeSource.slice(deleteMembersRoute, deleteMembersRoute + 200);
  assert(deleteMembersRouteBody.includes('requireRole("owner", "admin")'), "Removal must require an Owner/Admin role");
  assert(deleteMembersRouteBody.includes('requireCapability("team.manage")'), "Removal must require existing team capability");
  let target = membership({ _id: "member-1", workspaceId: "workspace-1", userId: "user-1", roles: ["member"] });
  let revokedFilter, revokedUpdate;
  const models = {
    WorkspaceMembership: {
      findOne: async (filter) => filter.workspaceId === target.workspaceId && filter._id === target._id ? target : null,
      countDocuments: async () => 1,
    },
    WorkspaceInvitation: { updateMany: async (filter, update) => { revokedFilter = filter; revokedUpdate = update; } },
  };

  const removed = await service.removeMember({ workspaceId: "workspace-1", membershipId: "member-1", actorUserId: "admin-1", actorRoles: ["admin"] }, models);
  assert.equal(removed.id, "member-1"); assert.equal(target.deleted, true);
  assert.deepEqual(revokedFilter.status.$in, ["draft", "ready", "pending", "expired"]); assert.equal(revokedUpdate.$set.status, "revoked");
  assert.equal(revokedFilter.workspaceId, "workspace-1"); assert.equal(revokedFilter.userId, "user-1");

  target = membership({ _id: "self", workspaceId: "workspace-1", userId: "admin-1", roles: ["admin"] });
  await assert.rejects(service.removeMember({ workspaceId: "workspace-1", membershipId: "self", actorUserId: "admin-1", actorRoles: ["admin"] }, models), (error) => error.code === "MEMBER_SELF_REMOVAL_BLOCKED");

  target = membership({ _id: "owner", workspaceId: "workspace-1", userId: "owner-1", roles: ["owner"], status: "active" });
  await assert.rejects(service.removeMember({ workspaceId: "workspace-1", membershipId: "owner", actorUserId: "admin-1", actorRoles: ["admin"] }, models), (error) => error.code === "OWNER_ESCALATION_BLOCKED");
  await assert.rejects(service.removeMember({ workspaceId: "workspace-1", membershipId: "owner", actorUserId: "owner-2", actorRoles: ["owner"] }, models), (error) => error.code === "OWNER_LOCKOUT_BLOCKED");

  await assert.rejects(service.removeMember({ workspaceId: "foreign-workspace", membershipId: "owner", actorUserId: "owner-2", actorRoles: ["owner"] }, models), (error) => error.code === "MEMBER_NOT_FOUND");
  target = membership({ _id: "already-removed", workspaceId: "workspace-1", userId: "user-2", roles: ["viewer"] }); target.deleted = true;
  models.WorkspaceMembership.findOne = async () => null;
  await assert.rejects(service.removeMember({ workspaceId: "workspace-1", membershipId: "already-removed", actorUserId: "admin-1", actorRoles: ["admin"] }, models), (error) => error.code === "MEMBER_NOT_FOUND");

  console.log("Workspace-scoped removal, invitation revocation, self protection, Owner protection, and repeated-delete safety passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
