const ContentBrief = require("../models/ContentBrief");
const SocialConnection = require("../models/SocialConnection");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

let timer = null;
let running = false;
let messagesRunning = false;

// Meta will not deliver a live webhook for a comment on this connection type
// (confirmed live: a Page-linked Instagram Business Account has no working
// subscribed_apps edge on either graph host, and Facebook's own Page "feed"
// field — despite a valid, confirmed subscription — has never once
// delivered an event for this workspace either). Short of Meta's own App
// Review changing that, the only way a comment reaches Lead Porch is asking
// for it directly, so this polls every recently-published post's comments
// on a timer instead of requiring someone to click "Sync from Meta" — same
// idea as the campaign-send sweep, applied to comments.
async function runDueCommentSync() {
  if (running) return { checked: 0, synced: 0 };
  running = true;
  try {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const items = await ContentBrief.find({
      type: "social",
      status: { $in: ["published", "partially_published"] },
      "social.publications.publishedAt": { $gte: since },
    }).select("workspaceId social.publications");
    const metaRecentPostService = require("./metaRecentPostService");
    let checked = 0, synced = 0;
    for (const item of items) {
      const targets = (item.social?.publications || []).filter(
        (row) => ["facebook", "instagram"].includes(row.provider) && row.providerPostId && row.assetId && row.publishedAt >= since,
      );
      if (!targets.length) continue;
      await runWithWorkspace(item.workspaceId, async () => {
        for (const row of targets) {
          checked += 1;
          try {
            const result = await metaRecentPostService.syncPostComments({
              workspaceId: item.workspaceId,
              provider: row.provider,
              assetId: row.assetId,
              postId: row.providerPostId,
            });
            synced += result?.synced || 0;
          } catch (error) {
            console.error("Comment sync poll failed for a post:", { contentBriefId: String(item._id), provider: row.provider, message: error.message });
          }
        }
      });
    }
    return { checked, synced };
  } finally {
    running = false;
  }
}

// Same reasoning as comments (see above), applied to DMs — Meta's webhook
// has never once delivered a message event for this workspace either, but a
// direct pull of the Page's own conversations does return real data, so
// this asks for it on the same timer instead of waiting on a webhook that
// will not arrive. Runs across every connected Meta/Instagram connection in
// every workspace, not just ones with recent posts (a DM has no post to
// anchor a "recently published" window to).
async function runDueMessageSync() {
  if (messagesRunning) return { checked: 0, synced: 0 };
  messagesRunning = true;
  try {
    const connections = await SocialConnection.find({
      provider: { $in: ["meta", "instagram"] },
      status: "connected",
    }).select("workspaceId provider assets selectedAssetIds");
    let checked = 0, synced = 0;
    for (const connection of connections) {
      const targets = (connection.assets || []).filter(
        (asset) =>
          ["facebook_page", "instagram_business"].includes(asset.type) &&
          (connection.selectedAssetIds || []).map(String).includes(String(asset.id)),
      );
      if (!targets.length) continue;
      await runWithWorkspace(connection.workspaceId, async () => {
        const metaRecentPostService = require("./metaRecentPostService");
        for (const asset of targets) {
          const provider = asset.type === "instagram_business" ? "instagram" : "facebook";
          checked += 1;
          try {
            const result = await metaRecentPostService.syncPageMessages({
              workspaceId: connection.workspaceId,
              provider,
              assetId: asset.id,
            });
            synced += result?.synced || 0;
          } catch (error) {
            console.error("Message sync poll failed for an account:", { connectionId: String(connection._id), provider, message: error.message });
          }
        }
      });
    }
    return { checked, synced };
  } finally {
    messagesRunning = false;
  }
}

async function runDueSocialSync() {
  const [comments, messages] = await Promise.all([runDueCommentSync(), runDueMessageSync()]);
  return { comments, messages };
}

function startCommentSyncRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  // This runs across every workspace on one shared timer, so it stays more
  // conservative than the per-workspace foreground fast-poll (inbox/sync,
  // 5s, only while someone has the Inbox open) — that's what actually
  // makes an active test feel fast; this background tick is the safety net
  // for everyone else, the rest of the time.
  const interval = Math.max(30000, Number(process.env.COMMENT_SYNC_INTERVAL_MS) || 30000);
  timer = setInterval(() => runDueSocialSync().catch((error) => console.error("Comment sync runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}

function stopCommentSyncRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runDueCommentSync, runDueMessageSync, runDueSocialSync, startCommentSyncRunner, stopCommentSyncRunner };
