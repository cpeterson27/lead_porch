const User = require("../models/User");
const Workspace = require("../models/Workspace");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const { createAuthContext } = require("../middleware/auth");
const { ACTIVE_ROLES } = require("../authorization/accessPolicy");

/**
 * Background/scheduled jobs (the Discovery poller, auto-enrollment) call
 * the same agentExecutionService.runAgent()/agentToolExecutor.executeTool()
 * every interactive route uses — and both strictly require `auth.workspaceId`
 * to match the workspace being acted on, with no bypass for system callers.
 * There's no HTTP request/session to build that from at that point, so
 * every such call was failing with "Agent workspace context does not match
 * the caller" (confirmed live: every Discovery schedule's lastRunMessage
 * showed exactly this, every run, since these calls always passed auth as
 * null/omitted). Building a real auth context from the schedule's actual
 * creator's real membership — same shape createAuthContext produces for a
 * live login — keeps the job running with that person's real permissions,
 * never a manufactured bypass. Falls back to any active owner/admin in the
 * workspace if the creator's own membership is gone (removed from the
 * workspace since creating the schedule, etc.), so a schedule can't get
 * permanently stuck failing just because its creator left.
 */
async function buildWorkspaceSystemAuth({ workspaceId, userId }) {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) return null;

  let membership = userId
    ? await WorkspaceMembership.findOne({ workspaceId, userId })
    : null;
  if (!membership) {
    membership = await WorkspaceMembership.findOne({ workspaceId, role: { $in: ["owner", "admin"] } }).sort({ role: 1 });
  }
  if (!membership) return null;
  if (!ACTIVE_ROLES.includes(membership.role) && !(membership.roles || []).some((role) => ACTIVE_ROLES.includes(role))) return null;

  const user = await User.findById(membership.userId);
  if (!user || user.status !== "active") return null;

  return createAuthContext({ user, workspace, membership });
}

module.exports = { buildWorkspaceSystemAuth };
