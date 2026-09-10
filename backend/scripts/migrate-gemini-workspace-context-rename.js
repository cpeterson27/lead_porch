/*
 * Renames WorkspaceConfig.gemini.agentSearchEnabled -> gemini.workspaceContextEnabled.
 *
 * The Gemini Developer API "Agent Search" capability was a prompt-stuffing
 * feature over this app's own MongoDB data, not a real search index — the
 * name was inaccurate and is now reserved for the real Vertex AI Search
 * (Discovery Engine) capability instead. This copies any workspace's existing
 * boolean value across so nobody's real setting is silently reset to the new
 * field's default (false) by the rename, then removes the old key.
 *
 * Dry-run by default; --apply performs the write. Rollback IDs + prior values
 * are recorded before any write, so a later --undo can restore them.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDatabase } = require("../config/database");
const WorkspaceConfig = require("../models/WorkspaceConfig");

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
    const files = fs.readdirSync(reportDir()).filter((name) => name.startsWith("gemini-workspace-context-rename-") && name.endsWith(".rollback.json"));
    const latest = files.sort().at(-1);
    if (!latest) throw new Error("No rollback file found to undo");
    const rollback = JSON.parse(fs.readFileSync(path.join(reportDir(), latest), "utf8"));
    let restored = 0;
    for (const row of rollback.rows) {
      await WorkspaceConfig.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(row._id) },
        { $set: { "gemini.agentSearchEnabled": row.previousValue }, $unset: { "gemini.workspaceContextEnabled": "" } },
      );
      restored += 1;
    }
    console.log(JSON.stringify({ mode: "undo", rollbackFile: latest, restored }, null, 2));
    return;
  }

  const stamp = Date.now();
  const rows = await WorkspaceConfig.collection.find({ "gemini.agentSearchEnabled": { $exists: true } }).project({ workspaceId: 1, "gemini.agentSearchEnabled": 1 }).toArray();
  const report = { mode: apply ? "apply" : "dry-run", generatedAt: new Date().toISOString(), matched: rows.length, modified: 0 };

  if (apply && rows.length) {
    const rollbackPath = path.join(reportDir(), `gemini-workspace-context-rename-${stamp}.rollback.json`);
    fs.writeFileSync(
      rollbackPath,
      `${JSON.stringify({ generatedAt: report.generatedAt, rows: rows.map((row) => ({ _id: String(row._id), previousValue: row.gemini.agentSearchEnabled })) }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    for (const row of rows) {
      await WorkspaceConfig.collection.updateOne(
        { _id: row._id },
        { $set: { "gemini.workspaceContextEnabled": row.gemini.agentSearchEnabled }, $unset: { "gemini.agentSearchEnabled": "" } },
      );
      report.modified += 1;
    }
    report.rollbackPath = rollbackPath;
  }

  const reportPath = path.join(reportDir(), `gemini-workspace-context-rename-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
