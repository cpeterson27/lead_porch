require("dotenv").config();
const mongoose = require("mongoose");
const Contact = require("./models/Contact");
const MonitorActivity = require("./models/MonitorActivity");
const IntentSignal = require("./models/IntentSignal");
const retention = require("./services/monitorRetentionService");

async function main() {
  const execute = process.argv.includes("--execute");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceIds = [...new Set([...(await MonitorActivity.distinct("workspaceId")), ...(await IntentSignal.distinct("workspaceId"))].filter(Boolean).map(String))];
  const contactsBefore = await Contact.countDocuments({});
  const results = [];
  for (const workspaceId of workspaceIds) {
    // eslint-disable-next-line no-await-in-loop
    const item = execute ? await retention.execute({ workspaceId, confirmation: retention.CONFIRMATION }) : await retention.plan({ workspaceId });
    results.push({ workspaceId, ...item, filters: undefined });
  }
  const contactsAfter = await Contact.countDocuments({});
  const dbStats = await mongoose.connection.db.command({ dbStats: 1, scale: 1024 * 1024 });
  console.log(JSON.stringify({ mode: execute ? "execute" : "preview", contactsBefore, contactsAfter, contactsChanged: contactsAfter - contactsBefore, dbSizeMb: { data: dbStats.dataSize, storage: dbStats.storageSize, indexes: dbStats.indexSize }, results }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
