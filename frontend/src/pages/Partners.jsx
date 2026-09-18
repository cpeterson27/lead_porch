import { useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import { configureEventbriteWebhook, createEventbriteAffiliateLink, deletePartner, fetchEventbriteAffiliateSales, fetchEventbriteWebhookStatus, fetchEvents, fetchPartners, linkExistingEventbriteAffiliate, updatePartner, verifyEventbriteAffiliate } from "../services/api.js";
import "./Partners.css";

const blank = { name: "", company: "", email: "", phone: "", type: "affiliate", referralCode: "", referralLink: "", localEventId: "", commissionRate: "", notes: "" };
const slug = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const existingCode = (value) => String(value || "").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export default function Partners() {
  const [partners, setPartners] = useState([]);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [verification, setVerification] = useState({});
  const automaticChecks = useRef(new Set());
  const [sales, setSales] = useState([]);
  const [webhookStatus, setWebhookStatus] = useState(null);
  const [automationBusy, setAutomationBusy] = useState(false);

  const connectedEvents = useMemo(() => events.filter((event) => event.integrations?.eventbrite?.eventId && event.integrations?.eventbrite?.url), [events]);
  const linkPreview = useMemo(() => {
    if (!form || form._id || !form.localEventId || !form.name.trim()) return "";
    const selected = connectedEvents.find((event) => String(event._id) === String(form.localEventId));
    if (!selected?.integrations?.eventbrite?.url) return "";
    try { const url = new URL(selected.integrations.eventbrite.url); url.searchParams.set("aff", slug(form.name)); return url.toString(); } catch { return ""; }
  }, [form, connectedEvents]);
  const load = async () => {
    try {
      const [partnerData, eventData, saleData, webhookData] = await Promise.all([fetchPartners(), fetchEvents(), fetchEventbriteAffiliateSales().catch(() => []), fetchEventbriteWebhookStatus().catch(() => null)]);
      setPartners(Array.isArray(partnerData) ? partnerData : []);
      setEvents(Array.isArray(eventData) ? eventData : []);
      setSales(Array.isArray(saleData) ? saleData : []);
      setWebhookStatus(webhookData);
    } catch { setError("Unable to load affiliate links."); }
  };
  useEffect(() => {
    const initialLoad = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 30000);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(timer); };
  }, []);

  const openNew = () => {
    setError(""); setSuccess("");
    setForm({ ...blank, localEventId: String(connectedEvents[0]?._id || "") });
  };
  const save = async () => {
    try {
      setSaving(true); setError(""); setSuccess("");
      if (!form.name.trim()) return setError("Partner name is required.");
      if (form.linkExisting) {
        if (!form.localEventId) return setError("Choose the Eventbrite bootcamp event.");
        const result = await linkExistingEventbriteAffiliate(form._id, { localEventId: form.localEventId, referralLink: form.referralLink, referralCode: form.referralCode });
        let automatic = false;
        try { const status = await configureEventbriteWebhook(); setWebhookStatus(status); automatic = Boolean(status.configured); } catch { /* Manual verification remains available. */ }
        setSuccess(`${form.name} is now linked to ${result.partner.eventName}. ${result.syncWarning ? `The link was saved, but the first sales refresh needs attention: ${result.syncWarning}` : "Existing attributed sales were checked."} ${automatic ? "Automatic updates are on." : "Turn on automatic updates below if the status still says Needs setup."}`);
      } else if (form._id) await updatePartner(form._id, { name: form.name, company: form.company, email: form.email, phone: form.phone, commissionRate: form.commissionRate, notes: form.notes });
      else {
        if (!form.localEventId) return setError("Choose the Eventbrite bootcamp event.");
        const created = await createEventbriteAffiliateLink({ ...form, referralCode: "" });
        let copied = false;
        try { await navigator.clipboard.writeText(created.referralLink); copied = true; } catch { /* The link remains available on the partner card. */ }
        let automatic = false;
        try { const status = await configureEventbriteWebhook(); setWebhookStatus(status); automatic = Boolean(status.configured); } catch { /* Manual verification remains available. */ }
        setSuccess(`Affiliate link created for ${created.name}${copied ? " and copied to your clipboard" : ". Use Copy affiliate link on the partner card"}. ${automatic ? "Automatic Eventbrite sale updates are on." : "Automatic updates still need setup; use Turn on automatic updates below."}`);
      }
      if (form._id) automaticChecks.current.delete(form._id);
      setForm(null);
      await load();
    } catch (err) { setError(err.response?.data?.message || "Unable to save the affiliate link."); }
    finally { setSaving(false); }
  };
  const copyLink = async (partner) => {
    try { await navigator.clipboard.writeText(partner.referralLink); setSuccess(`${partner.name}’s affiliate link was copied.`); }
    catch { setError("Your browser blocked copying. Open Edit and copy the link manually."); }
  };
  const removePartner = async (partner) => {
    if (!window.confirm(`Delete ${partner.name}? This removes their affiliate link and cannot be undone.`)) return;
    setError(""); setSuccess("");
    try { await deletePartner(partner._id); setPartners((current) => current.filter((item) => item._id !== partner._id)); setSuccess(`${partner.name} was deleted.`); }
    catch (err) { setError(err.response?.data?.message || "Unable to delete this partner."); }
  };
  const openLinkExisting = (partner) => {
    setError(""); setSuccess("");
    setForm({ ...partner, linkExisting: true, localEventId: String(connectedEvents[0]?._id || ""), referralLink: partner.referralLink || "", referralCode: partner.referralCode || slug(partner.name) });
  };
  const updateExistingLink = (value) => {
    let code = form.referralCode;
    try { code = new URL(value).searchParams.get("aff") || code; }
    catch { /* Keep the existing code while the URL is incomplete. */ }
    setForm({ ...form, referralLink: value, referralCode: existingCode(code) });
  };
  const enableAutomation = async () => {
    try {
      setAutomationBusy(true); setError(""); setSuccess("");
      const status = await configureEventbriteWebhook();
      setWebhookStatus(status);
      setSuccess("Automatic Eventbrite affiliate-sale updates are on.");
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || "Automatic Eventbrite updates could not be enabled. Refresh now remains available as a backup.");
      setWebhookStatus(err.response?.data || { configured: false });
    } finally { setAutomationBusy(false); }
  };

  useEffect(() => {
    partners.forEach((partner) => {
      if (partner.trackingProvider !== "eventbrite" || !partner.referralLink || automaticChecks.current.has(partner._id)) return;
      automaticChecks.current.add(partner._id);
      setVerification((current) => ({ ...current, [partner._id]: { checking: true } }));
      verifyEventbriteAffiliate(partner._id)
        .then((result) => {
          setVerification((current) => ({ ...current, [partner._id]: result }));
          if (result.partner) setPartners((current) => current.map((item) => item._id === partner._id ? result.partner : item));
        })
        .catch((err) => setVerification((current) => ({ ...current, [partner._id]: { ...(err.response?.data || {}), checking: false, error: err.response?.data?.message || "Eventbrite could not confirm this connection." } })));
    });
  }, [partners]);

  const money = (amount, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount || 0));
  const commissionDue = (partner) => money(Number(partner.grossRevenue || 0) * Number(partner.commissionRate || 0) / 100, partner.currency);

  return <div className="page-dashboard partners-page">
    <header className="affiliate-hero"><div><span className="affiliate-eyebrow">PARTNER REVENUE</span><h1>Affiliate partnerships</h1><p>Create a unique Eventbrite checkout link, share it with a partner, and see every attributed ticket and commission in one place.</p></div><Button onClick={openNew}>Create affiliate link</Button></header>
    {error ? <p className="form-error">{error}</p> : null}{success ? <p className="partner-success">{success}</p> : null}
    <section className={`affiliate-automation ${webhookStatus?.configured ? "is-on" : "is-off"}`}><div><span>Automatic sale tracking</span><strong>{webhookStatus?.configured ? "On" : "Needs setup"}</strong><p>{webhookStatus?.configured ? `Eventbrite sends new orders to Lead Porch automatically${webhookStatus.lastReceivedAt ? ` · Last update ${new Date(webhookStatus.lastReceivedAt).toLocaleString()}` : ""}.` : "Turn this on once. After that, purchases update the affiliate ledger without pressing Refresh now."}</p></div>{!webhookStatus?.configured ? <Button loading={automationBusy} onClick={enableAutomation}>Turn on automatic updates</Button> : <span className="automation-live">● Listening for Eventbrite orders</span>}</section>
    <section className="affiliate-summary"><div><span>Active links</span><strong>{partners.filter((partner) => partner.trackingProvider === "eventbrite").length}</strong><small>ready to share</small></div><div><span>Attributed tickets</span><strong>{partners.reduce((sum, partner) => sum + Number(partner.ticketsSold || 0), 0)}</strong><small>reported by Eventbrite</small></div><div><span>Attributed revenue</span><strong>{money(partners.reduce((sum, partner) => sum + Number(partner.grossRevenue || 0), 0))}</strong><small>before commissions</small></div><div><span>Commission due</span><strong>{money(partners.reduce((sum, partner) => sum + Number(partner.grossRevenue || 0) * Number(partner.commissionRate || 0) / 100, 0))}</strong><small>across all partners</small></div></section>
    <section className="affiliate-journey" aria-label="Affiliate workflow"><div className="is-current"><b>1</b><span><strong>Create</strong><small>Choose partner and event</small></span></div><div><b>2</b><span><strong>Share</strong><small>Partner uses the exact link</small></span></div><div><b>3</b><span><strong>Monitor</strong><small>Lead Porch checks Eventbrite</small></span></div><div><b>4</b><span><strong>Confirm</strong><small>Attributed purchase appears here</small></span></div></section>
    <section className="affiliate-section-heading"><div><span>YOUR PARTNERS</span><h2>Affiliate links and performance</h2></div><p>Each partner has one clear link and one place to verify it.</p></section>
    <section className="affiliate-partner-list">
      {partners.length ? partners.map((partner) => {
        const linked = partner.trackingProvider === "eventbrite" && partner.referralLink;
        const confirmed = Boolean(partner.lastSaleAt);
        const result = verification[partner._id];
        return <article className="affiliate-partner-card" key={partner._id}>
          <div className="affiliate-card-main">
            <div className="affiliate-card-title"><div className="affiliate-monogram">{String(partner.name || "A").charAt(0).toUpperCase()}</div><div><h3>{partner.name}</h3><p>{partner.company || partner.email || "Independent partner"}</p></div></div>
            <span className={`affiliate-status ${confirmed ? "is-confirmed" : linked ? "is-ready" : "is-unlinked"}`}>{confirmed ? "Sale confirmed" : linked ? "Link ready" : "Action needed"}</span>
            <div className="affiliate-event"><span>EVENT</span><strong>{partner.eventName || "Not connected to Eventbrite"}</strong></div>
            {linked ? <div className="affiliate-link-box"><span>AFFILIATE CHECKOUT LINK</span><code>{partner.referralLink}</code><div><Button size="sm" onClick={() => copyLink(partner)}>Copy affiliate link</Button></div><small>Share this exact link. Lead Porch automatically checks Eventbrite for attributed purchases.</small></div> : <div className="affiliate-unlinked"><strong>Connect {partner.name}’s existing Eventbrite tracking link</strong><p>This partner record cannot track a purchase until it is attached to the bootcamp and its existing Eventbrite link.</p><Button size="sm" onClick={() => openLinkExisting(partner)}>Connect existing link</Button></div>}
          </div>
          <aside className="affiliate-card-results">
            <div className="affiliate-metrics"><div><span>Tickets</span><strong>{partner.ticketsSold || 0}</strong></div><div><span>Revenue</span><strong>{partner.revenue || money(0, partner.currency)}</strong></div><div><span>Commission</span><strong>{commissionDue(partner)}</strong><small>{partner.commissionRate || 0}% rate</small></div></div>
            <div className="affiliate-tracking-summary"><span>TRACKING STATUS</span><strong>{confirmed ? "End-to-end confirmed" : result?.checking ? "Checking Eventbrite automatically…" : result?.checks?.eventbriteSync && webhookStatus?.configured ? "Connected and monitoring" : linked ? "Connection needs attention" : "Not connected"}</strong><p>{confirmed ? `Eventbrite returned a completed purchase attributed to ${partner.name} on ${new Date(partner.lastSaleAt).toLocaleString()}.` : result?.checking ? "Lead Porch is checking the event, affiliate code, sales feed, and automatic order updates now." : result?.checks?.eventbriteSync && webhookStatus?.configured ? `Everything is connected. No completed Eventbrite order attributed to ${partner.name} has appeared yet.` : result?.error || (linked ? "Lead Porch could not confirm every Eventbrite connection check." : "Connect the existing Eventbrite link before sharing.")}</p></div>
            {result?.checks ? <div className={`affiliate-check-result ${result.checks.eventbriteSync && webhookStatus?.configured ? "is-pass" : "is-fail"}`}><strong>{result.checks.eventbriteSync && webhookStatus?.configured ? "Automatic monitoring is active" : "Tracking needs attention"}</strong><ul><li className={result.checks.validEventbriteLink ? "pass" : "fail"}>Eventbrite checkout link</li><li className={result.checks.trackingCodeMatches ? "pass" : "fail"}>Unique partner code</li><li className={result.checks.sameEventPage ? "pass" : "fail"}>Correct bootcamp checkout</li><li className={result.checks.eventConnected ? "pass" : "fail"}>Bootcamp event connection</li><li className={result.checks.eventbriteSync ? "pass" : "fail"}>Eventbrite sales connection</li><li className={webhookStatus?.configured ? "pass" : "fail"}>Automatic purchase updates</li></ul></div> : null}
            <div className="affiliate-card-actions"><Button size="sm" variant="outline" onClick={() => { setError(""); setForm({ ...partner, linkExisting: false, localEventId: String(partner.localEventId || "") }); }}>Edit partner</Button><Button size="sm" variant="outline" className="btn-danger" onClick={() => removePartner(partner)}>Delete</Button></div>
            <small className="affiliate-last-sync">{partner.lastSyncedAt ? `Last checked ${new Date(partner.lastSyncedAt).toLocaleString()}` : "Not checked yet"}</small>
          </aside>
        </article>;
      }) : <div className="affiliate-empty"><strong>No affiliate links yet</strong><p>Create a link for your first partner. Lead Porch generates the tracking code automatically.</p><Button onClick={openNew}>Create first affiliate link</Button></div>}
    </section>
    <DashboardCard title="Recent affiliate purchases">{sales.length ? <div className="affiliate-sales-list">{sales.map((sale) => <article key={sale._id}><div><strong>{sale.partnerId?.name || sale.affiliateCode}</strong><span>{sale.buyerName || sale.buyerEmail || "Eventbrite attendee"}</span></div><div><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: sale.currency || "USD" }).format(Number(sale.grossRevenue || 0))}</strong><span>{sale.ticketClassName || "Ticket"} · {sale.status}</span></div><time>{sale.purchasedAt ? new Date(sale.purchasedAt).toLocaleString() : "Synced from Eventbrite"}</time></article>)}</div> : <div className="table-state table-state--empty">No affiliate purchases have been attributed yet. New purchases will appear here automatically when tracking is on.</div>}</DashboardCard>
    <Modal isOpen={Boolean(form)} onClose={() => setForm(null)} title={form?.linkExisting ? `Link ${form.name} to Eventbrite` : form?._id ? "Edit affiliate" : "Create Eventbrite affiliate link"} footer={<><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save} loading={saving}>{form?.linkExisting ? "Link and check sales" : form?._id ? "Save changes" : "Create and copy link"}</Button></>}>
      {form ? <div className="affiliate-form">{error ? <p className="form-error">{error}</p> : null}
        {!form._id || form.linkExisting ? <label><span>Bootcamp event</span><select value={form.localEventId} onChange={(event) => setForm({ ...form, localEventId: event.target.value })}><option value="">Choose an Eventbrite event</option>{connectedEvents.map((event) => <option key={event._id} value={event._id}>{event.name}</option>)}</select><small>{connectedEvents.length ? "Only events already connected to Eventbrite appear here." : "Connect or import the bootcamp event on the Events page first."}</small></label> : <div className="affiliate-readonly"><span>Event</span><strong>{form.eventName || "Eventbrite event"}</strong></div>}
        {form.linkExisting ? <div className="affiliate-link-help"><strong>{form.name}’s link was created in Eventbrite</strong><span>Paste that exact tracking link below. Lead Porch will read the affiliate code after <b>aff=</b>, attach it to this record, check previous sales, and track future purchases automatically.</span></div> : null}
        <div className="affiliate-form-grid"><label><span>Affiliate name</span><input value={form.name || ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>Company</span><input value={form.company || ""} onChange={(event) => setForm({ ...form, company: event.target.value })} /></label><label><span>Email</span><input type="email" value={form.email || ""} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label><span>Commission %</span><input type="number" min="0" max="100" step="0.1" value={form.commissionRate ?? ""} onChange={(event) => setForm({ ...form, commissionRate: event.target.value })} /></label></div>
        {!form._id ? <div className="generated-link-preview"><span>Lead Porch will create</span><strong>{linkPreview || "Enter the affiliate name to preview the Eventbrite link"}</strong><small>The unique tracking identifier is generated automatically. You only need to copy and share the finished link.</small></div> : form.linkExisting ? <><label><span>Existing Eventbrite tracking link</span><textarea placeholder="Paste the complete Eventbrite link here" value={form.referralLink || ""} onChange={(event) => updateExistingLink(event.target.value)} /><small>The complete URL is best. Lead Porch extracts its tracking information automatically.</small></label><details className="tracking-code-fallback"><summary>I only have the Eventbrite tracking name</summary><label><span>Exact Eventbrite tracking name</span><input value={form.referralCode || ""} onChange={(event) => setForm({ ...form, referralCode: existingCode(event.target.value) })} /><small>Use this only when the full Eventbrite link is unavailable, including its exact capitalization.</small></label></details></> : <div className="affiliate-readonly"><span>Tracking</span><strong>{form.lastSaleAt ? "Confirmed by an Eventbrite purchase" : "Link ready—awaiting its first attributed purchase"}</strong></div>}
        {form.referralLink && !form.linkExisting ? <label><span>Affiliate link</span><textarea readOnly value={form.referralLink} /></label> : null}
        <label><span>Internal notes</span><textarea value={form.notes || ""} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      </div> : null}
    </Modal>
  </div>;
}
