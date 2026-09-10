/*
 * Retroactively indexes a workspace's already-approved Knowledge Center
 * notes into Vertex AI Search (Discovery Engine).
 *
 * Going forward, services/discoveryEngineSyncService.js keeps the index in
 * sync automatically on every approve/reject/archive/restore — but a note
 * approved BEFORE a workspace turned Agent Search on was never pushed. This
 * script closes that gap for exactly one workspace at a time (never all
 * workspaces at once — indexing is opt-in and workspace-scoped by design).
 *
 * Dry-run by default; --apply performs the real Discovery Engine writes.
 * Requires --workspace-id and that workspace to already have
 * vertex.agentSearchEnabled = true (use the AI & Acquisition Controls page,
 * or vertexConfigService.save(), to opt in first).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDatabase } = require("../config/database");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const vertexConfigService = require("../services/vertexConfigService");
const discoveryEngineSyncService = require("../services/discoveryEngineSyncService");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function reportDir() {
  const dir = path.resolve(__dirname, "../migration-reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const workspaceIdRaw = option("--workspace-id");
  if (!workspaceIdRaw || !mongoose.isValidObjectId(workspaceIdRaw)) throw new Error("--workspace-id <id> is required and must be a valid workspace ID");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await connectDatabase(process.env.MONGO_URI);

  const workspaceId = new mongoose.Types.ObjectId(workspaceIdRaw);
  const config = await vertexConfigService.get(workspaceId);
  if (!config.agentSearchEnabled) throw new Error("This workspace has not opted into Vertex Agent Search yet — enable it first (Settings > AI & Acquisition Controls, or vertexConfigService.save()), then re-run.");

  const notes = await JarvisMemoryNote.find({ workspaceId, status: "approved" }).select("title content category path approvedAt").lean();
  const stamp = Date.now();
  const report = { mode: apply ? "apply" : "dry-run", generatedAt: new Date().toISOString(), workspaceId: String(workspaceId), matched: notes.length, indexed: 0, failed: 0, failures: [] };

  if (apply) {
    for (const note of notes) {
      const result = await discoveryEngineSyncService.indexApprovedNote(note);
      if (result.synced) report.indexed += 1;
      else { report.failed += 1; report.failures.push({ noteId: String(note._id), reason: result.reason }); }
    }
  }

  const reportPath = path.join(reportDir(), `discovery-engine-backfill-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (apply && report.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
