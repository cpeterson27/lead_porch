import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import { Drawer, PageHeader, StatusBadge, Toolbar } from "../components/WorkspaceUI.jsx";
import useAuth from "../context/useAuth.js";
import { hasPermission } from "../utils/roleAccess.js";
import { assignCloser, createOpportunity, fetchCloserQueue, fetchCompanies, fetchContacts, fetchOpportunities, fetchWorkspaceMembers, recordCloserActivity, savePipelineStages, updateOpportunity } from "../services/api.js";
import SalesAgentPanel from "../components/SalesAgentPanel.jsx";
import "./Opportunities.css";
import "./SalesAgentPanel.css";

const emptyDraft = { name: "", value: "", organizationId: "", primaryContactId: "", expectedCloseAt: "", nextAction: "", nextActionAt: "" };
const money = (value, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value || 0);

export default function Opportunities() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { session } = useAuth();
  const [mode, setMode] = useState(searchParams.get("view") === "closer-queue" || !hasPermission(session, "sales.opportunities.view") ? "queue" : "pipeline");
  const [queueView, setQueueView] = useState("my"), [queueItems, setQueueItems] = useState([]), [queueLoading, setQueueLoading] = useState(false);
  const [activityLead, setActivityLead] = useState(null), [activityDraft, setActivityDraft] = useState({ outcome: "attempted_contact", channel: "", notes: "", nextFollowUpAt: "" });
  const [detailLead, setDetailLead] = useState(null);
  const [assignLead, setAssignLead] = useState(null), [closers, setClosers] = useState([]), [closerUserId, setCloserUserId] = useState("");
  const [opportunities, setOpportunities] = useState([]);
  const [stages, setStages] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(searchParams.get("create") === "opportunity");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [stageDrafts, setStageDrafts] = useState([]);
  const [saving, setSaving] = useState(false);
  const canAssign = hasPermission(session, "sales.opportunities.manage");

  async function loadQueue() { try { setQueueLoading(true); const result = await fetchCloserQueue({ view: queueView }); setQueueItems(result.data || []); setError(""); } catch (requestError) { setError(requestError.response?.data?.error || "Unable to load Closer Queue."); } finally { setQueueLoading(false); } }
  useEffect(() => { if (mode !== "queue") return; let active = true; const timer = window.setTimeout(() => fetchCloserQueue({ view: queueView }).then((result) => { if (active) { setQueueItems(result.data || []); setError(""); } }).catch((requestError) => { if (active) setError(requestError.response?.data?.error || "Unable to load Closer Queue."); }).finally(() => { if (active) setQueueLoading(false); }), 0); return () => { active = false; window.clearTimeout(timer); }; }, [mode, queueView]);
  useEffect(() => { if (mode !== "queue" || !canAssign) return; fetchWorkspaceMembers().then((result) => setClosers((result.members || []).filter((member) => member.status === "active" && member.roles?.includes("closer")))).catch(() => {}); }, [mode, canAssign]);
  async function submitActivity(event) { event.preventDefault(); try { setSaving(true); await recordCloserActivity(activityLead.opportunityId, activityDraft); setActivityLead(null); await loadQueue(); } catch (requestError) { setError(requestError.response?.data?.error || "Unable to record activity."); } finally { setSaving(false); } }
  async function submitAssignment(event) { event.preventDefault(); try { setSaving(true); await assignCloser(assignLead.opportunityId, { closerUserId, reason: "Assigned from Closer Queue" }); setAssignLead(null); await loadQueue(); } catch (requestError) { setError(requestError.response?.data?.error || "Unable to assign Closer."); } finally { setSaving(false); } }

  async function load() {
    try {
      const result = await fetchOpportunities({ search, owner: mineOnly ? "mine" : "" });
      setOpportunities(result.data || []); setStages(result.stages || []); setError("");
    } catch { setError("Unable to load opportunities."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => fetchOpportunities({ search, owner: mineOnly ? "mine" : "" }).then((result) => { if (active) { setOpportunities(result.data || []); setStages(result.stages || []); setError(""); } }).catch(() => { if (active) setError("Unable to load opportunities."); }).finally(() => { if (active) setLoading(false); }), 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, mineOnly]);

  useEffect(() => {
    if (!createOpen) return;
    Promise.all([fetchCompanies({ limit: 100 }), fetchContacts({ limit: 100 })]).then(([companyResult, contactResult]) => { setCompanies(companyResult.data || []); setContacts(contactResult.data || []); }).catch(() => setError("Unable to load CRM record choices."));
  }, [createOpen]);

  const totals = useMemo(() => {
    const open = opportunities.filter((item) => !["won", "lost"].includes(stages.find((stage) => stage.key === item.stageKey)?.terminal));
    return { value: open.reduce((sum, item) => sum + (item.value || 0), 0), weighted: open.reduce((sum, item) => sum + (item.value || 0) * (item.probability || 0) / 100, 0), due: open.filter((item) => item.nextActionAt && new Date(item.nextActionAt) <= new Date()).length };
  }, [opportunities, stages]);

  async function moveOpportunity(id, stageKey) {
    const current = opportunities.find((item) => item._id === id);
    if (!current || current.stageKey === stageKey) return;
    const target = stages.find((stage) => stage.key === stageKey);
    const lostReason = target?.terminal === "lost" ? window.prompt("Why was this opportunity lost? This will be saved to its CRM history.", current.lostReason || "") : "";
    if (target?.terminal === "lost" && !lostReason?.trim()) return;
    setOpportunities((items) => items.map((item) => item._id === id ? { ...item, stageKey, probability: target?.probability || 0, lostReason } : item));
    try { await updateOpportunity(id, { stageKey, ...(lostReason ? { lostReason } : {}) }); await load(); }
    catch { setError("The stage change could not be saved."); await load(); }
  }

  async function submitOpportunity(event) {
    event.preventDefault();
    try { setSaving(true); await createOpportunity(draft); setDraft(emptyDraft); setCreateOpen(false); await load(); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to create opportunity."); }
    finally { setSaving(false); }
  }

  async function saveOpportunity(event) {
    event.preventDefault();
    try { setSaving(true); await updateOpportunity(selected._id, selected); setSelected(null); await load(); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to update opportunity."); }
    finally { setSaving(false); }
  }

  async function saveStages() {
    try { setSaving(true); const result = await savePipelineStages(stageDrafts); setStages(result.data || []); setSettingsOpen(false); await load(); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to save stages."); }
    finally { setSaving(false); }
  }

  if (mode === "queue") return <div className="page-dashboard opportunities-page closer-queue-page">
    <PageHeader eyebrow="Revenue CRM" title="Closer Queue" description="Prioritized assigned leads, their evidence, and the next human action." actions={<Button variant="outline" onClick={() => setMode("pipeline")}>Sales Pipeline</Button>} />
    <nav className="closer-queue-tabs" aria-label="Closer Queue views">{[["my", "My Leads"], ["high", "High Priority"], ["follow_up", "Needs Follow-up"], ["new", "New / Uncontacted"], ["application", "Application Submitted"], ...(canAssign ? [["all", "All Assigned"]] : [])].map(([key, label]) => <button type="button" className={queueView === key ? "is-active" : ""} onClick={() => { setQueueLoading(true); setQueueView(key); }} key={key}>{label}</button>)}</nav>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {queueLoading ? <p>Loading Closer Queue…</p> : !queueItems.length ? <p className="pipeline-empty">No assigned leads need attention in this view.</p> : <section className="closer-queue-list">{queueItems.map((item) => <article className="closer-lead-card" key={item.opportunityId}>
      <header><div><strong>{item.contactName}</strong><span>{item.organization?.name || item.source}</span></div><StatusBadge tone={["urgent", "high"].includes(item.qualification?.priority) ? "warning" : "info"}>{item.qualification?.priority || "review"} · {item.qualification?.score || 0}</StatusBadge></header>
      <div className="closer-lead-facts"><p><b>Why qualified</b>{item.qualification?.reasons?.slice(0, 2).join(" ") || "Needs human review."}</p><p><b>Next action</b>{item.nextAction || item.qualification?.recommendedNextAction || "Choose a follow-up action."}</p><p><b>Stage</b>{item.opportunityStage}{item.application ? ` · Application ${item.application.status}` : ""}</p><p><b>Last activity</b>{item.lastActivity ? `${item.lastActivity.title} · ${new Date(item.lastActivity.occurredAt).toLocaleDateString()}` : "No activity yet"}</p></div>
      {item.flags?.length ? <div className="closer-flags">{item.flags.map((flag) => <span key={flag}>{flag.replaceAll("_", " ")}</span>)}</div> : null}
      <footer><Button size="sm" variant="outline" onClick={() => setDetailLead(item)}>Open lead</Button><Button size="sm" onClick={() => setActivityLead(item)}>Record activity</Button>{canAssign ? <Button size="sm" variant="ghost" onClick={() => { setAssignLead(item); setCloserUserId(String(item.assignedCloserId || "")); }}>Assign</Button> : null}</footer>
    </article>)}</section>}
    <Drawer isOpen={Boolean(detailLead)} onClose={() => setDetailLead(null)} title={detailLead?.contactName || "Lead details"} description={detailLead?.contactEmail || detailLead?.organization?.name || detailLead?.source || "Assigned opportunity"}>{detailLead ? <div className="closer-lead-detail"><section><h3>Qualification</h3><p>{detailLead.qualification?.likelyNeed || "No likely need has been recorded."}</p><ul>{(detailLead.qualification?.reasons || []).map((reason) => <li key={reason}>{reason}</li>)}</ul></section><section><h3>Evidence</h3><ul>{(detailLead.qualification?.observedEvidence || []).map((evidence) => <li key={evidence.url}><a href={evidence.url} target="_blank" rel="noreferrer">{evidence.label || "Review public source"}</a></li>)}</ul></section><section><h3>Opportunity</h3><p>Stage: {detailLead.opportunityStage}</p><p>Assigned to: {detailLead.assignedCloser?.name || detailLead.assignedCloser?.email || "Unassigned"}</p><p>Next follow-up: {detailLead.nextFollowUpAt ? new Date(detailLead.nextFollowUpAt).toLocaleString() : "Not scheduled"}</p></section>{detailLead.qualification?.warnings?.length ? <section><h3>Review warnings</h3><ul>{detailLead.qualification.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section> : null}<SalesAgentPanel key={detailLead.opportunityId} opportunityId={detailLead.opportunityId} /></div> : null}</Drawer>
    <Drawer isOpen={Boolean(activityLead)} onClose={() => setActivityLead(null)} title="Record sales activity" description={activityLead?.contactName || "Assigned lead"}><form className="opportunity-form" onSubmit={submitActivity}><label>Outcome<select value={activityDraft.outcome} onChange={(event) => setActivityDraft({ ...activityDraft, outcome: event.target.value })}>{["attempted_contact", "called", "emailed", "social_outreach", "conversation", "follow_up_scheduled", "no_response", "application_sent", "application_received", "meeting_booked", "qualified", "disqualified"].map((value) => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Channel<input value={activityDraft.channel} onChange={(event) => setActivityDraft({ ...activityDraft, channel: event.target.value })} placeholder="Phone, email, social" /></label><label className="span-2">Notes<textarea rows="4" value={activityDraft.notes} onChange={(event) => setActivityDraft({ ...activityDraft, notes: event.target.value })} /></label><label>Next follow-up<input type="datetime-local" value={activityDraft.nextFollowUpAt} onChange={(event) => setActivityDraft({ ...activityDraft, nextFollowUpAt: event.target.value })} /></label><Button loading={saving}>Save activity</Button></form></Drawer>
    <Drawer isOpen={Boolean(assignLead)} onClose={() => setAssignLead(null)} title="Assign Closer" description={assignLead?.contactName || "Qualified lead"}><form className="opportunity-form" onSubmit={submitAssignment}><label className="span-2">Closer<select required value={closerUserId} onChange={(event) => setCloserUserId(event.target.value)}><option value="">Choose an active Closer</option>{closers.map((member) => <option value={member.userId || member.id} key={member.id}>{member.name} · {member.email}</option>)}</select></label><Button loading={saving}>Assign lead</Button></form></Drawer>
  </div>;

  return <div className="page-dashboard opportunities-page">
    <PageHeader eyebrow="Revenue CRM" title="Sales Pipeline" description="Track qualified prospects as they move toward a purchase. Program applications can create opportunities here; existing contacts stay linked." actions={<><Button variant="outline" onClick={() => { setQueueLoading(true); setMode("queue"); }}>Closer Queue</Button><Button variant="outline" onClick={() => { setStageDrafts(stages.map((stage) => ({ ...stage }))); setSettingsOpen(true); }}>Configure stages</Button><Button onClick={() => setCreateOpen(true)}>New opportunity</Button></>} />
    <section className="pipeline-summary"><div><span>Open pipeline</span><strong>{money(totals.value)}</strong></div><div><span>Weighted forecast</span><strong>{money(totals.weighted)}</strong></div><div><span>Open opportunities</span><strong>{opportunities.filter((item) => !["won", "lost"].includes(stages.find((stage) => stage.key === item.stageKey)?.terminal)).length}</strong></div><div className={totals.due ? "needs-attention" : ""}><span>Actions due</span><strong>{totals.due}</strong></div></section>
    <Toolbar search={<input aria-label="Search opportunities" placeholder="Search opportunities" value={search} onChange={(event) => setSearch(event.target.value)} />} filters={<label><input type="checkbox" checked={mineOnly} onChange={(event) => setMineOnly(event.target.checked)} /> My opportunities</label>} results={loading ? "Loading pipeline" : `${opportunities.length} opportunities`} actions={<Button variant="outline" onClick={() => navigate("/crm/companies")}>Companies</Button>} />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!loading && !opportunities.length && <p className="pipeline-empty">No sales opportunities match this view. New program applications can enter this pipeline automatically. You can also use New opportunity to link an existing qualified contact.</p>}
    {!loading ? <section className="opportunity-board" aria-label="Opportunity pipeline">{stages.map((stage) => {
      const items = opportunities.filter((item) => item.stageKey === stage.key);
      return <div className="opportunity-column" key={stage.key} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveOpportunity(event.dataTransfer.getData("text/opportunity-id"), stage.key)}>
        <header><div><StatusBadge tone={stage.color}>{stage.label}</StatusBadge><small>{stage.probability}% probability</small></div><strong>{money(items.reduce((sum, item) => sum + (item.value || 0), 0))}</strong><span>{items.length}</span></header>
        <div>{items.length ? items.map((item) => <article key={item._id} draggable role="button" tabIndex="0" aria-label={`Open ${item.name}`} onDragStart={(event) => event.dataTransfer.setData("text/opportunity-id", item._id)} onClick={() => setSelected({ ...item })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected({ ...item }); } }}>
          <strong>{item.name}</strong><span>{item.organizationId?.name || item.primaryContactId?.name || "Unlinked opportunity"}</span><b>{money(item.value, item.currency)}</b>{item.nextAction ? <p>{item.nextAction}</p> : <p className="muted">Next action needed</p>}<footer><small>{item.expectedCloseAt ? `Close ${new Date(item.expectedCloseAt).toLocaleDateString()}` : "No close date"}</small><em>{item.ownerId?.name || item.ownerId?.email || "You"}</em></footer>
          <label onClick={(event) => event.stopPropagation()}>Move<select value={item.stageKey} onChange={(event) => moveOpportunity(item._id, event.target.value)}>{stages.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}</select></label>
        </article>) : <p>Drop opportunities here</p>}</div>
      </div>;
    })}</section> : null}

    <Drawer isOpen={createOpen} onClose={() => setCreateOpen(false)} title="New opportunity" description="Connect revenue work to real CRM relationships."><OpportunityForm draft={draft} setDraft={setDraft} companies={companies} contacts={contacts} stages={stages} onSubmit={submitOpportunity} saving={saving} submitLabel="Create opportunity" /></Drawer>
    <Drawer isOpen={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.name || "Opportunity"} description={selected?.organizationId?.name || selected?.primaryContactId?.name || "Revenue opportunity"}>{selected ? <><OpportunityForm draft={selected} setDraft={setSelected} stages={stages} onSubmit={saveOpportunity} saving={saving} submitLabel="Save changes" editing /><SalesAgentPanel key={selected._id} opportunityId={selected._id} /></> : null}</Drawer>
    <Drawer isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} title="Pipeline stages" description="Rename, reorder, and tune forecast probability."><div className="stage-settings">{stageDrafts.map((stage, index) => <div key={stage.key}><span>{index + 1}</span><input aria-label={`Stage ${index + 1} name`} value={stage.label} onChange={(event) => setStageDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><label>Probability<input type="number" min="0" max="100" value={stage.probability} onChange={(event) => setStageDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, probability: event.target.value } : item))} /></label><Button size="sm" variant="ghost" disabled={index === 0} onClick={() => setStageDrafts((items) => { const copy = [...items]; [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]]; return copy; })}>↑</Button><Button size="sm" variant="ghost" disabled={index === stageDrafts.length - 1} onClick={() => setStageDrafts((items) => { const copy = [...items]; [copy[index + 1], copy[index]] = [copy[index], copy[index + 1]]; return copy; })}>↓</Button></div>)}<Button loading={saving} onClick={saveStages}>Save pipeline</Button></div></Drawer>
  </div>;
}

function OpportunityForm({ draft, setDraft, companies = [], contacts = [], stages, onSubmit, saving, submitLabel, editing = false }) {
  return <form className="opportunity-form" onSubmit={onSubmit}>
    <label className="span-2">Opportunity name<input required maxLength="180" value={draft.name || ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
    <label>Stage<select value={draft.stageKey || stages[0]?.key || ""} onChange={(event) => setDraft({ ...draft, stageKey: event.target.value })}>{stages.map((stage) => <option value={stage.key} key={stage.key}>{stage.label}</option>)}</select></label>
    <label>Value<input type="number" min="0" step="1" value={draft.value || ""} onChange={(event) => setDraft({ ...draft, value: event.target.value })} /></label>
    {!editing ? <><label>Company<select value={draft.organizationId || ""} onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })}><option value="">No company selected</option>{companies.map((company) => <option value={company._id} key={company._id}>{company.name}</option>)}</select></label><label>Primary contact<select value={draft.primaryContactId || ""} onChange={(event) => setDraft({ ...draft, primaryContactId: event.target.value })}><option value="">No contact selected</option>{contacts.map((contact) => <option value={contact._id} key={contact._id}>{contact.name} · {contact.company || "No company"}</option>)}</select></label></> : null}
    <label>Expected close<input type="date" value={draft.expectedCloseAt?.slice?.(0, 10) || ""} onChange={(event) => setDraft({ ...draft, expectedCloseAt: event.target.value })} /></label>
    <label>Next-action date<input type="date" value={draft.nextActionAt?.slice?.(0, 10) || ""} onChange={(event) => setDraft({ ...draft, nextActionAt: event.target.value })} /></label>
    <label className="span-2">Next action<input maxLength="500" value={draft.nextAction || ""} onChange={(event) => setDraft({ ...draft, nextAction: event.target.value })} placeholder="Specific owner action, not a vague reminder" /></label>
    {editing && stages.find((stage) => stage.key === draft.stageKey)?.terminal === "lost" ? <label className="span-2">Loss reason<textarea required rows="3" value={draft.lostReason || ""} onChange={(event) => setDraft({ ...draft, lostReason: event.target.value })} /></label> : null}
    <label className="span-2">Notes<textarea rows="4" maxLength="5000" value={draft.notes || ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
    <Button loading={saving}>{submitLabel}</Button>
  </form>;
}
