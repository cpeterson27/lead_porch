/*
 * Backfill for the Knowledge Center draft/review workflow.
 *
 * Before this feature existed, every JarvisMemoryNote was implicitly usable
 * by agents. retrieveCloudNotes() now only ever serves status: "approved"
 * notes, so any pre-existing note that predates the `status` field would
 * silently vanish from agent memory once this deploys, unless backfilled.
 *
 * This grandfathers exactly those legacy notes as "approved" (preserving
 * the exact behavior they already had), and only those: it never touches a
 * note that has been through the real review flow, because a genuinely
 * approved note always has approvedByUserId + approvedAt set, while a
 * grandfathered one does not.
 *
 * Dry-run by default; --apply performs the write. Rollback IDs are recorded
 * before any write, so a later --undo can restore the pre-migration state.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDatabase } = require("../config/database");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");

const LEGACY_FILTER = { status: { $exists: false } };
const GRANDFATHERED_FILTER = { status: "approved", approvedByUserId: null, approvedAt: null };

function reportDir() {
  const dir = path.resolve(__dirname, "../migration-reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const undo = process.argv.includes("--undo");
  if (apply && undo) throw new Error("Use --apply OR --undo, not both");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await connectDatabase(process.env.MONGO_URI);

  if (undo) {
    const ids = await JarvisMemoryNote.find(GRANDFATHERED_FILTER).select("_id").lean();
    const report = { mode: "undo", generatedAt: new Date().toISOString(), matched: ids.length, modified: 0 };
    if (ids.length) {
      const result = await JarvisMemoryNote.collection.updateMany(
        { _id: { $in: ids.map((row) => row._id) } },
        { $unset: { status: "" } },
      );
      report.modified = result.modifiedCount;
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const stamp = Date.now();
  const legacyIds = await JarvisMemoryNote.find(LEGACY_FILTER).select("_id workspaceId path source").lean();
  const report = {
    mode: apply ? "apply" : "dry-run",
    generatedAt: new Date().toISOString(),
    matched: legacyIds.length,
    modified: 0,
  };

  if (apply && legacyIds.length) {
    const rollbackPath = path.join(reportDir(), `jarvis-memory-note-status-backfill-${stamp}.rollback.json`);
    fs.writeFileSync(
      rollbackPath,
      `${JSON.stringify({ generatedAt: report.generatedAt, ids: legacyIds.map((row) => String(row._id)) }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const result = await JarvisMemoryNote.collection.updateMany(
      { _id: { $in: legacyIds.map((row) => row._id) } },
      { $set: { status: "approved" } },
    );
    report.modified = result.modifiedCount;
    report.rollbackPath = rollbackPath;
  }

  const reportPath = path.join(reportDir(), `jarvis-memory-note-status-backfill-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
