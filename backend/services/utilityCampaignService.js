/**
 * Auto-managed "bookkeeping" campaigns for sends that don't belong to a
 * real, owner-created campaign — a sequence, a one-off send from a
 * contact's page, or a newsletter issue. Outreach.campaignId is a required
 * field (it's how metrics/history are grouped), but sender identity,
 * compliance footer, and unsubscribe handling all come from WorkspaceConfig
 * (see services/email.js), never from the campaign itself — so there is no
 * real reason to ask the owner to pick an existing campaign for these.
 * campaignKind:"program" is used specifically because it's the one
 * campaignKind that doesn't require a real Event (see models/Campaign.js).
 */
const Campaign = require("../models/Campaign");

async function findOrCreateUtilityCampaign({ workspaceId, name, purpose, reuse = true }) {
  if (reuse) {
    const existing = await Campaign.findOne({ workspaceId, name, campaignPurpose: purpose }).select("_id");
    if (existing) return existing._id;
  }
  const created = await Campaign.create({ workspaceId, name, campaignKind: "program", campaignPurpose: purpose });
  return created._id;
}

module.exports = { findOrCreateUtilityCampaign };
