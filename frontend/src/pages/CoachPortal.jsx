import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FiCalendar, FiClipboard, FiClock, FiDollarSign, FiLink, FiUsers } from "react-icons/fi";
import { EmptyState, PageHeader, StatusBadge } from "../components/WorkspaceUI.jsx";
import CoachingHistory from "../components/CoachingHistory.jsx";
import Button from "../components/Button.jsx";
import { fetchCoachAssignments, fetchCoachingStudent, fetchMyCoachProfile, fetchCoachingReferrals, fetchCoachingCommissions, fetchReferralIdentities, fetchCoachCalendarConnection, beginCoachCalendarConnection, disconnectCoachCalendar, fetchCoachCalendars, selectCoachCalendar, fetchCoachingSessions, fetchCoachZoomConnection, beginCoachZoomConnection, disconnectCoachZoom } from "../services/api.js";
import "./Coaching.css";

function contactName(contact) { return contact?.name || [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || contact?.email || "Student"; }
function human(value) { return String(value || "Not set").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateLabel(value) { return value ? new Date(value).toLocaleDateString() : "Not set"; }
function tone(value) { return ["active", "completed"].includes(value) ? "success" : value === "scheduled" ? "info" : "warning"; }
function message(error) { return error?.response?.data?.error || error?.message || "Unable to load your coaching workspace."; }

function CoachAssignmentCard({ assignment }) {
  const enrollment = assignment.enrollmentId;
  const contact = enrollment?.contactId;
  return <Link className="coach-assignment-card" to={`/coach/students/${contact?._id}`}>
    <header><div className="coaching-avatar">{contactName(contact).slice(0, 1)}</div><StatusBadge tone={tone(assignment.status)}>{human(assignment.status)}</StatusBadge></header>
    <h2>{contactName(contact)}</h2>
    <p>{enrollment?.coachingProgramId?.name || "Program unavailable"}</p>
    <dl><div><dt>Stage</dt><dd>{human(assignment.stageKey)}</dd></div><div><dt>Starts</dt><dd>{dateLabel(assignment.startsAt)}</dd></div><div><dt>Ends</dt><dd>{dateLabel(assignment.endsAt)}</dd></div></dl>
  </Link>;
}

function useCoachAssignments(view) {
  const [assignments, setAssignments] = useState([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { fetchCoachAssignments({ view, limit: 200 }).then(setAssignments).catch((reason) => setError(message(reason))).finally(() => setLoading(false)); }, [view]);
  return { assignments, error, loading };
}

export function CoachDashboard() {
  const { assignments, error, loading } = useCoachAssignments(""); const [profile, setProfile] = useState(null);
  useEffect(() => { fetchMyCoachProfile().then(setProfile).catch(() => {}); }, []);
  const current = assignments.filter((item) => item.status === "active"); const upcoming = assignments.filter((item) => item.status === "scheduled");
  const studentCount = new Set(current.map((item) => item.enrollmentId?.contactId?._id).filter(Boolean)).size;
  return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title={`Welcome${profile?.displayName ? `, ${profile.displayName}` : ""}`} description="Your authorized students and assignments. Lead Porch only shows coaching records assigned to you." />
    {error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}
    <div className="coaching-summary coaching-summary--coach"><Link className="coaching-summary__card" to="/coach/students"><FiUsers /><strong>{studentCount}</strong><span>Current students</span></Link><Link className="coaching-summary__card" to="/coach/upcoming"><FiClock /><strong>{upcoming.length}</strong><span>Upcoming assignments</span></Link><div className="coaching-summary__card"><FiClipboard /><strong>{current.length}</strong><span>Active assignments</span></div></div>
    <section className="coaching-panel"><div className="coaching-panel__heading"><div><p className="workspace-eyebrow">Current students</p><h2>Your active coaching work</h2></div><Link to="/coach/students">View students</Link></div>{loading ? <p className="coaching-muted">Loading assignments…</p> : current.length ? <div className="coach-card-grid">{current.map((item) => <CoachAssignmentCard assignment={item} key={item._id} />)}</div> : <EmptyState icon={<FiUsers />} title="No current students" description="Students will appear after an administrator assigns you to an active program stage." />}</section>
    <section className="coaching-panel"><div className="coaching-panel__heading"><div><p className="workspace-eyebrow">Coming next</p><h2>Upcoming assignments</h2></div><Link to="/coach/upcoming">View upcoming</Link></div>{upcoming.length ? <div className="coach-card-grid">{upcoming.slice(0, 4).map((item) => <CoachAssignmentCard assignment={item} key={item._id} />)}</div> : <p className="coaching-muted">No upcoming assignments have been scheduled.</p>}</section>
  </div>;
}

export function CoachStudents({ upcoming = false }) {
  const { assignments, error, loading } = useCoachAssignments(upcoming ? "upcoming" : "current");
  const unique = useMemo(() => Array.from(new Map(assignments.map((item) => [item.enrollmentId?.contactId?._id, item])).values()).filter((item) => item.enrollmentId?.contactId?._id), [assignments]);
  return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title={upcoming ? "My upcoming students" : "My students"} description={upcoming ? "Students assigned to you for a future program stage." : "Only students backed by your current authorized CoachAssignments are shown."} />
    {error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}{loading ? <p className="coaching-muted">Loading authorized assignments…</p> : unique.length ? <div className="coach-card-grid">{unique.map((item) => <CoachAssignmentCard assignment={item} key={item._id} />)}</div> : <EmptyState icon={upcoming ? <FiClock /> : <FiUsers />} title={upcoming ? "No upcoming assignments" : "No current students"} description={upcoming ? "Future assignments will appear here when an administrator schedules them." : "An administrator must assign a student before their information is visible here."} />}
  </div>;
}

export function CoachStudentDetail() {
  const { contactId } = useParams(); const [student, setStudent] = useState(null); const [error, setError] = useState("");
  useEffect(() => { fetchCoachingStudent(contactId).then(setStudent).catch((reason) => setError(message(reason))); }, [contactId]);
  if (!student) return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title="Student" description="Loading your authorized student record…" />{error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}</div>;
  return <div className="coaching-page"><PageHeader eyebrow="My student" title={contactName(student.contact)} description="This narrower student profile comes only from the assignment-protected Coaching API." actions={<Link className="btn btn--outline btn--md" to="/coach/students">Back to students</Link>} />
    <div className="coaching-detail-grid"><section className="coaching-panel"><h2>Contact information</h2><dl className="coaching-details"><div><dt>Email</dt><dd>{student.contact.email || "Not provided"}</dd></div><div><dt>Phone</dt><dd>{student.contact.phone || "Not provided"}</dd></div><div><dt>City</dt><dd>{[student.contact.city, student.contact.state].filter(Boolean).join(", ") || "Not provided"}</dd></div></dl></section>
      <section className="coaching-panel"><h2>Program enrollment</h2>{student.enrollments.length ? student.enrollments.map((item) => <article className="coaching-record" key={item._id}><div><strong>{item.coachingProgramId?.name}</strong><span>{dateLabel(item.startsAt)} – {dateLabel(item.expectedEndAt)}</span></div><StatusBadge tone={tone(item.status)}>{human(item.status)}</StatusBadge><p>Current stage: {human(item.currentStageKey)}</p><p>Skool access: {human(item.externalRefs?.skoolStatus || "not_invited")}</p>{item.coachingProgramId?.skoolMapping?.groupUrl ? <a href={item.coachingProgramId.skoolMapping.groupUrl} target="_blank" rel="noreferrer">Open Skool group</a> : null}</article>) : <p className="coaching-muted">No authorized enrollment.</p>}</section>
      <section className="coaching-panel coaching-panel--wide"><h2>My authorized assignments</h2>{student.coachAssignments.length ? <div className="coaching-record-grid">{student.coachAssignments.map((item) => <article className="coaching-record" key={item._id}><div><strong>{human(item.stageKey)}</strong><span>{dateLabel(item.startsAt)} – {dateLabel(item.endsAt)}</span></div><StatusBadge tone={tone(item.status)}>{human(item.status)}</StatusBadge></article>)}</div> : <p className="coaching-muted">No assignment details available.</p>}</section>
    </div>
    <CoachingHistory student={student} coachMode />
  </div>;
}

function CalendarConnection({ onChanged }) {
  const [connection, setConnection] = useState(null); const [calendars, setCalendars] = useState([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchCoachCalendarConnection().then(async (value) => { setConnection(value); setCalendars(value.connected ? await fetchCoachCalendars() : []); onChanged?.(value); }).catch((reason) => setError(message(reason))), [onChanged]);
  useEffect(() => { load(); }, [load]);
  const connect = async () => { setBusy(true); setError(""); try { window.location.assign(await beginCoachCalendarConnection()); } catch (reason) { setError(message(reason)); setBusy(false); } };
  const disconnect = async () => { if (!window.confirm("Disconnect your Google Calendar? Existing Lead Porch sessions remain recorded.")) return; setBusy(true); try { await disconnectCoachCalendar(); await load(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  const select = async (calendarId) => { setBusy(true); try { const item = calendars.find((value) => value.id === calendarId); await selectCoachCalendar({ calendarId, timezone: item?.timezone }); await load(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  return <section className="coaching-panel"><div className="coaching-panel__heading"><div><p className="workspace-eyebrow">Settings / Integrations</p><h2>Google Calendar</h2></div><StatusBadge tone={connection?.connected ? "success" : "warning"}>{connection?.connected ? "Connected" : "Not connected"}</StatusBadge></div>{error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}{connection?.connected ? <><p className="coaching-muted">Connected as <strong>{connection.email || connection.name}</strong>. Only your coach-owned Calendar connection is used.</p><label className="coaching-select-field">Calendar<select className="coaching-select" disabled={busy} value={connection.selectedCalendarId || "primary"} onChange={(event) => select(event.target.value)}>{calendars.map((item) => <option value={item.id} key={item.id}>{item.summary}{item.primary ? " (Primary)" : ""}</option>)}</select></label><p className="coaching-muted">Timezone: {connection.timezone || "UTC"}</p><div className="coaching-row__buttons"><Button disabled={busy} onClick={connect}>Reconnect</Button><Button disabled={busy} variant="danger" onClick={disconnect}>Disconnect</Button></div></> : <><p className="coaching-muted">Connect your own Google account. Administrators can see status, but never your tokens.</p><Button disabled={busy || connection?.configured === false} onClick={connect}>{busy ? "Opening Google…" : "Connect Google Calendar"}</Button>{connection?.configured === false ? <p className="coaching-muted">An administrator must configure Google Calendar OAuth first.</p> : null}</>}</section>;
}

function ZoomConnection() {
  const [connection, setConnection] = useState(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchCoachZoomConnection().then(setConnection).catch((reason) => setError(message(reason))), []); useEffect(() => { load(); }, [load]);
  const connect = async () => { setBusy(true); setError(""); try { window.location.assign(await beginCoachZoomConnection()); } catch (reason) { setError(message(reason)); setBusy(false); } };
  const disconnect = async () => { if (!window.confirm("Disconnect your Zoom account? Existing session history will remain.")) return; setBusy(true); try { await disconnectCoachZoom(); await load(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  return <section className="coaching-panel"><div className="coaching-panel__heading"><div><p className="workspace-eyebrow">Settings / Integrations</p><h2>Zoom</h2></div><StatusBadge tone={connection?.connected ? "success" : "warning"}>{connection?.connected ? "Connected" : "Not connected"}</StatusBadge></div>{error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}{connection?.connected ? <><p className="coaching-muted">Connected as <strong>{connection.email || connection.name}</strong>. Meetings assigned to you use only this Zoom identity.</p><div className="coaching-row__buttons"><Button disabled={busy} onClick={connect}>Reconnect</Button><Button disabled={busy} variant="danger" onClick={disconnect}>Disconnect</Button></div></> : <><p className="coaching-muted">Connect your own Zoom account. Administrators see readiness only and never receive your tokens.</p><Button disabled={busy || connection?.configured === false} onClick={connect}>{busy ? "Opening Zoom…" : "Connect Zoom"}</Button>{connection?.configured === false ? <p className="coaching-muted">An administrator must configure Zoom OAuth first.</p> : null}</>}</section>;
}

export function CoachSchedule() {
  const [sessions, setSessions] = useState([]); const [error, setError] = useState("");
  useEffect(() => { fetchCoachingSessions({ view: "upcoming", limit: 200 }).then(setSessions).catch((reason) => setError(message(reason))); }, []);
  return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title="My schedule" description="Upcoming sessions use your selected Google Calendar and, when chosen, your connected Zoom account." />{error ? <p className="coaching-notice coaching-notice--error">{error}</p> : null}<CalendarConnection /><ZoomConnection />
    <section className="coaching-panel"><h2>Upcoming sessions</h2>{sessions.length ? <div className="coaching-list">{sessions.map((session) => <article className="coaching-row" key={session._id}><div className="coaching-avatar">{contactName(session.contactId)[0]}</div><div className="coaching-row__main"><strong>{contactName(session.contactId)}</strong><span>{session.coachingProgramId?.name || "Coaching"} · {human(session.stageKey)}</span><span>Reminders: {session.reminders?.length ? session.reminders.map((item) => `${human(item.channel)} ${human(item.status)}`).join(" · ") : "Not scheduled"}</span>{session.zoom?.joinUrl ? <a href={session.zoom.joinUrl} target="_blank" rel="noreferrer">Join Zoom meeting</a> : null}</div><span>{new Date(session.startsAt).toLocaleString()} · {session.durationMinutes} min</span><StatusBadge tone={tone(session.status)}>{human(session.status)}</StatusBadge></article>)}</div> : <EmptyState icon={<FiCalendar />} title="No upcoming sessions" description="Sessions appear after an administrator schedules one on your connected calendar." />}</section>
  </div>;
}

const moneyMinor=(value,currency="USD")=>new Intl.NumberFormat("en-US",{style:"currency",currency}).format((Number(value)||0)/100);
export function CoachReferrals(){const [rows,setRows]=useState([]),[identity,setIdentity]=useState(null),[error,setError]=useState("");useEffect(()=>{Promise.all([fetchCoachingReferrals({limit:200}),fetchReferralIdentities()]).then(([a,b])=>{setRows(a);setIdentity(b[0]||null);}).catch(e=>setError(message(e)));},[]);return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title="My referrals" description="Contacts whose first valid coach referral is attributed to you."/>{error?<p className="coaching-notice coaching-notice--error">{error}</p>:null}<section className="coaching-panel"><h2>Your referral identity</h2><p className="coaching-muted">Code: <strong>{identity?.referralCode||"Ask an administrator to configure your code."}</strong></p>{identity?.referralSlug?<p className="coaching-muted">Future public path: /ref/{identity.referralSlug}</p>:null}</section>{rows.length?<div className="coaching-card-grid">{rows.map(r=><article className="coaching-card" key={r._id}><header><FiLink/><StatusBadge tone="success">Attributed</StatusBadge></header><h2>{contactName(r.contactId)}</h2><p>{r.referralCode} · {r.source}</p><dl><div><dt>Attributed</dt><dd>{dateLabel(r.attributedAt)}</dd></div><div><dt>Qualified revenue</dt><dd>{moneyMinor(r.referredRevenueMinor,r.currency)}</dd></div></dl>{r.products?.length?<p>{r.products.join(", ")}</p>:null}</article>)}</div>:<EmptyState icon={<FiLink/>} title="No referrals yet" description="Only Contacts attributed to your referral identity appear here."/>}</div>}
export function CoachCommissions(){const [rows,setRows]=useState([]),[error,setError]=useState("");useEffect(()=>{fetchCoachingCommissions({limit:200}).then(setRows).catch(e=>setError(message(e)));},[]);const total=(status)=>rows.filter(r=>r.status===status).reduce((sum,r)=>sum+r.commissionAmountMinor,0);return <div className="coaching-page"><PageHeader eyebrow="Coach Portal" title="My commissions" description="Your immutable referral commission ledger. Payment actions remain administrator-controlled."/>{error?<p className="coaching-notice coaching-notice--error">{error}</p>:null}<div className="coaching-summary coaching-summary--coach">{["pending","approved","paid"].map(s=><div className="coaching-summary__card" key={s}><FiDollarSign/><strong>{moneyMinor(total(s),rows[0]?.currency)}</strong><span>{human(s)}</span></div>)}</div>{rows.length?<div className="coaching-card-grid">{rows.map(r=><article className="coaching-card" key={r._id}><header><FiDollarSign/><StatusBadge tone={tone(r.status)}>{human(r.status)}</StatusBadge></header><h2>{moneyMinor(r.commissionAmountMinor,r.currency)}</h2><p>{r.productLabel||r.coachingProgramId?.name||"Qualifying sale"}</p><dl><div><dt>Gross sale</dt><dd>{moneyMinor(r.grossAmountMinor,r.currency)}</dd></div><div><dt>Rate</dt><dd>{(r.rateBps/100).toFixed(2)}%</dd></div><div><dt>Date</dt><dd>{dateLabel(r.calculatedAt)}</dd></div></dl></article>)}</div>:<EmptyState icon={<FiDollarSign/>} title="No commissions yet" description="A commission appears only after a referred Contact completes a qualifying sale."/>}</div>}
