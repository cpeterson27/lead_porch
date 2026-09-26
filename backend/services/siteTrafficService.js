const mongoose = require("mongoose");
const SiteTrafficEvent = require("../models/SiteTrafficEvent");
const { normalizeAttribution, publicPath, SOURCE_LABELS } = require("./siteAttribution");
async function recordEvent({ workspaceId, eventId, kind, pagePath, attribution, normalizedAttribution, programId }, model = SiteTrafficEvent) {
  const normalized = normalizedAttribution || normalizeAttribution(attribution);
  const path = publicPath(pagePath);
  if (!normalized || normalized.sourceGroup !== "ai" || !path || !/^[a-z0-9:-]{16,160}$/i.test(eventId || "")) return false;
  try {
    await model.updateOne({ workspaceId, eventId }, { $setOnInsert: { workspaceId, eventId, kind, ...normalized, pagePath: path, programId: mongoose.isValidObjectId(programId) ? programId : null, createdAt: new Date() } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  return true;
}
async function recordConversion(args) {
  try { return await recordEvent(args); } catch (error) {
    // Analytics must never reject an otherwise successful application or booking.
    console.error("Site conversion analytics unavailable", { kind: args.kind, error: error.name });
    return false;
  }
}
const countKind = (kind) => ({ $sum: { $cond: [{ $eq: ["$kind", kind] }, 1, 0] } });
async function report(workspaceId, days = 30, model = SiteTrafficEvent, now = new Date()) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - days + 1);
  const [result] = await model.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), sourceGroup: "ai", createdAt: { $gte: start, $lte: now } } },
    { $facet: {
      sources: [
        { $group: { _id: { source: "$source", session: "$sessionId" }, pageViews: countKind("page_view"), applications: countKind("application_submitted"), bookings: countKind("discovery_call_booked"), guides: countKind("guide_requested") } },
        { $group: { _id: "$_id.source", visits: { $sum: 1 }, pageViews: { $sum: "$pageViews" }, applications: { $sum: "$applications" }, bookings: { $sum: "$bookings" }, guides: { $sum: "$guides" }, convertedVisits: { $sum: { $cond: [{ $gt: [{ $add: ["$applications", "$bookings"] }, 0] }, 1, 0] } } } },
        { $sort: { visits: -1, _id: 1 } },
      ],
      trend: [
        { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, session: "$sessionId" }, inquiries: { $sum: { $cond: [{ $in: ["$kind", ["application_submitted", "discovery_call_booked"]] }, 1, 0] } } } },
        { $group: { _id: "$_id.day", visits: { $sum: 1 }, inquiries: { $sum: "$inquiries" } } },
        { $sort: { _id: 1 } },
      ],
      landingPages: [
        { $group: { _id: { path: "$landingPath", session: "$sessionId" }, inquiries: { $sum: { $cond: [{ $in: ["$kind", ["application_submitted", "discovery_call_booked"]] }, 1, 0] } } } },
        { $group: { _id: "$_id.path", visits: { $sum: 1 }, inquiries: { $sum: "$inquiries" } } },
        { $sort: { visits: -1, _id: 1 } }, { $limit: 15 },
      ],
      recentInquiries: [{ $match: { kind: { $ne: "page_view" } } }, { $sort: { createdAt: -1 } }, { $limit: 20 }, { $project: { _id: 0, kind: 1, source: 1, evidence: 1, landingPath: 1, createdAt: 1 } }],
    } },
  ]);
  const sources = Object.entries(SOURCE_LABELS).map(([source, label]) => {
    const row = result?.sources?.find((r) => r._id === source) || {};
    return { source, label, visits: row.visits || 0, pageViews: row.pageViews || 0, applications: row.applications || 0, bookings: row.bookings || 0, guides: row.guides || 0, convertedVisits: row.convertedVisits || 0 };
  }).sort((a, b) => b.visits - a.visits);
  const totals = sources.reduce((acc, row) => { for (const key of Object.keys(acc)) acc[key] += row[key]; return acc; }, { visits: 0, pageViews: 0, applications: 0, bookings: 0, guides: 0, convertedVisits: 0 });
  const trend = Array.from({ length: days }, (_, i) => { const date = new Date(start); date.setUTCDate(date.getUTCDate() + i); const day = date.toISOString().slice(0, 10); const row = result?.trend?.find((r) => r._id === day); return { day, visits: row?.visits || 0, inquiries: row?.inquiries || 0 }; });
  return { days, generatedAt: now.toISOString(), startDate: start.toISOString(), totals, sources, trend, landingPages: (result?.landingPages || []).map((r) => ({ path: r._id, visits: r.visits, inquiries: r.inquiries })), recentInquiries: result?.recentInquiries || [] };
}
module.exports = { recordEvent, recordConversion, report };
