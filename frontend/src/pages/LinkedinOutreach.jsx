import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import {
  fetchLinkedinOutreachStatus,
  beginLinkedinOutreachConnection,
  disconnectLinkedinOutreach,
  fetchLinkedinSequences,
  createLinkedinSequence,
  updateLinkedinSequence,
  enrollLinkedinSequenceContacts,
  fetchLinkedinSequenceEnrollments,
  fetchLinkedinReplyDrafts,
  sendLinkedinReplyDraft,
  discardLinkedinReplyDraft,
} from "../services/api.js";
import "./LinkedinOutreach.css";

const EMPTY_SEQUENCE = {
  name: "",
  description: "",
  connectionMessage: "",
  openerMessage: "",
  openerDelayMinutes: 60,
  calendarBookingUrl: "",
  autonomousSendEnabled: false,
};

function apiError(error, fallback) {
  return error?.response?.data?.error || fallback;
}

function ConnectionPanel({ status, busy, onConnect, onDisconnect, notice }) {
  return (
    <section className="linkedin-outreach-card">
      <h2>LinkedIn account</h2>
      <p className="linkedin-outreach-hint">
        Connects a real LinkedIn profile through Unipile to send connection
        requests and messages. This is separate from LinkedIn Page publishing
        under Connected Accounts.
      </p>
      {notice && <p className="linkedin-outreach-notice">{notice}</p>}
      {status?.connected ? (
        <div className="linkedin-outreach-status linkedin-outreach-status--connected">
          <span className="linkedin-outreach-badge linkedin-outreach-badge--connected">
            Connected
          </span>
          <span>{status.providerAccountName || "LinkedIn account"}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="linkedin-outreach-status">
          <span className="linkedin-outreach-badge">
            {status?.status === "failed" ? "Connection failed" : "Not connected"}
          </span>
          {status?.lastError && <small>{status.lastError}</small>}
          <Button disabled={busy} onClick={onConnect}>
            Connect LinkedIn
          </Button>
        </div>
      )}
    </section>
  );
}

function SequenceForm({ onCreate }) {
  const [form, setForm] = useState(EMPTY_SEQUENCE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (field) => (event) =>
    setForm((prev) => ({
      ...prev,
      [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    }));
  const submit = async () => {
    if (!form.name.trim() || !form.connectionMessage.trim()) {
      setError("Name and a connection-request message are required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onCreate({
        name: form.name,
        description: form.description,
        calendarBookingUrl: form.calendarBookingUrl,
        autonomousSendEnabled: form.autonomousSendEnabled,
        steps: [
          { type: "connection_request", delayMinutes: 0, messageTemplate: form.connectionMessage },
          ...(form.openerMessage.trim()
            ? [{ type: "message", delayMinutes: Number(form.openerDelayMinutes) || 0, messageTemplate: form.openerMessage }]
            : []),
        ],
      });
      setForm(EMPTY_SEQUENCE);
    } catch (creationError) {
      setError(apiError(creationError, "Could not create the sequence."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="linkedin-outreach-card">
      <h2>New sequence</h2>
      <label>
        Name
        <input value={form.name} onChange={update("name")} placeholder="Cold outreach — founders" />
      </label>
      <label>
        Description
        <input value={form.description} onChange={update("description")} placeholder="Optional" />
      </label>
      <label>
        Connection request note
        <textarea
          value={form.connectionMessage}
          onChange={update("connectionMessage")}
          placeholder="Hi {{firstName}} — I noticed..."
          maxLength={300}
        />
        <small>{`Use {{firstName}}, {{company}}, {{title}}. 300 characters max.`}</small>
      </label>
      <label>
        Opener message (sent once accepted)
        <textarea
          value={form.openerMessage}
          onChange={update("openerMessage")}
          placeholder="Optional — leave blank to only send a connection request"
        />
      </label>
      {form.openerMessage.trim() && (
        <label>
          Send opener after (minutes since acceptance)
          <input
            type="number"
            min="0"
            value={form.openerDelayMinutes}
            onChange={update("openerDelayMinutes")}
          />
        </label>
      )}
      <label>
        Calendar booking link
        <input
          value={form.calendarBookingUrl}
          onChange={update("calendarBookingUrl")}
          placeholder="https://cal.com/you/intro"
        />
      </label>
      <label className="linkedin-outreach-checkbox">
        <input type="checkbox" checked={form.autonomousSendEnabled} onChange={update("autonomousSendEnabled")} />
        Let AI send replies automatically (objection-handling + booking), instead of holding every reply for my review
      </label>
      {error && <p className="linkedin-outreach-error">{error}</p>}
      <Button disabled={saving} loading={saving} onClick={submit}>
        Create sequence
      </Button>
    </section>
  );
}

function EnrollmentRow({ enrollment }) {
  const contact = enrollment.contactId || {};
  return (
    <tr>
      <td>{contact.name || contact.firstName || "Unknown"}</td>
      <td>{contact.company || ""}</td>
      <td>
        <span className={`linkedin-outreach-badge linkedin-outreach-badge--${enrollment.status}`}>
          {enrollment.status.replaceAll("_", " ")}
        </span>
      </td>
      <td>{enrollment.stoppedReason || ""}</td>
    </tr>
  );
}

function SequenceCard({ sequence, onToggleStatus, onEnroll }) {
  const [contactIds, setContactIds] = useState("");
  const [enrollments, setEnrollments] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadEnrollments = async () => {
    setEnrollments(await fetchLinkedinSequenceEnrollments(sequence._id));
  };

  const enroll = async () => {
    const ids = contactIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!ids.length) return;
    setBusy(true);
    setMessage("");
    try {
      await onEnroll(sequence._id, ids);
      setContactIds("");
      setMessage(`Enrolled ${ids.length} contact(s).`);
      await loadEnrollments();
    } catch (error) {
      setMessage(apiError(error, "Could not enroll those contacts."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="linkedin-outreach-sequence">
      <header>
        <h3>{sequence.name}</h3>
        <span className={`linkedin-outreach-badge linkedin-outreach-badge--${sequence.status}`}>
          {sequence.status}
        </span>
      </header>
      {sequence.description && <p>{sequence.description}</p>}
      <div className="linkedin-outreach-sequence-actions">
        {sequence.status === "active" ? (
          <Button variant="outline" size="sm" onClick={() => onToggleStatus(sequence._id, "paused")}>
            Pause
          </Button>
        ) : (
          <Button size="sm" onClick={() => onToggleStatus(sequence._id, "active")}>
            Activate
          </Button>
        )}
      </div>
      <div className="linkedin-outreach-enroll">
        <input
          value={contactIds}
          onChange={(event) => setContactIds(event.target.value)}
          placeholder="Contact IDs, comma-separated"
        />
        <Button size="sm" disabled={busy} onClick={enroll}>
          Enroll
        </Button>
        <Button size="sm" variant="outline" onClick={loadEnrollments}>
          {enrollments ? "Refresh" : "View enrollments"}
        </Button>
      </div>
      {message && <small>{message}</small>}
      {enrollments && (
        <table className="linkedin-outreach-table">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Company</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <EnrollmentRow key={enrollment._id} enrollment={enrollment} />
            ))}
            {!enrollments.length && (
              <tr>
                <td colSpan={4}>No enrollments yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </article>
  );
}

function ReplyDrafts({ drafts, onSend, onDiscard }) {
  const [edits, setEdits] = useState({});
  if (!drafts.length)
    return (
      <section className="linkedin-outreach-card">
        <h2>Replies awaiting review</h2>
        <p className="linkedin-outreach-hint">
          Nothing needs review right now. AI-drafted replies to LinkedIn
          sequence conversations show up here unless a sequence has
          autonomous sending turned on.
        </p>
      </section>
    );
  return (
    <section className="linkedin-outreach-card">
      <h2>Replies awaiting review ({drafts.length})</h2>
      {drafts.map((draft) => (
        <div className="linkedin-outreach-draft" key={draft._id}>
          <strong>{draft.contactId?.name || "Contact"}</strong>
          <textarea
            value={edits[draft._id] ?? draft.body}
            onChange={(event) => setEdits((prev) => ({ ...prev, [draft._id]: event.target.value }))}
          />
          <div className="linkedin-outreach-draft-actions">
            <Button size="sm" onClick={() => onSend(draft._id, edits[draft._id] ?? draft.body)}>
              Send
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDiscard(draft._id)}>
              Discard
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

export default function LinkedinOutreach() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [sequences, setSequences] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const [statusResult, sequencesResult, draftsResult] = await Promise.all([
      fetchLinkedinOutreachStatus(),
      fetchLinkedinSequences(),
      fetchLinkedinReplyDrafts(),
    ]);
    setStatus(statusResult);
    setSequences(sequencesResult);
    setDrafts(draftsResult);
  };

  useEffect(() => {
    let active = true;
    Promise.all([fetchLinkedinOutreachStatus(), fetchLinkedinSequences(), fetchLinkedinReplyDrafts()])
      .then(([statusResult, sequencesResult, draftsResult]) => {
        if (active) {
          setStatus(statusResult);
          setSequences(sequencesResult);
          setDrafts(draftsResult);
        }
      })
      .catch((loadError) => {
        if (active) setError(apiError(loadError, "Could not load LinkedIn outreach."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await beginLinkedinOutreachConnection();
      window.location.assign(url);
    } catch (connectError) {
      setError(apiError(connectError, "Could not start the LinkedIn connection."));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectLinkedinOutreach();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const createSequence = async (values) => {
    await createLinkedinSequence(values);
    await load();
  };

  const toggleStatus = async (id, nextStatus) => {
    await updateLinkedinSequence(id, { status: nextStatus });
    await load();
  };

  const enroll = async (id, contactIds) => enrollLinkedinSequenceContacts(id, contactIds);

  const sendDraft = async (messageId, text) => {
    await sendLinkedinReplyDraft(messageId, text);
    await load();
  };
  const discardDraft = async (messageId) => {
    await discardLinkedinReplyDraft(messageId);
    await load();
  };

  if (loading) return <main className="linkedin-outreach"><p>Loading LinkedIn outreach…</p></main>;

  const redirectNotice =
    params.get("status") === "success"
      ? "LinkedIn account connected."
      : params.get("status") === "error"
        ? "The LinkedIn connection did not complete. Try again."
        : "";

  return (
    <main className="linkedin-outreach">
      <h1>LinkedIn outreach</h1>
      {error && <p className="linkedin-outreach-error">{error}</p>}
      <ConnectionPanel
        status={status}
        busy={busy}
        onConnect={connect}
        onDisconnect={disconnect}
        notice={redirectNotice}
      />
      {status?.connected && (
        <>
          <SequenceForm onCreate={createSequence} />
          <section className="linkedin-outreach-card">
            <h2>Sequences</h2>
            {!sequences.length && <p className="linkedin-outreach-hint">No sequences yet — create one above.</p>}
            {sequences.map((sequence) => (
              <SequenceCard
                key={sequence._id}
                sequence={sequence}
                onToggleStatus={toggleStatus}
                onEnroll={enroll}
              />
            ))}
          </section>
          <ReplyDrafts drafts={drafts} onSend={sendDraft} onDiscard={discardDraft} />
        </>
      )}
    </main>
  );
}
