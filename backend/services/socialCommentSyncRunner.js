const ContentBrief = require("../models/ContentBrief");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

let timer = null;
let running = false;

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

function startCommentSyncRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(60000, Number(process.env.COMMENT_SYNC_INTERVAL_MS) || 3 * 60000);
  timer = setInterval(() => runDueCommentSync().catch((error) => console.error("Comment sync runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}

function stopCommentSyncRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runDueCommentSync, startCommentSyncRunner, stopCommentSyncRunner };
