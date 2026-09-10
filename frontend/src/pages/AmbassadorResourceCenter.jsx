import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import {
  fetchAmbassadorResourcesAdmin,
  createAmbassadorResource,
  addAmbassadorResourceVersion,
  setAmbassadorResourceJarvisApproval,
  archiveAmbassadorResource,
  fetchAmbassadorResourceHistory,
} from "../services/api.js";
import "./AmbassadorResourceCenter.css";

const CATEGORIES = [
  ["start_here", "Start Here"],
  ["ambassador_program", "Ambassador Program"],
  ["program_outlines", "Program Outlines"],
  ["brand_assets", "Brand Assets"],
  ["approved_talking_points", "Approved Talking Points"],
  ["campaigns", "Campaigns"],
  ["training", "Training"],
  ["policies_and_agreements", "Policies and Agreements"],
];

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const emptyDraft = { title: "", description: "", category: "training", kind: "guide", requiresAcknowledgment: false, visibility: { internalOnly: true, allAmbassadors: false, studentsOrProgramMembers: false, public: false } };

export default function AmbassadorResourceCenter() {
  const [resources, setResources] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [file, setFile] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);

  const load = useCallback(() => {
    fetchAmbassadorResourcesAdmin({}).then((res) => setResources(res.data || [])).catch((err) => setError(err.response?.data?.error || "Unable to load resources."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!file) { setError("Choose a file to upload."); return; }
    setBusy(true);
    setError("");
    try {
      const fileDataUri = await readAsDataUrl(file);
      await createAmbassadorResource({ ...draft, fileDataUri, fileName: file.name });
      setNotice("Resource uploaded.");
      setShowForm(false);
      setDraft(emptyDraft);
      setFile(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload that resource.");
    } finally {
      setBusy(false);
    }
  };

  const toggleVisibility = (key) => setDraft((current) => ({ ...current, visibility: { ...current.visibility, [key]: !current.visibility[key] } }));

  const addVersion = async (resourceId, uploadFile) => {
    setBusy(true);
    setError("");
    try {
      const fileDataUri = await readAsDataUrl(uploadFile);
      await addAmbassadorResourceVersion(resourceId, { fileDataUri, fileName: uploadFile.name, changeNotes: "" });
      setNotice("New version uploaded.");
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload a new version.");
    } finally {
      setBusy(false);
    }
  };

  const toggleJarvisApproval = async (resource) => {
    setBusy(true);
    setError("");
    try {
      await setAmbassadorResourceJarvisApproval(resource._id, !resource.jarvisApproved);
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update Jarvis approval.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async (resourceId) => {
    if (!window.confirm("Archive this resource? Ambassadors will no longer see it.")) return;
    setBusy(true);
    setError("");
    try {
      await archiveAmbassadorResource(resourceId);
      setNotice("Resource archived.");
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to archive that resource.");
    } finally {
      setBusy(false);
    }
  };

  const viewHistory = async (resourceId) => {
    setSelectedId(resourceId);
    try {
      const res = await fetchAmbassadorResourceHistory(resourceId);
      setHistory(res.data || []);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to load access history.");
    }
  };

  return (
    <div className="resource-center-page">
      <header className="resource-center-header">
        <p className="page-eyebrow">Ambassadors · Resource Center</p>
        <h1>Ambassador Resource Center</h1>
        <p>Upload program guides, brand assets, training, and agreements. Choose who can see each one — visibility and Jarvis knowledge approval are independent switches.</p>
        <Link to="/ambassadors/manage">Back to Ambassadors</Link>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      <DashboardCard title="Resources" action={<Button size="sm" onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Upload resource"}</Button>}>
        {showForm ? (
          <div className="resource-upload-form">
            <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label>Description<textarea rows="3" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
            <label>Category<select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label>Type
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                <option value="guide">Program guide</option>
                <option value="binding_agreement">Binding agreement (requires acceptance)</option>
              </select>
            </label>
            <label className="resource-checkbox"><input type="checkbox" checked={draft.requiresAcknowledgment} onChange={(e) => setDraft({ ...draft, requiresAcknowledgment: e.target.checked })} />Require acknowledgment before use</label>
            <fieldset className="resource-visibility">
              <legend>Visible to</legend>
              <label><input type="checkbox" checked={!draft.visibility.internalOnly} onChange={() => setDraft((c) => ({ ...c, visibility: { ...c.visibility, internalOnly: !c.visibility.internalOnly } }))} />Anyone outside the internal team (uncheck to keep internal-only)</label>
              <label><input type="checkbox" checked={draft.visibility.allAmbassadors} onChange={() => toggleVisibility("allAmbassadors")} />All ambassadors</label>
              <label><input type="checkbox" checked={draft.visibility.studentsOrProgramMembers} onChange={() => toggleVisibility("studentsOrProgramMembers")} />Students / program members</label>
              <label><input type="checkbox" checked={draft.visibility.public} onChange={() => toggleVisibility("public")} />Public</label>
            </fieldset>
            <label>File (PDF, DOCX, image, or video)<input type="file" accept=".pdf,.doc,.docx,image/*,video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
            <Button loading={busy} onClick={submit} disabled={!draft.title.trim() || !file}>Upload</Button>
          </div>
        ) : null}

        <table className="resource-table">
          <thead><tr><th>Title</th><th>Category</th><th>Type</th><th>Version</th><th>Visibility</th><th>Jarvis</th><th /></tr></thead>
          <tbody>
            {resources.map((resource) => (
              <tr key={resource._id}>
                <td><button type="button" className="resource-link" onClick={() => viewHistory(resource._id)}>{resource.title}</button></td>
                <td>{CATEGORIES.find(([v]) => v === resource.category)?.[1] || resource.category}</td>
                <td>{resource.kind === "binding_agreement" ? "Agreement" : "Guide"}</td>
                <td>v{resource.currentVersion}</td>
                <td>{[resource.visibility.public && "Public", resource.visibility.allAmbassadors && "All ambassadors", resource.visibility.studentsOrProgramMembers && "Students", (resource.visibility.namedAmbassadorIds || []).length && "Named"].filter(Boolean).join(", ") || "Internal only"}</td>
                <td><label className="resource-checkbox resource-checkbox--inline"><input type="checkbox" checked={resource.jarvisApproved} onChange={() => toggleJarvisApproval(resource)} />{resource.jarvisApproved ? "Approved" : "Not approved"}</label></td>
                <td className="resource-row-actions">
                  <label className="resource-version-upload"><input type="file" onChange={(e) => e.target.files?.[0] && addVersion(resource._id, e.target.files[0])} />New version</label>
                  <Button size="sm" variant="ghost" onClick={() => archive(resource._id)}>Archive</Button>
                </td>
              </tr>
            ))}
            {!resources.length ? <tr><td colSpan="7">No resources yet.</td></tr> : null}
          </tbody>
        </table>
      </DashboardCard>

      {selectedId ? (
        <DashboardCard title="Access history" action={<Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>Close</Button>}>
          <table className="resource-table">
            <thead><tr><th>Actor</th><th>Action</th><th>Version</th><th>When</th></tr></thead>
            <tbody>
              {history.map((row, index) => (
                <tr key={index}>
                  <td>{row.userId?.name || row.userId?.email || "Unknown"}</td>
                  <td>{row.action}</td>
                  <td>v{row.version}</td>
                  <td>{new Date(row.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
              {!history.length ? <tr><td colSpan="4">No access recorded yet.</td></tr> : null}
            </tbody>
          </table>
        </DashboardCard>
      ) : null}
    </div>
  );
}
