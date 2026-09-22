import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FiArrowRight, FiCalendar, FiTarget } from "react-icons/fi";
import Button from "../components/Button.jsx";
import Modal from "../components/Modal.jsx";
import CampaignModal from "../components/CampaignModal.jsx";
import { createCampaign, deleteCampaign, fetchCampaignDeletionPreview, fetchCampaigns, updateCampaignDetails } from "../services/api.js";
import { getWorkspaceSettings } from "../utils/workspaceSettings.js";
import useInitiative from "../context/useInitiative.js";
import "./Campaigns.css";

const audienceOptions = ["Airbnb investors", "Real estate investors", "House flippers", "Property management companies", "Multifamily investors", "Experienced real-estate operators", "Affiliate and referral partners"];

export default function Campaigns() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedId } = useInitiative();
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletePreview, setDeletePreview] = useState(null);
  const [deleteOptions, setDeleteOptions] = useState({ deleteOutreach: false, deleteEvent: false });
  const [deleting, setDeleting] = useState(false);
  const [defaultCampaignKind, setDefaultCampaignKind] = useState(() => getWorkspaceSettings().defaultCampaignKind);

  const loadCampaigns = async () => {
    try { setLoading(true); setCampaigns(await fetchCampaigns()); }
    catch (err) { console.error("LOAD CAMPAIGNS ERROR:", err); setError("Unable to load campaigns"); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const initialLoad = window.setTimeout(loadCampaigns, 0);
    return () => window.clearTimeout(initialLoad);
  }, []);
  useEffect(() => {
    if (searchParams.get("create") !== "program") return;
    const openProgram = window.setTimeout(() => {
      setDefaultCampaignKind("program");
      setIsOpen(true);
      setSearchParams({}, { replace: true });
    }, 0);
    return () => window.clearTimeout(openProgram);
  }, [searchParams, setSearchParams]);

  const openDeleteModal = async (campaign) => {
    setError("");
    setDeleteTarget(campaign);
    setDeletePreview(null);
    setDeleteOptions({ deleteOutreach: false, deleteEvent: false });
    try { setDeletePreview(await fetchCampaignDeletionPreview(campaign._id)); }
    catch (err) { setError(err.response?.data?.error || "Unable to prepare campaign deletion."); setDeleteTarget(null); }
  };

  const handleCreate = async (values) => {
    try {
      setSubmitting(true);
      setError("");
      if (editingCampaign) await updateCampaignDetails(editingCampaign._id, values);
      else await createCampaign(values);
      setIsOpen(false);
      setEditingCampaign(null);
      await loadCampaigns();
    } catch (err) {
      const message = err.response?.data?.error || err.message || `Unable to ${editingCampaign ? "save" : "create"} campaign`;
      setError(message);
      throw err;
    } finally { setSubmitting(false); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await deleteCampaign(deleteTarget._id, deleteOptions);
      setDeleteTarget(null);
      setDeletePreview(null);
      await loadCampaigns();
    } catch (err) { setError(err.response?.data?.error || "Unable to delete campaign."); }
    finally { setDeleting(false); }
  };

  const visibleCampaigns = selectedId === "all" ? campaigns : campaigns.filter((campaign) => campaign._id === selectedId);
  const activeCount = visibleCampaigns.filter((campaign) => campaign.status === "active").length;

  return <div className="page-dashboard campaigns-page">
    <div className="page-header"><div><p className="page-eyebrow">Campaign portfolio</p><h1 className="page-title">Campaigns</h1><p className="page-subtitle">See the objective, audience, progress, and next action for every campaign.</p></div><div className="campaign-create-actions"><Button variant="outline" onClick={() => { setError(""); setDefaultCampaignKind("event"); setIsOpen(true); }}>+ Event</Button><Button onClick={() => { setError(""); setDefaultCampaignKind("program"); setIsOpen(true); }}>+ Program</Button></div></div>
    <section className="campaign-summary">
      <div><FiTarget /><span><strong>{visibleCampaigns.length}</strong>{selectedId === "all" ? "Total campaigns" : "Selected workspace"}</span></div>
      <div><FiCalendar /><span><strong>{activeCount}</strong>Active now</span></div>
    </section>
    {loading ? <div className="table-state">Loading campaigns…</div> : visibleCampaigns.length ? <section className="campaign-card-grid">
      {visibleCampaigns.map((campaign) => {
        const logistics = campaign.eventId?.eventbriteLogistics || {};
        const sold = Number(logistics.ticketsSold ?? campaign.ticketsSold ?? 0);
        const goal = Number(campaign.eventId?.ticketGoal ?? campaign.ticketGoal ?? 0);
        const basePrice = Number(campaign.eventId?.ticketPrice ?? campaign.ticketPrice ?? 0);
        const checkoutPrice = Number(logistics.minimumCheckoutPrice || 0);
        const progress = goal ? Math.min(100, Math.round((sold / goal) * 100)) : 0;
        const isProgram = campaign.campaignKind === "program";
        const sent = Number(campaign.metrics?.sent || 0);
        const delivered = Number(campaign.metrics?.delivered || 0);
        const opened = Number(campaign.metrics?.opened || 0);
        const emailProgress = sent ? Math.min(100, Math.round((opened / sent) * 100)) : 0;
        return <article className="campaign-card" key={campaign._id}>
          <header><span className={`campaign-state campaign-state--${campaign.status}`}>{campaign.status || "draft"}</span><span>{isProgram ? "Email campaign" : "Event campaign"}</span></header>
          <h2>{campaign.name}</h2>
          <p className="campaign-card__audience">{campaign.audience?.join(" · ") || "Audience not approved yet"}</p>
          <div className="campaign-card__meta">
            {isProgram ? <>
              <span><small>Matched recipients</small><strong>{campaign.audienceMatch?.matchedCount || 0}</strong></span>
              <span><small>Sent</small><strong>{sent}</strong></span>
              <span><small>Opened</small><strong>{opened}</strong>{delivered ? <small>{delivered} delivered</small> : null}</span>
            </> : <>
              <span><small>Matched recipients</small><strong>{campaign.audienceMatch?.matchedCount || 0}</strong></span>
              <span><small>Date</small><strong>{campaign.startDate ? new Date(campaign.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Evergreen"}</strong></span>
              <span><small>Current buyer price</small><strong>{checkoutPrice ? `From $${checkoutPrice.toFixed(2)}` : `$${basePrice.toFixed(2)}`}</strong>{checkoutPrice > basePrice ? <small>${basePrice.toFixed(2)} base + fees</small> : null}</span>
              <span><small>Registrations</small><strong>{sold} / {goal || "—"}</strong></span>
            </>}
          </div>
          <div className="campaign-progress"><span style={{ width: `${isProgram ? emailProgress : progress}%` }} /></div>
          <footer><span>{isProgram ? sent ? `${emailProgress}% open rate` : "No emails sent yet" : `${progress}% of registration goal`}</span><div><Button variant="outline" size="sm" onClick={() => openDeleteModal(campaign)}>Delete</Button><Button variant="outline" size="sm" onClick={() => { setError(""); setEditingCampaign(campaign); setIsOpen(true); }}>Edit</Button><Button variant="outline" size="sm" onClick={() => navigate(`/campaigns/${campaign._id}`)}>Open <FiArrowRight /></Button></div></footer>
        </article>;
      })}
    </section> : <div className="table-state table-state--empty">No campaigns are active yet.</div>}
    <CampaignModal isOpen={isOpen} onClose={() => { setIsOpen(false); setEditingCampaign(null); }} onSubmit={handleCreate} audienceOptions={audienceOptions} submitting={submitting} defaultCampaignKind={defaultCampaignKind} initialData={editingCampaign} />
    <Modal isOpen={Boolean(deleteTarget)} onClose={() => !deleting && setDeleteTarget(null)} title="Delete campaign" footer={<><Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button loading={deleting} onClick={confirmDelete}>Delete campaign</Button></>}>
      {deletePreview ? <div className="campaign-delete-dialog"><p><strong>{deletePreview.campaignName}</strong> will be removed. This cannot be undone.</p>{deletePreview.outreachCount ? <label className="form-field"><span><input type="checkbox" checked={deleteOptions.deleteOutreach} onChange={(event) => setDeleteOptions({ ...deleteOptions, deleteOutreach: event.target.checked })} /> Delete {deletePreview.outreachCount} related outreach record{deletePreview.outreachCount === 1 ? "" : "s"}</span><small>Required to delete this campaign. Sent and replied history will also be removed.</small></label> : <p>No outreach records are attached.</p>}{deletePreview.event ? <label className="form-field"><span><input type="checkbox" disabled={!deletePreview.event.canDelete} checked={deleteOptions.deleteEvent} onChange={(event) => setDeleteOptions({ ...deleteOptions, deleteEvent: event.target.checked })} /> Also delete the linked event</span><small>{deletePreview.event.canDelete ? "Leave this unchecked to keep the event for future use." : "This event is used by another campaign and will be kept."}</small></label> : null}</div> : <p>Checking related records…</p>}
    </Modal>
    {error ? <p className="form-error">{error}</p> : null}
  </div>;
}
