const axios = require("axios");

// Real, ground-truth send health pulled directly from Resend — the same
// data manually queried by hand throughout tonight's deliverability
// investigation, now available on demand instead of requiring a live check
// each time. Account-wide (Resend's email list has no campaign-level
// filter), bucketed by day so a daily trend is visible at a glance.
async function getDeliverabilityHistory({ days = 7, maxPages = 10 } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const emails = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = { limit: 100 };
    if (cursor) params.after = cursor;
    const response = await axios.get("https://api.resend.com/emails", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params,
      timeout: 15000,
    });
    const rows = response.data?.data || [];
    if (!rows.length) break;
    let hitCutoff = false;
    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      if (createdAt < since) {
        hitCutoff = true;
        continue;
      }
      emails.push(row);
    }
    if (hitCutoff || !response.data?.has_more) break;
    cursor = rows[rows.length - 1].id;
  }
  const byDay = new Map();
  for (const email of emails) {
    const date = new Date(email.created_at).toISOString().slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, { date, total: 0, delivered: 0, clicked: 0, bounced: 0, complained: 0, other: 0 });
    const bucket = byDay.get(date);
    bucket.total += 1;
    if (email.last_event === "delivered") bucket.delivered += 1;
    else if (email.last_event === "clicked") bucket.clicked += 1;
    else if (email.last_event === "bounced") bucket.bounced += 1;
    else if (email.last_event === "complained") bucket.complained += 1;
    else bucket.other += 1;
  }
  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totals = daily.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      delivered: sum.delivered + row.delivered,
      clicked: sum.clicked + row.clicked,
      bounced: sum.bounced + row.bounced,
      complained: sum.complained + row.complained,
    }),
    { total: 0, delivered: 0, clicked: 0, bounced: 0, complained: 0 },
  );
  return {
    daily,
    totals,
    bounceRate: totals.total ? Math.round((totals.bounced / totals.total) * 1000) / 10 : 0,
    complaintRate: totals.total ? Math.round((totals.complained / totals.total) * 1000) / 10 : 0,
    clickRate: totals.total ? Math.round((totals.clicked / totals.total) * 1000) / 10 : 0,
    fetchedAt: new Date(),
  };
}

module.exports = { getDeliverabilityHistory };
