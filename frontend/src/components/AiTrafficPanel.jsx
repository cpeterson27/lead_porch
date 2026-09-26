import { useEffect, useState } from "react";
import { fetchAiTraffic } from "../services/api.js";
import "./AiTrafficPanel.css";

const number = (value) => Number(value || 0).toLocaleString();
const sourceNames = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", gemini: "Gemini", copilot: "Microsoft Copilot", grok: "Grok" };
const eventNames = { application_submitted: "Application submitted", discovery_call_booked: "Discovery call booked", guide_requested: "Guide requested" };
export default function AiTrafficPanel() {
  const [days, setDays] = useState(30);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetchAiTraffic(days).then((result) => { if (active) { setData(result); setError(""); } })
      .catch(() => { if (active) setError("AI traffic could not be refreshed. Try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") { setLoading(true); setRefresh((value) => value + 1); } }, 60000);
    return () => window.clearInterval(timer);
  }, []);
  const totals = data?.totals;
  const peak = Math.max(1, ...(data?.trend || []).map((row) => row.visits));
  return <section id="ai-search-traffic" className="ai-traffic-panel" aria-labelledby="ai-traffic-title" aria-busy={loading}>
    <header className="ai-traffic-header">
      <div><p className="ai-traffic-eyebrow">Website discovery</p><h2 id="ai-traffic-title">AI search traffic</h2><p>See which AI tools send people to your website—and what those visits lead to.</p></div>
      <div className="ai-traffic-controls"><label>Period<select value={days} onChange={(event) => { setLoading(true); setDays(Number(event.target.value)); }}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label><button type="button" disabled={loading} onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    </header>
    {error ? <p role="alert" className="ai-traffic-error">{error}{data ? " Showing the last successful result." : ""}</p> : null}
    {!data ? <p role="status">{loading ? "Loading AI search traffic…" : "No report is available yet."}</p> : <>
      <p className="ai-traffic-updated">Updated {new Date(data.generatedAt).toLocaleTimeString()} · Refreshes every minute while this page is open · Dates use UTC</p>
      <div className="ai-traffic-metrics">
        {[["AI visits", totals.visits, "Identifiable browser sessions"], ["Applications", totals.applications, "Successfully submitted"], ["Discovery calls", totals.bookings, "Successfully booked"], ["Guide requests", totals.guides, "Successfully received"]].map(([title, value, note]) => <div key={title}><span>{title}</span><strong>{number(value)}</strong><small>{note}</small></div>)}
      </div>
      {totals.visits === 0 ? <div className="ai-traffic-empty"><strong>Ready to collect AI referrals</strong><p>No identifiable AI website visits in this period yet. Asking about Ellie’s Coaching inside an AI tool does not create a website visit. New visits appear here when a source tag or referring website identifies an AI tool. Historical visits are not backfilled.</p></div> : null}
      <div className="ai-traffic-chart" role="img" aria-label={`Daily AI visits over ${data.days} days. ${number(totals.visits)} visits in total.`}>
        <div className="ai-traffic-bars">{data.trend.map((row) => <div key={row.day} title={`${row.day}: ${row.visits} visits, ${row.inquiries} applications and bookings`}><i style={{ height: `${row.visits / peak * 100}%` }} /></div>)}</div>
        <div className="ai-traffic-chart-labels"><span>{data.trend[0]?.day}</span><span>Daily visits</span><span>{data.trend.at(-1)?.day}</span></div>
      </div>
      <div className="ai-traffic-table-wrap"><table><caption>Visits and conversions by AI tool</caption><thead><tr><th scope="col">Source</th><th scope="col">Visits</th><th scope="col">Page views</th><th scope="col">Applications</th><th scope="col">Calls booked</th><th scope="col">Guide requests</th></tr></thead><tbody>{data.sources.map((row) => <tr key={row.source}><th scope="row">{row.label}</th><td>{number(row.visits)}</td><td>{number(row.pageViews)}</td><td>{number(row.applications)}</td><td>{number(row.bookings)}</td><td>{number(row.guides)}</td></tr>)}</tbody></table></div>
      <div className="ai-traffic-detail-grid">
        <div className="ai-traffic-table-wrap"><table><caption>Where AI visitors arrive</caption><thead><tr><th>Landing page</th><th>Visits</th><th>Applications + calls</th></tr></thead><tbody>{data.landingPages.length ? data.landingPages.map((row) => <tr key={row.path}><td><span className="ai-traffic-path">{row.path}</span></td><td>{row.visits}</td><td>{row.inquiries}</td></tr>) : <tr><td colSpan={3}>Landing pages will appear after the first identifiable visit.</td></tr>}</tbody></table></div>
        <div className="ai-traffic-table-wrap"><table><caption>Recent AI conversions</caption><thead><tr><th>Received</th><th>Source</th><th>Action</th></tr></thead><tbody>{data.recentInquiries.length ? data.recentInquiries.map((row, index) => <tr key={`${row.createdAt}-${index}`}><td>{new Date(row.createdAt).toLocaleString()}</td><td>{sourceNames[row.source] || row.source}<small>{row.evidence === "utm" ? "Source tag" : "Referring website"}</small></td><td>{eventNames[row.kind] || row.kind}</td></tr>) : <tr><td colSpan={3}>Submitted applications, bookings, and guide requests will appear here.</td></tr>}</tbody></table></div>
      </div>
      <p className="ai-traffic-note">This measures identifiable referral traffic, not AI mentions or rankings. This referral tracker cannot reliably separate Google AI Overviews or Bing AI answers from ordinary search without source information. Provider impressions and citation reports appear separately in Search & AI visibility above. Visits use anonymous sessions that expire after 30 minutes of inactivity; counts are not unique people. Tracking respects browser privacy signals. Records are retained for 90 days.</p>
    </>}
  </section>;
}
