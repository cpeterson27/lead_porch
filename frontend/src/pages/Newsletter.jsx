import { useEffect, useState } from "react";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import { fetchNewsletterPreview, fetchNewsletterHistory, sendNewsletter } from "../services/api.js";
import "./Newsletter.css";

export default function Newsletter() {
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    fetchNewsletterPreview().then((res) => setPreview(res.data)).catch(() => {});
    fetchNewsletterHistory().then((res) => setHistory(res.data || [])).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const openConfirm = () => {
    if (!subject.trim() || !body.trim()) { setError("Write a subject and message first."); return; }
    setError("");
    setConfirmOpen(true);
  };

  const confirmSend = async () => {
    setSending(true);
    setError("");
    try {
      const res = await sendNewsletter({ subject, body });
      setNotice(res.message || `Sending to ${res.data?.queued ?? 0} contacts now.`);
      setConfirmOpen(false);
      setSubject("");
      setBody("");
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to send this newsletter.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="newsletter-page">
      <header className="newsletter-header">
        <p className="page-eyebrow">Outreach</p>
        <h1>Newsletter</h1>
        <p>
          One email, sent to every contact in your CRM with a real email on file — no audience to pick.
          This is different from a Campaign (which targets a chosen audience you select) and a Sequence
          (which sends multiple timed emails only to contacts you enroll).
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      <DashboardCard title="Write this issue">
        <div className="newsletter-form">
          <p className="newsletter-recipient-count">
            {preview ? <>Will send to <strong>{preview.recipientCount.toLocaleString()}</strong> contact{preview.recipientCount === 1 ? "" : "s"}</> : "Checking recipient count…"} — anyone unsubscribed, bounced, archived, or missing an email is automatically excluded.
          </p>
          <label className="form-field">
            <span>Subject</span>
            <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="{{firstName}}, ..." />
          </label>
          <label className="form-field">
            <span>Message</span>
            <textarea className="select-input" rows={10} value={body} onChange={(event) => setBody(event.target.value)} placeholder={"Hi {{firstName}},\n\n..."} />
            <small>Tokens: {"{{firstName}}"}, {"{{lastName}}"}, {"{{company}}"}</small>
          </label>
          <Button onClick={openConfirm} disabled={!preview?.recipientCount}>Send to everyone</Button>
        </div>
      </DashboardCard>

      <DashboardCard title="Past issues">
        {history.length ? (
          <div className="newsletter-history">
            <header><strong>Issue</strong><span>Sent date · recipients</span></header>
            {history.map((issue) => (
              <div key={issue._id}>
                <strong>{issue.name}</strong>
                <span>{new Date(issue.createdAt).toLocaleDateString()}</span>
                <b>{issue.metrics?.sent || 0} sent</b>
              </div>
            ))}
          </div>
        ) : <p>No newsletters sent yet.</p>}
      </DashboardCard>

      <Modal
        isOpen={confirmOpen}
        onClose={() => !sending && setConfirmOpen(false)}
        title="Send this newsletter to everyone?"
        footer={<>
          <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>Cancel</Button>
          <Button onClick={confirmSend} loading={sending}>Send to {preview?.recipientCount ?? 0} contacts</Button>
        </>}
      >
        <p>
          This sends to <strong>{preview?.recipientCount ?? 0}</strong> contact{preview?.recipientCount === 1 ? "" : "s"} right
          now. Sending paces out automatically to protect your domain's reputation — it won&rsquo;t go out all at once
          even for a large list. This cannot be undone once it starts.
        </p>
      </Modal>
    </div>
  );
}
