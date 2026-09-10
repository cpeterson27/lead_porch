import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DashboardCard from "../components/DashboardCard.jsx";
import { fetchAuditLog, getAuditLogExportUrl } from "../services/api.js";
import "./AuditLog.css";

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(null);

  const load = useCallback((useCursor) => {
    fetchAuditLog({ action: action || undefined, targetType: targetType || undefined, success: success || undefined, cursor: useCursor || undefined })
      .then((data) => { setRows((prev) => (useCursor ? [...prev, ...data.rows] : data.rows)); setCursor(data.nextCursor); })
      .catch((err) => setError(err.response?.data?.error || "Unable to load the audit log."));
  }, [action, targetType, success]);

  useEffect(() => { load(null); }, [load]);

  return (
    <div className="audit-log-page">
      <header className="audit-log-header">
        <p className="page-eyebrow">Settings · Audit Log</p>
        <h1>Audit Log</h1>
        <p>An append-only record of who did what, when. Never shows secrets, tokens, or private message bodies.</p>
        <Link to="/settings/workspace">Back to Settings</Link>
      </header>
      {error ? <p className="form-error">{error}</p> : null}

      <DashboardCard title="Filters" action={<a className="btn btn--outline btn--sm" href={getAuditLogExportUrl()} target="_blank" rel="noreferrer">Export CSV</a>}>
        <div className="audit-log-filters">
          <input placeholder="Action (e.g. knowledge.note.approved)" value={action} onChange={(e) => setAction(e.target.value)} />
          <input placeholder="Target type (e.g. AmbassadorResourceFile)" value={targetType} onChange={(e) => setTargetType(e.target.value)} />
          <select value={success} onChange={(e) => setSuccess(e.target.value)}>
            <option value="">Success and failure</option>
            <option value="true">Success only</option>
            <option value="false">Failure only</option>
          </select>
        </div>
      </DashboardCard>

      <DashboardCard title="Events">
        <table className="audit-log-table">
          <thead><tr><th>When</th><th>Actor</th><th>Origin</th><th>Action</th><th>Target</th><th>Success</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className={row.success ? "" : "audit-log-row--failed"}>
                <td>{new Date(row.occurredAt).toLocaleString()}</td>
                <td>{row.actorUserId?.name || row.actorUserId?.email || "System"}</td>
                <td>{row.origin}</td>
                <td>{row.action}</td>
                <td>{row.targetType}{row.targetId ? ` · ${String(row.targetId).slice(-6)}` : ""}</td>
                <td>{row.success ? "✓" : "✗"}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan="6">No events match these filters.</td></tr> : null}
          </tbody>
        </table>
        {cursor ? <button type="button" className="btn btn--outline btn--sm" onClick={() => load(cursor)}>Load more</button> : null}
      </DashboardCard>
    </div>
  );
}
