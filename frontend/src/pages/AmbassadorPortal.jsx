import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FiCheck, FiDollarSign, FiLink, FiUsers } from "react-icons/fi";
import AmbassadorContentTasks from "../components/AmbassadorContentTasks.jsx";
import Button from "../components/Button.jsx";
import UserAvatar from "../components/UserAvatar.jsx";
import { fetchMyAmbassadorPayouts, fetchMyAmbassadorProfile, fetchMyAmbassadorReferrals, submitMyAmbassadorReferral, addMyReferralFollowUpNote, fileMyReferralDispute, fetchMyAmbassadorResources, downloadMyAmbassadorResource, acknowledgeMyAmbassadorResource } from "../services/api.js";
import { copyReferralLink } from "../utils/ambassadorReferralFields.js";
import "./AmbassadorPortal.css";
import "./AmbassadorProfile.css";

const money = (amount, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format((amount || 0) / 100);
const date = (value) => value ? new Date(value).toLocaleDateString() : "Not yet";
const label = (value) => String(value || "").replaceAll("_", " ");

export default function AmbassadorPortal() {
  const [profile, setProfile] = useState(null), [referrals, setReferrals] = useState([]), [payouts, setPayouts] = useState([]), [error, setError] = useState(""), [copyStatus, setCopyStatus] = useState("");
  const [resources, setResources] = useState([]);
  const [referralForm, setReferralForm] = useState({ name: "", email: "", phone: "", consentGiven: false });
  const [referralNotice, setReferralNotice] = useState("");
  const [noteDrafts, setNoteDrafts] = useState({});
  const [disputeDrafts, setDisputeDrafts] = useState({});
  const load = () => Promise.all([fetchMyAmbassadorProfile(), fetchMyAmbassadorReferrals(), fetchMyAmbassadorPayouts(), fetchMyAmbassadorResources().catch(() => ({ data: [] }))]).then(([a, b, c, d]) => { setProfile(a); setReferrals(b); setPayouts(c); setResources(d.data || []); }).catch((err) => setError(err.response?.data?.error || "Unable to load ambassador dashboard."));
  useEffect(() => { load(); }, []);
  const total = (status) => payouts.filter((row) => row.status === status).reduce((sum, row) => sum + row.commissionAmountMinor, 0);
  const copyLink = async () => { setCopyStatus(""); try { await copyReferralLink(profile?.referralUrl); setCopyStatus("Referral link copied."); } catch { setCopyStatus("Copy failed. Select and copy the link manually."); } };
  const submitReferral = async () => {
    setReferralNotice(""); setError("");
    try {
      const result = await submitMyAmbassadorReferral(referralForm);
      setReferralNotice(result.duplicate ? (result.reason || "This person has already been referred.") : "Referral submitted.");
      setReferralForm({ name: "", email: "", phone: "", consentGiven: false });
      load();
    } catch (err) { setError(err.response?.data?.error || "Unable to submit that referral."); }
  };
  const addNote = async (attributionId) => {
    const note = noteDrafts[attributionId]; if (!note?.trim()) return;
    try { await addMyReferralFollowUpNote(attributionId, { note }); setNoteDrafts((d) => ({ ...d, [attributionId]: "" })); load(); }
    catch (err) { setError(err.response?.data?.error || "Unable to save that note."); }
  };
  const fileDispute = async (attributionId) => {
    const reason = disputeDrafts[attributionId]; if (!reason?.trim()) return;
    try { await fileMyReferralDispute(attributionId, reason); setDisputeDrafts((d) => ({ ...d, [attributionId]: "" })); setReferralNotice("Dispute filed. The workspace team will review it."); load(); }
    catch (err) { setError(err.response?.data?.error || "Unable to file that dispute."); }
  };
  const downloadResource = async (resource) => {
    try {
      const response = await downloadMyAmbassadorResource(resource._id);
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a"); link.href = url; link.download = resource.latestVersion?.fileName || resource.title; document.body.appendChild(link); link.click(); link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) { setError(err.response?.data?.error || "Unable to download that resource."); }
  };
  const acknowledgeResource = async (resourceId) => { try { await acknowledgeMyAmbassadorResource(resourceId); setReferralNotice("Acknowledged."); } catch (err) { setError(err.response?.data?.error || "Unable to record that acknowledgment."); } };

  return <div className="ambassador-page">
    <header className="ambassador-profile-header"><UserAvatar user={profile?.userId} name={profile?.displayName} size="lg"/><div><p>Brand Ambassador</p><h1>{profile?.displayName || "My ambassador dashboard"}</h1><span>Your referral activity and commission history are private to your account.</span><Link to="/profile">View shared profile</Link></div></header>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {referralNotice ? <p className="ambassador-copy-status" role="status">{referralNotice}</p> : null}
    <section className="ambassador-referral-card" aria-labelledby="my-referral-link-title">
      <div className="ambassador-referral-card__heading"><FiLink aria-hidden="true"/><div><p>Referral tools</p><h2 id="my-referral-link-title">My referral link</h2></div></div>
      <p>Share this complete link with people who have asked to learn more. Lead Porch will preserve your referral when they submit the public program application.</p>
      <dl><div><dt>Referral code</dt><dd>{profile?.referralCode || "Not configured"}</dd></div></dl>
      <div className="ambassador-copy-row"><input aria-label="My complete referral URL" readOnly value={profile?.referralUrl || "Your link will appear after your account is activated."}/><Button onClick={copyLink} disabled={!profile?.referralUrl}>Copy referral link</Button></div>
      {copyStatus ? <p className="ambassador-copy-status" role="status"><FiCheck aria-hidden="true"/>{copyStatus}</p> : null}
      <small>Use the full link exactly as shown. Referral progress appears below after a person submits an application.</small>
    </section>
    <section className="ambassador-panel"><div className="ambassador-profile-complete"><span><strong>Profile {profile?.completeness?.percent || 0}% complete</strong><small>Required: {(profile?.completeness?.requiredFields || []).join(" · ")}</small></span><progress max="100" value={profile?.completeness?.percent || 0}/><Link to="/profile">Edit My Profile</Link></div><p><strong>Welcome post:</strong> {label(profile?.welcomePost?.status || "waiting_for_profile")}</p><small>Referral identity, commission settings, role, and account status are managed by the workspace Owner/Admin.</small></section>
    <AmbassadorContentTasks/>
    <section className="ambassador-summary"><article><FiUsers/><strong>{referrals.length}</strong><span>My referrals</span></article><article><FiDollarSign/><strong>{money(total("pending"), payouts[0]?.currency)}</strong><span>Pending commission</span></article><article><FiDollarSign/><strong>{money(total("approved"), payouts[0]?.currency)}</strong><span>Approved commission</span></article><article><FiDollarSign/><strong>{money(total("paid"), payouts[0]?.currency)}</strong><span>Paid commission</span></article></section>
    {profile?.communityUrl ? <section className="ambassador-panel"><h2>Ambassador community</h2><p>This community entry point was explicitly enabled for your ambassador profile.</p><a href={profile.communityUrl} target="_blank" rel="noreferrer">Open community</a></section> : null}
    <section className="ambassador-panel"><h2>Submit a referral</h2><p className="ambassador-panel__intro">Tell us about someone you referred directly (in addition to your link). Consent confirms they agreed to be contacted.</p>
      <div className="ambassador-referral-form">
        <input placeholder="Full name" value={referralForm.name} onChange={(e) => setReferralForm({ ...referralForm, name: e.target.value })} />
        <input placeholder="Email" type="email" value={referralForm.email} onChange={(e) => setReferralForm({ ...referralForm, email: e.target.value })} />
        <input placeholder="Phone (optional)" value={referralForm.phone} onChange={(e) => setReferralForm({ ...referralForm, phone: e.target.value })} />
        <label><input type="checkbox" checked={referralForm.consentGiven} onChange={(e) => setReferralForm({ ...referralForm, consentGiven: e.target.checked })} /> They agreed to be contacted about this program</label>
        <Button onClick={submitReferral} disabled={!referralForm.name.trim() || !referralForm.email.trim() || !referralForm.consentGiven}>Submit referral</Button>
      </div>
    </section>
    <section className="ambassador-panel"><h2>My referrals</h2><p className="ambassador-panel__intro">You see only referrals attributed to your ambassador profile. Contact details and private application answers remain with the workspace team.</p>{referrals.length ? referrals.map((row) => <article className="ambassador-row ambassador-row--stacked" key={row._id}>
      <div className="ambassador-row-top"><span><strong>{row.referredPerson || "Referred person"}</strong><small>Referred {date(row.attributedAt)}{row.applicationStatus ? ` · Application ${label(row.applicationStatus)}` : ""}{row.enrollmentStatus ? ` · Enrollment ${label(row.enrollmentStatus)}` : ""}</small></span><em>{label(row.state)}</em></div>
      {(row.followUpNotes || []).map((note, index) => <p key={index} className="ambassador-followup-note"><small>{date(note.createdAt)}:</small> {note.note}</p>)}
      {row.dispute?.status && row.dispute.status !== "none" ? <p className={`ambassador-dispute-status ambassador-dispute-status--${row.dispute.status}`}>Dispute {row.dispute.status}{row.dispute.resolution ? `: ${row.dispute.resolution}` : ""}</p> : null}
      <div className="ambassador-row-actions">
        <input placeholder="Add a follow-up note" value={noteDrafts[row._id] || ""} onChange={(e) => setNoteDrafts({ ...noteDrafts, [row._id]: e.target.value })} />
        <Button size="sm" variant="outline" onClick={() => addNote(row._id)}>Add note</Button>
        {(!row.dispute || row.dispute.status === "none" || row.dispute.status === "dismissed") ? <>
          <input placeholder="Report an attribution issue" value={disputeDrafts[row._id] || ""} onChange={(e) => setDisputeDrafts({ ...disputeDrafts, [row._id]: e.target.value })} />
          <Button size="sm" variant="ghost" onClick={() => fileDispute(row._id)}>Report dispute</Button>
        </> : null}
      </div>
    </article>) : <p className="ambassador-empty">No referrals yet. When someone uses your link and submits an application, their referral status will appear here.</p>}</section>
    <section className="ambassador-panel"><h2>My resources</h2><p className="ambassador-panel__intro">Guides, brand assets, training, and agreements shared with you.</p>{resources.length ? resources.map((resource) => <article className="ambassador-row" key={resource._id}><span><strong>{resource.title}</strong><small>{resource.kind === "binding_agreement" ? "Agreement" : "Guide"} · v{resource.currentVersion}</small></span><span className="ambassador-row-actions"><Button size="sm" variant="outline" onClick={() => downloadResource(resource)}>Download</Button>{resource.requiresAcknowledgment ? <Button size="sm" variant="ghost" onClick={() => acknowledgeResource(resource._id)}>Acknowledge</Button> : null}</span></article>) : <p className="ambassador-empty">No resources have been shared with you yet.</p>}</section>
    <section className="ambassador-panel"><h2>My commission and payment history</h2><p className="ambassador-panel__intro">Commission approval and payment are managed by the workspace team; this history is read-only.</p>{payouts.length ? payouts.map((row) => <article className="ambassador-row" key={row._id}><span><strong>{money(row.commissionAmountMinor, row.currency)}</strong><small>{row.productLabel || "Qualifying referral"} · Recorded {date(row.calculatedAt)}{row.approvedAt ? ` · Approved ${date(row.approvedAt)}` : ""}{row.paidAt ? ` · Paid ${date(row.paidAt)}` : ""}</small></span><em>{label(row.status)}</em></article>) : <p className="ambassador-empty">No commissions yet. A commission appears after the workspace records a qualifying conversion.</p>}</section>
  </div>;
}
