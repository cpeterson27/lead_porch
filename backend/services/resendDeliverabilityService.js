const axios = require("axios");

// Same business-day convention as the send-window guard in email.js — a
// day boundary at UTC midnight (the old behavior) falls at 4-5pm Pacific,
// so a batch sent Tuesday evening was bucketed and labeled "Wednesday" for
// anyone in a US timezone. Confirmed live: this alone made an account-wide
// count that was actually correct look wrong next to a viewer's own sense
// of "what went out yesterday."
function businessDateKey(isoString) {
  const timezone = process.env.EMAIL_SEND_WINDOW_TIMEZONE || "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(isoString));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Real, ground-truth send health pulled directly from Resend — the same
// data manually queried by hand throughout tonight's deliverability
// investigation, now available on demand instead of requiring a live check
// each time. Account-wide (Resend's email list has no campaign-level
// filter), bucketed by day so a daily trend is visible at a glance.
async function getDeliverabilityHistory({ days = 7, maxPages = 60 } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const emails = [];
  let cursor = null;
  // Confirmed live: at this account's real send volume (2,300+ emails in a
  // real 7-day window), the previous maxPages:10 cap (1,000 emails) was
  // silently truncating to under one day's worth of the most recent sends,
  // then mislabeling that partial slice "Sent (7 days)" with no indication
  // anything was cut off. maxPages is raised to comfortably cover today's
  // real volume, but volume can grow past any fixed cap again — so
  // `truncated` below self-detects that case (maxPages reached before the
  // real cutoff date), and the caller must relabel the window honestly
  // instead of trusting the requested `days` blindly.
  let truncated = false;
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
    if (hitCutoff) break;
    if (!response.data?.has_more) break;
    if (page === maxPages - 1) truncated = true;
    cursor = rows[rows.length - 1].id;
  }
  const byDay = new Map();
  for (const email of emails) {
    const date = businessDateKey(email.created_at);
    if (!byDay.has(date)) byDay.set(date, { date, total: 0, delivered: 0, clicked: 0, bounced: 0, complained: 0, other: 0 });
    const bucket = byDay.get(date);
    bucket.total += 1;
    // last_event is a single terminal-ish state, not a checklist — an email
    // that was delivered and later clicked reports last_event "clicked", not
    // "delivered". Counting only literal last_event==="delivered" as
    // "delivered" was undercounting: every clicked email (which must have
    // been delivered first) was excluded from the delivered bucket. Anything
    // that reached the inbox (i.e. didn't bounce/complain/fail) counts as
    // delivered here, matching what "delivered" actually means to Ellie.
    if (["bounced", "complained"].includes(email.last_event)) {
      if (email.last_event === "bounced") bucket.bounced += 1;
      else bucket.complained += 1;
    } else if (email.last_event === "failed") {
      bucket.other += 1;
    } else {
      bucket.delivered += 1;
      if (email.last_event === "clicked") bucket.clicked += 1;
    }
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
    // The window actually covered, which can be narrower than the
    // requested `days` when truncated is true — the frontend must label
    // using this, not the requested window, to stay honest about what's
    // actually being shown.
    requestedDays: days,
    truncated,
    coveredFrom: daily.length ? daily[daily.length - 1].date : null,
    coveredTo: daily.length ? daily[0].date : null,
    fetchedAt: new Date(),
  };
}

module.exports = { getDeliverabilityHistory };
