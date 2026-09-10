const express = require("express");
const Workspace = require("../models/Workspace");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const SocialConnection = require("../models/SocialConnection");
const { requirePlatformOwner } = require("../middleware/auth");
const workspaceProvisioningService = require("../services/workspaceProvisioningService");
const platformConfigService = require("../services/platformConfigService");

const router = express.Router();
const PROVIDERS = ["facebook", "instagram", "linkedin", "tiktok", "x"];

function connectionSummary(provider, connections) {
  const candidates =
    provider === "facebook"
      ? connections.filter((row) => row.provider === "meta")
      : provider === "instagram"
        ? connections.filter((row) =>
            ["meta", "instagram"].includes(row.provider),
          )
        : connections.filter((row) => row.provider === provider);
  const assetType = {
    facebook: "facebook_page",
    instagram: "instagram_business",
    linkedin: "linkedin_organization",
    tiktok: "tiktok_account",
    x: "x_account",
  }[provider];
  for (const connection of candidates) {
    const selected = new Set((connection.selectedAssetIds || []).map(String));
    const asset = (connection.assets || []).find(
      (item) => item.type === assetType && selected.has(String(item.id)),
    );
    if (!asset) continue;
    const healthy =
      connection.status === "connected" &&
      connection.authorization?.valid !== false &&
      (!connection.expiresAt || new Date(connection.expiresAt) > new Date());
    return {
      provider,
      status: healthy ? "connected" : "needs_attention",
      accountName:
        asset.name || asset.username || connection.providerAccount?.name || "",
      connectedAt: connection.connectedAt || null,
      lastVerifiedAt:
        connection.lastVerifiedAt ||
        connection.authorization?.verifiedAt ||
        null,
    };
  }
  const failed = candidates.find(
    (row) =>
      ["failed", "expired"].includes(row.status) ||
      row.authorization?.valid === false,
  );
  return {
    provider,
    status: failed ? "needs_attention" : "not_connected",
    accountName: "",
    connectedAt: failed?.connectedAt || null,
    lastVerifiedAt: failed?.lastVerifiedAt || null,
  };
}

router.get("/businesses", requirePlatformOwner, async (_req, res) => {
  const [workspaces, memberships, connections] = await Promise.all([
    Workspace.find({})
      .select("name slug status publicHosts createdAt updatedAt")
      .sort({ name: 1 })
      .lean(),
    WorkspaceMembership.find({})
      .select("workspaceId userId role roles status")
      .populate("userId", "name email")
      .lean(),
    SocialConnection.find({})
      .select(
        "workspaceId provider status authorization providerAccount assets selectedAssetIds connectedAt lastVerifiedAt expiresAt",
      )
      .lean(),
  ]);
  const configs = await Promise.all(
    workspaces.map((workspace) =>
      WorkspaceConfig.collection.findOne({
        workspaceId: workspace._id,
        key: "primary",
      }),
    ),
  );
  const data = workspaces.map((workspace) => {
    const config = configs.find(
      (item) => String(item?.workspaceId) === String(workspace._id),
    );
    const team = memberships.filter(
      (item) => String(item.workspaceId) === String(workspace._id),
    );
    const owner = team.find(
      (item) =>
        item.status === "active" &&
        [...(item.roles || []), item.role].includes("owner"),
    );
    const social = connections.filter(
      (item) => String(item.workspaceId) === String(workspace._id),
    );
    const domainReady = workspace.publicHosts?.length
      ? "configured"
      : "missing";
    const senderEmailReady = config?.invitationIdentity?.senderEmail
      ? "configured"
      : "missing";
    const websiteReady =
      config?.publicSite?.published === true ? "published" : "draft";
    return {
      id: workspace._id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      publicHosts: workspace.publicHosts || [],
      readiness: {
        domain: domainReady,
        senderEmail: senderEmailReady,
        website: websiteReady,
        inviteReady:
          domainReady === "configured" && senderEmailReady === "configured",
        launchReady:
          domainReady === "configured" &&
          senderEmailReady === "configured" &&
          websiteReady === "published",
      },
      owner: owner?.userId
        ? { name: owner.userId.name, email: owner.userId.email }
        : null,
      teamMemberCount: team.filter((item) => item.status === "active").length,
      social: PROVIDERS.map((provider) => connectionSummary(provider, social)),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  });
  res.json({ businesses: data });
});

router.post("/workspaces", requirePlatformOwner, async (req, res) => {
  try {
    const workspace = await workspaceProvisioningService.createWorkspace({
      name: req.body?.name,
      slug: req.body?.slug,
      ownerUserId: req.auth.userId,
      publicHosts: req.body?.publicHosts,
    });
    return res.status(201).json({
      workspace: {
        id: workspace._id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status,
        publicHosts: workspace.publicHosts || [],
        billingStatus: workspace.billingStatus,
      },
    });
  } catch (error) {
    return res.status(error.code === "WORKSPACE_SLUG_EXISTS" ? 409 : 400).json({
      error: error.message || "Unable to create workspace",
      code: error.code,
    });
  }
});

router.patch(
  "/workspaces/:id/public-hosts",
  requirePlatformOwner,
  async (req, res) => {
    try {
      const publicHosts = workspaceProvisioningService.normalizePublicHosts(
        req.body?.publicHosts,
      );
      const workspace = await Workspace.findByIdAndUpdate(
        req.params.id,
        { $set: { publicHosts } },
        { new: true, runValidators: true },
      )
        .select("name slug status publicHosts")
        .lean();
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      return res.json({ workspace });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 400).json({
        error:
          error.code === 11000
            ? "One of those public domains is already assigned to another workspace"
            : error.message || "Unable to update public domains",
      });
    }
  },
);

/**
 * Global provider availability — layered on top of the server environment
 * variables that hold real credentials and master enable flags. This can
 * only turn an already-configured provider OFF platform-wide; it can never
 * turn on a provider with no real credentials.
 */
router.get("/providers", requirePlatformOwner, async (_req, res) => {
  res.json({ success: true, data: await platformConfigService.get() });
});
router.patch("/providers", requirePlatformOwner, async (req, res) => {
  try {
    res.json({ success: true, data: await platformConfigService.save(req.body || {}, req.auth?.user?._id || req.auth?.userId || null) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Provider availability could not be saved", code: "PLATFORM_PROVIDERS_SAVE_FAILED" });
  }
});

module.exports = router;
module.exports.connectionSummary = connectionSummary;
