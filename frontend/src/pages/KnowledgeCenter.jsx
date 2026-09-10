import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import useAuth from "../context/useAuth.js";
import { hasRole } from "../utils/roleAccess.js";
import {
  fetchKnowledgeNotes,
  fetchKnowledgeNote,
  approveKnowledgeNote,
  rejectKnowledgeNote,
  archiveKnowledgeNote,
  restoreKnowledgeNoteVersion,
  prepareKnowledgeMemory,
  confirmKnowledgeMemory,
  uploadKnowledgePdfs,
  fetchVaultCredentials,
  createVaultCredential,
  revokeVaultCredential,
} from "../services/api.js";
import "./KnowledgeCenter.css";

const CATEGORIES = [
  ["dashboard/context", "Company & Dashboard"],
  ["campaigns", "Campaigns"],
  ["contacts-icp", "ICPs & Contacts"],
  ["partners-affiliates", "Partners & Affiliates"],
  ["offers-programs", "Offers & Programs"],
  ["marketing-channels", "Marketing Channels"],
  ["sops", "SOPs"],
  ["decisions", "Decisions"],
];
const STATUS_LABELS = { draft: "Draft", approved: "Approved", rejected: "Rejected", archived: "Archived" };

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function KnowledgeCenter() {
  const { session } = useAuth();
  const [notes, setNotes] = useState([]);
  const [statusFilter, setStatusFilter] = useState("draft");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "", category: "sops" });
  const [pendingApproval, setPendingApproval] = useState(null);
  const [confirmationInput, setConfirmationInput] = useState("");
  const [credentials, setCredentials] = useState([]);
  const [newCredentialLabel, setNewCredentialLabel] = useState("");
  const [newSecret, setNewSecret] = useState(null);
  const [pdfCategory, setPdfCategory] = useState("offers-programs");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfResults, setPdfResults] = useState(null);
  const pdfInputRef = useRef(null);

  const loadNotes = useCallback(() => {
    fetchKnowledgeNotes({
      status: statusFilter || undefined,
      category: categoryFilter || undefined,
      search: search || undefined,
      includeArchived: statusFilter === "archived",
    })
      .then((res) => setNotes(res.data || []))
      .catch((err) => setError(err.response?.data?.error || "Unable to load knowledge notes."));
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => { loadNotes(); }, [loadNotes]);
  useEffect(() => {
    fetchVaultCredentials().then((res) => setCredentials(res.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    fetchKnowledgeNote(selectedId)
      .then((res) => setSelected(res.data))
      .catch((err) => setError(err.response?.data?.error || "Unable to load that note."));
  }, [selectedId]);

  const selectNote = (id) => {
    setSelected(null);
    setSelectedId(id);
  };
  const closeNote = () => {
    setSelected(null);
    setSelectedId(null);
  };

  const approve = async (id) => {
    setBusy(true);
    setError("");
    try {
      await approveKnowledgeNote(id);
      setNotice("Note approved. Jarvis and every agent can now use it.");
      loadNotes();
      if (selectedId === id) fetchKnowledgeNote(id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to approve that note.");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id) => {
    setBusy(true);
    setError("");
    try {
      await rejectKnowledgeNote(id, rejectReason);
      setNotice("Note rejected.");
      setRejectReason("");
      loadNotes();
      if (selectedId === id) fetchKnowledgeNote(id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to reject that note.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async (id) => {
    if (!window.confirm("Archive this note? It will stop being used by Jarvis and every agent.")) return;
    setBusy(true);
    setError("");
    try {
      await archiveKnowledgeNote(id);
      setNotice("Note archived.");
      loadNotes();
      if (selectedId === id) fetchKnowledgeNote(id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to archive that note.");
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (version) => {
    if (!selected) return;
    if (!window.confirm(`Restore version ${version}? This creates a new draft revision awaiting its own approval.`)) return;
    setBusy(true);
    setError("");
    try {
      await restoreKnowledgeNoteVersion(selected._id, version);
      setNotice(`Version ${version} restored as a new draft.`);
      loadNotes();
      fetchKnowledgeNote(selected._id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to restore that version.");
    } finally {
      setBusy(false);
    }
  };

  const startNewKnowledge = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await prepareKnowledgeMemory(draft);
      setPendingApproval(result);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to prepare that knowledge entry.");
    } finally {
      setBusy(false);
    }
  };

  const confirmNewKnowledge = async () => {
    setBusy(true);
    setError("");
    try {
      await confirmKnowledgeMemory(pendingApproval.id, confirmationInput);
      setNotice("Approved knowledge saved. It is immediately available to Jarvis and every agent.");
      setShowNewForm(false);
      setPendingApproval(null);
      setConfirmationInput("");
      setDraft({ title: "", content: "", category: "sops" });
      loadNotes();
    } catch (err) {
      setError(err.response?.data?.error || "Confirmation failed.");
    } finally {
      setBusy(false);
    }
  };

  const hasUnsavedNewKnowledge = () => Boolean(draft.title.trim() || draft.content.trim() || pendingApproval);

  const cancelNewKnowledge = () => {
    if (hasUnsavedNewKnowledge() && !window.confirm("Discard this unsaved knowledge entry? Anything you typed will be lost.")) return;
    setShowNewForm(false);
    setDraft({ title: "", content: "", category: "sops" });
    setPendingApproval(null);
    setConfirmationInput("");
  };

  const uploadPdfs = async () => {
    const files = pdfInputRef.current?.files;
    if (!files?.length) return;
    setPdfBusy(true);
    setError("");
    setPdfResults(null);
    try {
      const res = await uploadKnowledgePdfs(files, pdfCategory);
      setPdfResults(res.data.results);
      const succeeded = res.data.results.filter((row) => row.success).length;
      setNotice(`${succeeded} of ${res.data.results.length} PDF(s) staged as drafts awaiting your review.`);
      if (pdfInputRef.current) pdfInputRef.current.value = "";
      loadNotes();
    } catch (err) {
      setError(err.response?.data?.error || "PDF upload failed.");
    } finally {
      setPdfBusy(false);
    }
  };

  const addCredential = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await createVaultCredential(newCredentialLabel);
      setNewSecret(result.data);
      setNewCredentialLabel("");
      fetchVaultCredentials().then((res) => setCredentials(res.data || []));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to create that credential.");
    } finally {
      setBusy(false);
    }
  };

  const revokeCredential = async (id) => {
    if (!window.confirm("Revoke this vault-bridge credential? Any sync using it will stop working immediately.")) return;
    setBusy(true);
    setError("");
    try {
      await revokeVaultCredential(id);
      setNotice("Credential revoked.");
      fetchVaultCredentials().then((res) => setCredentials(res.data || []));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to revoke that credential.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-center-page">
      <header className="knowledge-center-header">
        <p className="page-eyebrow">Settings · Knowledge Center</p>
        <h1>Knowledge Center</h1>
        <p>
          The single source of truth Jarvis and every agent use. Nothing here requires Obsidian,
          a terminal, or server environment variables — Obsidian is an optional mirror, and any
          change it syncs in lands here as a draft for your review, never live automatically.
        </p>
        <Link to="/settings/workspace">Back to Settings</Link>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      {hasRole(session, "owner") ? (
        <DashboardCard title="Upload program PDFs">
          <p>
            Upload Ellie's program PDFs directly — no copying and pasting. Each PDF becomes its
            own draft note here, with an AI-generated program summary, ideal-customer profile,
            qualification criteria, and suggested discovery-monitor searches. Nothing is approved
            or activated automatically: review and approve each note like any other draft, and
            any suggested monitor is created disabled — review, edit, and turn it on yourself
            under Discovery &gt; Intent Monitoring.
          </p>
          <label>
            Category for these PDFs
            <select value={pdfCategory} onChange={(e) => setPdfCategory(e.target.value)}>
              {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            PDF files (up to 10 at once)
            <input ref={pdfInputRef} type="file" accept="application/pdf" multiple disabled={pdfBusy} />
          </label>
          <Button loading={pdfBusy} onClick={uploadPdfs}>{pdfBusy ? "Uploading and analyzing (can take a minute)…" : "Upload and analyze"}</Button>
          {pdfResults ? (
            <ul className="knowledge-pdf-results">
              {pdfResults.map((row, index) => (
                <li key={index} className={row.success ? "is-success" : "is-error"}>
                  <strong>{row.filename}</strong>
                  {row.success
                    ? ` — staged as a draft${row.monitorDraftsCreated ? `, ${row.monitorDraftsCreated} suggested monitor(s) created disabled` : ""}${!row.aiAnalysisSucceeded ? ` (AI analysis unavailable: ${row.aiAnalysisReason})` : ""}`
                    : ` — failed: ${row.error}`}
                </li>
              ))}
            </ul>
          ) : null}
        </DashboardCard>
      ) : null}

      <DashboardCard
        title="Knowledge notes"
        action={<Button size="sm" onClick={() => (showNewForm ? cancelNewKnowledge() : setShowNewForm(true))}>{showNewForm ? "Cancel" : "Add approved knowledge"}</Button>}
      >
        {showNewForm ? (
          <div className="knowledge-new-form">
            {!pendingApproval ? (
              <>
                <label>
                  Title
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </label>
                <label>
                  Category
                  <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                    {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  Content
                  <textarea rows="6" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
                </label>
                <Button loading={busy} onClick={startNewKnowledge} disabled={!draft.title.trim() || !draft.content.trim()}>Review before saving</Button>
              </>
            ) : (
              <div className="knowledge-confirm">
                <p>Type <strong>{pendingApproval.confirmationPhrase}</strong> exactly to save this as approved knowledge, immediately usable by every agent.</p>
                <input value={confirmationInput} onChange={(e) => setConfirmationInput(e.target.value)} placeholder={pendingApproval.confirmationPhrase} />
                <Button loading={busy} onClick={confirmNewKnowledge} disabled={confirmationInput !== pendingApproval.confirmationPhrase}>Confirm and save</Button>
              </div>
            )}
          </div>
        ) : null}

        <div className="knowledge-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="draft">Needs review (drafts)</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="archived">Archived</option>
            <option value="">All (except archived)</option>
          </select>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input placeholder="Search title or content…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <table className="knowledge-notes-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Status</th>
              <th>Source</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {notes.map((note) => (
              <tr key={note._id} className={note.pendingRemoval ? "knowledge-row--pending-removal" : ""}>
                <td><button type="button" className="knowledge-row-link" onClick={() => selectNote(note._id)}>{note.title}</button></td>
                <td>{CATEGORIES.find(([value]) => value === note.category)?.[1] || note.category}</td>
                <td><span className={`knowledge-status-pill knowledge-status-pill--${note.status}`}>{STATUS_LABELS[note.status] || note.status}</span>{note.pendingRemoval ? <span className="knowledge-pending-removal-badge">removed in Obsidian</span> : null}</td>
                <td>{note.source === "obsidian_bridge" ? "Obsidian" : "Lead Porch"}</td>
                <td>{formatDate(note.updatedAt)}</td>
                <td className="knowledge-row-actions">
                  {note.status !== "approved" ? <Button size="sm" variant="outline" onClick={() => approve(note._id)} disabled={busy}>Approve</Button> : null}
                  {note.status !== "archived" ? <Button size="sm" variant="ghost" onClick={() => archive(note._id)} disabled={busy}>Archive</Button> : null}
                </td>
              </tr>
            ))}
            {!notes.length ? <tr><td colSpan="6">No notes match these filters.</td></tr> : null}
          </tbody>
        </table>
      </DashboardCard>

      {selected ? (
        <DashboardCard title={selected.title} action={<Button size="sm" variant="ghost" onClick={closeNote}>Close</Button>}>
          <div className="knowledge-detail-meta">
            <span>Status: <strong>{STATUS_LABELS[selected.status] || selected.status}</strong></span>
            <span>Owner: {selected.ownerLabel || "—"}</span>
            <span>Effective: {formatDate(selected.effectiveDate)}</span>
            <span>Review by: {formatDate(selected.reviewDate)}</span>
            <span>Path: {selected.path}</span>
          </div>
          {selected.rejectionReason ? <p className="form-error">Rejected: {selected.rejectionReason}</p> : null}
          <pre className="knowledge-detail-content">{selected.content}</pre>
          <div className="knowledge-detail-actions">
            {selected.status !== "approved" ? <Button onClick={() => approve(selected._id)} loading={busy}>Approve</Button> : null}
            {selected.status !== "rejected" ? (
              <>
                <input placeholder="Rejection reason (optional)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <Button variant="secondary" onClick={() => reject(selected._id)} loading={busy}>Reject</Button>
              </>
            ) : null}
            {selected.status !== "archived" ? <Button variant="ghost" onClick={() => archive(selected._id)} loading={busy}>Archive</Button> : null}
          </div>
          {selected.versions?.length ? (
            <div className="knowledge-version-history">
              <h3>Version history</h3>
              <ul>
                {[...selected.versions].reverse().map((version) => (
                  <li key={version.version}>
                    <span>Version {version.version} · {formatDate(version.savedAt)} · {version.changeSource.replaceAll("_", " ")}</span>
                    <Button size="sm" variant="outline" onClick={() => restoreVersion(version.version)} disabled={busy}>Restore</Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DashboardCard>
      ) : null}

      <DashboardCard title="Obsidian vault bridge (optional)">
        <p>
          Lead Porch remains fully canonical without Obsidian. If you use it as an optional local
          mirror, create a credential here and paste it into the bridge tool's own configuration —
          no server environment variable editing required. Revoking a credential here stops that
          sync immediately.
        </p>
        {newSecret ? (
          <div className="knowledge-new-secret">
            <p>Copy this secret now — it will never be shown again.</p>
            <code>{newSecret.secret}</code>
            <Button size="sm" variant="ghost" onClick={() => setNewSecret(null)}>Done, I've copied it</Button>
          </div>
        ) : (
          <div className="knowledge-credential-form">
            <input placeholder="Label (e.g. Owner's laptop)" value={newCredentialLabel} onChange={(e) => setNewCredentialLabel(e.target.value)} />
            <Button size="sm" onClick={addCredential} loading={busy}>Create credential</Button>
          </div>
        )}
        <table className="knowledge-notes-table">
          <thead><tr><th>Label</th><th>Status</th><th>Last success</th><th>Last error</th><th /></tr></thead>
          <tbody>
            {credentials.map((credential) => (
              <tr key={credential._id}>
                <td>{credential.label || "(unlabeled)"}</td>
                <td>{credential.status}</td>
                <td>{formatDate(credential.lastSuccessAt)}</td>
                <td>{credential.lastError || "—"}</td>
                <td>{credential.status === "active" ? <Button size="sm" variant="ghost" onClick={() => revokeCredential(credential._id)}>Revoke</Button> : null}</td>
              </tr>
            ))}
            {!credentials.length ? <tr><td colSpan="5">No vault-bridge credentials yet.</td></tr> : null}
          </tbody>
        </table>
      </DashboardCard>
    </div>
  );
}
