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
  deleteKnowledgeNote,
  restoreKnowledgeNoteVersion,
  prepareKnowledgeMemory,
  confirmKnowledgeMemory,
  uploadKnowledgePdfs,
  fetchWorkspaceConfig,
  uploadOrganizationLogo,
  fetchCoachingPrograms,
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
const SOURCE_LABELS = { obsidian_bridge: "Imported from an older setup", approved_memory: "Written in Lead Porch", pdf_upload: "PDF upload" };

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function KnowledgeCenter() {
  const { session } = useAuth();
  const [notes, setNotes] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
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
  const [showImported, setShowImported] = useState(false);
  const [workspaceView, setWorkspaceView] = useState("upload");
  const [pdfCategory, setPdfCategory] = useState("offers-programs");
  const [pdfProgramId, setPdfProgramId] = useState("");
  const [coachingPrograms, setCoachingPrograms] = useState([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfResults, setPdfResults] = useState(null);
  const pdfInputRef = useRef(null);
  const [logoUrl, setLogoUrl] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInputRef = useRef(null);

  useEffect(() => {
    fetchWorkspaceConfig()
      .then((config) => setLogoUrl(config.organizationLogoUrl || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchCoachingPrograms()
      .then((rows) => setCoachingPrograms(rows || []))
      .catch(() => {});
  }, []);

  const loadNotes = useCallback(() => {
    fetchKnowledgeNotes({
      includeArchived: true,
    })
      .then((res) => setNotes(res.data || []))
      .catch((err) => setError(err.response?.data?.error || "Unable to load knowledge notes."));
  }, []);

  useEffect(() => { loadNotes(); }, [loadNotes]);
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

  const reject = async (id) => {
    setBusy(true);
    setError("");
    try {
      await rejectKnowledgeNote(id, rejectReason);
      setNotice("Knowledge item rejected. Jarvis will not use it.");
      setRejectReason("");
      loadNotes();
      fetchKnowledgeNote(id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to reject that item.");
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (version) => {
    if (!selected || !window.confirm(`Restore version ${version} as a new draft?`)) return;
    setBusy(true);
    try {
      await restoreKnowledgeNoteVersion(selected._id, version);
      setNotice(`Version ${version} restored as a draft for review.`);
      loadNotes();
      fetchKnowledgeNote(selected._id).then((res) => setSelected(res.data));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to restore that version.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm("Permanently delete this knowledge item? This cannot be undone and Jarvis will no longer be able to use it.")) return;
    setBusy(true);
    setError("");
    try {
      await deleteKnowledgeNote(id);
      setNotice("Knowledge item permanently deleted.");
      closeNote();
      loadNotes();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to delete that item.");
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
      setWorkspaceView("library");
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

  const uploadPdfs = async () => {
    const files = pdfInputRef.current?.files;
    if (!files?.length) return;
    setPdfBusy(true);
    setError("");
    setPdfResults(null);
    try {
      const res = await uploadKnowledgePdfs(files, pdfCategory, pdfCategory === "offers-programs" ? pdfProgramId : "");
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

  const uploadLogo = async () => {
    const file = logoInputRef.current?.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
      return;
    }
    setLogoBusy(true);
    setError("");
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await uploadOrganizationLogo(data);
      setLogoUrl(res.organizationLogoUrl);
      setNotice("Logo uploaded. Jarvis's campaign builder and outgoing emails will use it automatically.");
      if (logoInputRef.current) logoInputRef.current.value = "";
    } catch (err) {
      setError(err.response?.data?.error || "Logo upload failed.");
    } finally {
      setLogoBusy(false);
    }
  };

  const importedCount = notes.filter((note) => note.source === "obsidian_bridge").length;
  const visibleNotes = notes.filter((note) => {
    if (!showImported && note.source === "obsidian_bridge") return false;
    if (statusFilter && note.status !== statusFilter) return false;
    if (!statusFilter && note.status === "archived") return false;
    if (categoryFilter && note.category !== categoryFilter) return false;
    const term = search.trim().toLowerCase();
    return !term || `${note.title} ${note.originalFilename || ""} ${note.content}`.toLowerCase().includes(term);
  });

  return (
    <div className="knowledge-center-page">
      <header className="knowledge-center-header">
        <p className="page-eyebrow">Settings · Knowledge Center</p>
        <h1>Knowledge Center</h1>
        <p>See everything you have uploaded or written, search it before adding more, and decide what Jarvis is allowed to use.</p>
        <Link to="/settings/workspace">Back to Settings</Link>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      <nav className="knowledge-primary-actions" aria-label="Knowledge Center actions">
        {hasRole(session, "owner") ? <button type="button" className={workspaceView === "upload" ? "is-active" : ""} onClick={() => { setWorkspaceView("upload"); setShowNewForm(false); closeNote(); }}><strong>Upload new PDFs</strong><span>Add documents for review</span></button> : null}
        {hasRole(session, "owner") ? <button type="button" className={workspaceView === "logo" ? "is-active" : ""} onClick={() => { setWorkspaceView("logo"); setShowNewForm(false); closeNote(); }}><strong>Brand logo</strong><span>Upload a PNG/JPG/WEBP for Jarvis to use</span></button> : null}
        <button type="button" className={workspaceView === "note" ? "is-active" : ""} onClick={() => { setWorkspaceView("note"); setShowNewForm(true); closeNote(); }}><strong>Add a written note</strong><span>Type facts or instructions</span></button>
        <button type="button" className={workspaceView === "library" ? "is-active" : ""} onClick={() => { setWorkspaceView("library"); setShowNewForm(false); }}><strong>View uploaded knowledge</strong><span>{notes.filter((note) => note.status !== "archived").length} current items</span></button>
      </nav>

      {hasRole(session, "owner") && workspaceView === "upload" ? (
        <DashboardCard title="Upload new PDFs">
          <p className="knowledge-upload-explainer"><strong>Duplicates are blocked automatically.</strong> Uploaded PDFs wait for your review before Jarvis can use them.</p>
          <div className="knowledge-upload-grid"><label>Category<select value={pdfCategory} onChange={(e) => setPdfCategory(e.target.value)}>{CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>PDF files (up to 10)<input ref={pdfInputRef} type="file" accept="application/pdf" multiple disabled={pdfBusy} /></label></div>
          {pdfCategory === "offers-programs" ? (
            <div className="knowledge-upload-grid">
              <label>
                Which program is this about? (optional)
                <select value={pdfProgramId} onChange={(e) => setPdfProgramId(e.target.value)}>
                  <option value="">Not tied to one specific program</option>
                  {coachingPrograms.map((program) => <option key={program._id} value={program._id}>{program.name}</option>)}
                </select>
              </label>
              <p className="knowledge-upload-explainer">
                Pick a program here and, once you approve this PDF below, its
                AI-drafted ideal customer profile is added to that program's
                Internal Summary automatically — nothing else to click. No
                extra AI call, and no risk to the public website.
              </p>
            </div>
          ) : null}
          <Button loading={pdfBusy} onClick={uploadPdfs}>{pdfBusy ? "Checking and analyzing…" : "Check and upload PDFs"}</Button>
          {pdfResults ? <ul className="knowledge-pdf-results">{pdfResults.map((row, index) => <li key={index} className={row.success ? "is-success" : "is-error"}><strong>{row.filename}</strong>{row.success ? ` — staged for review${row.monitorDraftsCreated ? `, ${row.monitorDraftsCreated} suggested monitor(s) created inactive` : ""}` : row.code === "PDF_DUPLICATE" ? ` — not uploaded: ${row.error}` : ` — failed: ${row.error}`}</li>)}</ul> : null}
        </DashboardCard>
      ) : null}

      {hasRole(session, "owner") && workspaceView === "logo" ? (
        <DashboardCard title="Brand logo">
          <p className="knowledge-upload-explainer">
            This is your one workspace-wide brand logo. Jarvis's campaign
            package builder and outgoing emails already read this same logo
            automatically — uploading it here is enough, nothing else to
            configure.
          </p>
          {logoUrl ? (
            <p><img src={logoUrl} alt="Current organization logo" style={{ maxWidth: 220, maxHeight: 120, display: "block", marginBottom: 12 }} /></p>
          ) : (
            <p>No logo uploaded yet.</p>
          )}
          <div className="knowledge-upload-grid">
            <label>Logo file (PNG, JPG, or WEBP, up to 5 MB)<input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" disabled={logoBusy} /></label>
          </div>
          <Button loading={logoBusy} onClick={uploadLogo}>{logoBusy ? "Uploading…" : "Upload logo"}</Button>
        </DashboardCard>
      ) : null}

      {workspaceView === "note" || workspaceView === "library" ? <DashboardCard title={workspaceView === "note" ? "Add a written note" : "Uploaded knowledge"}>
        {workspaceView === "library" ? <><p className="knowledge-library-intro">Choose a file or note to view its contents and controls.</p><div className="knowledge-filters">
          <input placeholder="Search file name, title, or words inside…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All current knowledge</option>
            <option value="approved">Jarvis can use</option>
            <option value="draft">Needs review</option>
            <option value="rejected">Rejected</option>
            <option value="archived">Archived</option>
          </select>
        </div></> : null}

        {workspaceView === "note" && showNewForm ? (
          <div className="knowledge-new-form">
            {!pendingApproval ? (
              <>
                <div className="knowledge-form-heading"><strong>Add a written reference</strong><span>Use this for facts, instructions, or program details that are not already in a PDF.</span></div>
                <label>What should this be called?<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
                <label>What is it about?<select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label>What should Jarvis know?<textarea rows="6" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></label>
                <Button loading={busy} onClick={startNewKnowledge} disabled={!draft.title.trim() || !draft.content.trim()}>Review this note</Button>
              </>
            ) : <div className="knowledge-confirm"><p>Final safety check: type <strong>{pendingApproval.confirmationPhrase}</strong> to confirm these facts are approved for Jarvis to use.</p><input value={confirmationInput} onChange={(e) => setConfirmationInput(e.target.value)} placeholder={pendingApproval.confirmationPhrase} /><Button loading={busy} onClick={confirmNewKnowledge} disabled={confirmationInput !== pendingApproval.confirmationPhrase}>Approve and save note</Button></div>}
          </div>
        ) : null}

        {workspaceView === "library" && importedCount ? <button type="button" className="knowledge-imported-toggle" onClick={() => setShowImported((value) => !value)}>{showImported ? "Hide" : "Show"} {importedCount} older imported note{importedCount === 1 ? "" : "s"}</button> : null}
        {workspaceView === "library" ? <div className={`knowledge-workspace ${selected ? "has-selection" : ""}`}>
        <div className="knowledge-library-grid">
          {visibleNotes.map((note) => <button type="button" key={note._id} className={`knowledge-library-item ${selectedId === note._id ? "is-selected" : ""}`} onClick={() => selectNote(note._id)}>
            <span className={`knowledge-file-mark is-${note.source}`}>{note.source === "pdf_upload" ? "PDF" : "NOTE"}</span>
            <span className="knowledge-library-copy"><strong>{note.originalFilename || note.title}</strong>{note.originalFilename && note.title !== note.originalFilename ? <small>{note.title}</small> : null}<small>{CATEGORIES.find(([value]) => value === note.category)?.[1] || note.category} · {formatDate(note.updatedAt)}</small></span>
            <span className={`knowledge-status-pill knowledge-status-pill--${note.status}`}>{note.status === "approved" ? "Jarvis can use" : note.status === "draft" ? "Needs review" : STATUS_LABELS[note.status]}</span>
          </button>)}
          {!visibleNotes.length ? <div className="knowledge-empty"><strong>No matching knowledge</strong><p>Try another search or filter. If this is a new document, use the upload area below.</p></div> : null}
        </div>
        {selected ? <aside className="knowledge-detail-panel" aria-live="polite"><>
            <header><div><small>Viewing knowledge item</small><h2>{selected.title}</h2></div><Button size="sm" variant="ghost" onClick={closeNote}>Close</Button></header>
            <div className="knowledge-detail-meta">
              <span>Status: <strong>{STATUS_LABELS[selected.status] || selected.status}</strong></span>
              <span>Category: <strong>{CATEGORIES.find(([value]) => value === selected.category)?.[1] || selected.category}</strong></span>
              <span>Added from: <strong>{SOURCE_LABELS[selected.source] || selected.source}</strong></span>
              {selected.originalFilename ? <span>Original file: <strong>{selected.originalFilename}</strong></span> : null}
              <span>Last updated: <strong>{formatDate(selected.updatedAt)}</strong></span>
            </div>
            {selected.rejectionReason ? <p className="form-error">Rejected: {selected.rejectionReason}</p> : null}
            <pre className="knowledge-detail-content">{selected.content}</pre>
            <div className="knowledge-detail-actions">
              {selected.status !== "approved" ? <Button onClick={() => approve(selected._id)} loading={busy}>Allow Jarvis to use</Button> : null}
              {selected.status !== "rejected" ? <><input aria-label="Reason for rejecting this item" placeholder="Why reject it? (optional)" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} /><Button variant="secondary" onClick={() => reject(selected._id)} loading={busy}>Reject</Button></> : null}
              {selected.status !== "archived" ? <Button variant="outline" onClick={() => archive(selected._id)} loading={busy}>Archive</Button> : null}
              {hasRole(session, "owner") ? <Button variant="ghost" onClick={() => remove(selected._id)} loading={busy}>Delete permanently</Button> : null}
            </div>
            {selected.versions?.length ? <details className="knowledge-version-history"><summary>Version history ({selected.versions.length})</summary><ul>{[...selected.versions].reverse().map((version) => <li key={version.version}><span>Version {version.version} · {formatDate(version.savedAt)}</span><Button size="sm" variant="outline" onClick={() => restoreVersion(version.version)} disabled={busy}>Restore</Button></li>)}</ul></details> : null}
          </></aside> : null}
        </div> : null}
      </DashboardCard> : null}

    </div>
  );
}
