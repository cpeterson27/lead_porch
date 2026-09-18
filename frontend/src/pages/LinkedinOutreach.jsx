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
  fetchLinkedinCandidates,
  fetchLinkedinAnalytics,
  syncLinkedinInbox,
  registerLinkedinInboxWebhook,
  searchLinkedinPeople,
  importLinkedinSearchPeople,
} from "../services/api.js";
import { Link } from "react-router-dom";
import "./LinkedinOutreach.css";

const EMPTY_SEQUENCE = {
  name: "",
  description: "",
  connectionMessage: "",
  openerMessage: "",
  openerDelayMinutes: 60,
  followUpMessage: "",
  followUpDelayMinutes: 2880,
  calendarBookingUrl: "",
  autonomousSendEnabled: false,
  dailyInvitationLimit: 20,
  hourlyInvitationLimit: 5,
};

function apiError(error, fallback) {
  return error?.response?.data?.error || fallback;
}

function LinkedinLeadSearch({ onImported }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const isUrl = /^https:\/\//i.test(query.trim());
      const result = await searchLinkedinPeople(isUrl ? { url: query.trim(), limit: 25 } : { keywords: query.trim(), limit: 25 });
      setPeople(result.people || []);
      setSelected([]);
      setMessage(`${result.people?.length || 0} people found. Review and select the right people; nobody has been contacted.`);
    } catch (error) {
      setMessage(apiError(error, "LinkedIn search could not run."));
    } finally {
      setBusy(false);
    }
  };
  const importSelected = async () => {
    const chosen = people.filter((person) => selected.includes(person.providerId || person.linkedinUrl));
    if (!chosen.length) return;
    setBusy(true);
    try {
      const result = await importLinkedinSearchPeople(chosen);
      setMessage(result.message || `${chosen.length} people added to the CRM.`);
      setPeople((current) => current.filter((person) => !selected.includes(person.providerId || person.linkedinUrl)));
      setSelected([]);
      await onImported();
    } catch (error) {
      setMessage(apiError(error, "Selected people could not be added to the CRM."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="linkedin-outreach-card">
      <h2>Search LinkedIn for new people</h2>
      <p className="linkedin-outreach-hint">Run a small, manual people search with keywords, or paste a LinkedIn/Sales Navigator people-search URL. Results are previews until you select and add them to the CRM.</p>
      <div className="linkedin-search-bar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="multifamily investor California — or paste a LinkedIn people-search URL" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} />
        <Button disabled={busy || !query.trim()} onClick={search}>{busy ? "Working…" : "Search LinkedIn"}</Button>
        <Button variant="outline" disabled={busy || !selected.length} onClick={importSelected}>Add {selected.length || "selected"} to CRM</Button>
      </div>
      {message && <p className="linkedin-outreach-hint" role="status">{message}</p>}
      {people.length ? (
        <div className="linkedin-search-results">
          {people.map((person) => {
            const key = person.providerId || person.linkedinUrl;
            return (
              <label key={key}>
                <input type="checkbox" checked={selected.includes(key)} onChange={() => setSelected((current) => current.includes(key) ? current.filter((id) => id !== key) : [...current, key])} />
                <span><strong>{person.name}</strong><small>{person.title || "Role unavailable"}{person.company ? ` · ${person.company}` : ""}{person.location ? ` · ${person.location}` : ""}</small></span>
                {person.linkedinUrl && <a href={person.linkedinUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>View profile</a>}
              </label>
            );
          })}
        </div>
      ) : null}
    </section>
  );
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
      <div className="linkedin-readiness">
        <span className={status?.integrationEnabled ? "is-ready" : ""}>{status?.integrationEnabled ? "✓" : "1"} Unipile API configured</span>
        <span className={status?.connected ? "is-ready" : ""}>{status?.connected ? "✓" : "2"} LinkedIn profile connected</span>
        <span className={status?.inboxWebhookRegistered ? "is-ready" : ""}>{status?.inboxWebhookRegistered ? "✓" : "3"} Live inbox monitoring</span>
      </div>
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
          <Button disabled={busy || status?.integrationEnabled === false} onClick={onConnect}>
            Connect LinkedIn
          </Button>
          {status?.integrationEnabled === false && <small>Add the Unipile environment variables in Render before connecting Ellie’s account.</small>}
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
        dailyInvitationLimit: Number(form.dailyInvitationLimit) || 20,
        hourlyInvitationLimit: Number(form.hourlyInvitationLimit) || 5,
        steps: [
          { type: "connection_request", delayMinutes: 0, messageTemplate: form.connectionMessage },
          ...(form.openerMessage.trim()
            ? [{ type: "message", delayMinutes: Number(form.openerDelayMinutes) || 0, messageTemplate: form.openerMessage }]
            : []),
          ...(form.openerMessage.trim() && form.followUpMessage.trim()
            ? [{ type: "message", delayMinutes: Number(form.followUpDelayMinutes) || 0, messageTemplate: form.followUpMessage }]
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
        <>
          <label>
            Send opener after (minutes since acceptance)
            <input type="number" min="0" value={form.openerDelayMinutes} onChange={update("openerDelayMinutes")} />
          </label>
          <label>
            Optional follow-up if they do not reply
            <textarea value={form.followUpMessage} onChange={update("followUpMessage")} placeholder="Hi {{firstName}}, just circling back…" />
          </label>
          {form.followUpMessage.trim() && (
            <label>
              Send follow-up after (minutes since opener; 2880 = 2 days)
              <input type="number" min="60" value={form.followUpDelayMinutes} onChange={update("followUpDelayMinutes")} />
            </label>
          )}
        </>
      )}
      <label>
        Calendar booking link
        <input
          value={form.calendarBookingUrl}
          onChange={update("calendarBookingUrl")}
          placeholder="https://cal.com/you/intro"
        />
      </label>
      <div className="linkedin-outreach-field-grid">
        <label>
          Maximum invitations per rolling 24 hours
          <input type="number" min="1" max="100" value={form.dailyInvitationLimit} onChange={update("dailyInvitationLimit")} />
        </label>
        <label>
          Maximum invitations per rolling hour
          <input type="number" min="1" max="25" value={form.hourlyInvitationLimit} onChange={update("hourlyInvitationLimit")} />
        </label>
      </div>
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

function SequenceCard({ sequence, onToggleStatus, onEnroll, candidates }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState("");
  const [enrollments, setEnrollments] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadEnrollments = async () => {
    setEnrollments(await fetchLinkedinSequenceEnrollments(sequence._id));
  };

  const enroll = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    setBusy(true);
    setMessage("");
    try {
      await onEnroll(sequence._id, ids);
      setSelectedIds([]);
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
        <span>{sequence.dailyInvitationLimit || 20}/day · {sequence.hourlyInvitationLimit || 5}/hour</span>
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
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search qualified CRM leads" />
        <Button size="sm" disabled={busy || !selectedIds.length} onClick={enroll}>
          Enroll {selectedIds.length || "selected"}
        </Button>
        <Button size="sm" variant="outline" onClick={loadEnrollments}>
          {enrollments ? "Refresh" : "View enrollments"}
        </Button>
      </div>
      <div className="linkedin-candidate-picker">
        {candidates
          .filter((contact) => !search || `${contact.name} ${contact.company} ${contact.title}`.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 40)
          .map((contact) => {
            const activeElsewhere = contact.activeEnrollment && String(contact.activeEnrollment.sequenceId) !== String(sequence._id);
            return (
              <label key={contact._id} className={activeElsewhere ? "is-disabled" : ""}>
                <input
                  type="checkbox"
                  disabled={Boolean(activeElsewhere)}
                  checked={selectedIds.includes(contact._id)}
                  onChange={() => setSelectedIds((current) => current.includes(contact._id) ? current.filter((id) => id !== contact._id) : [...current, contact._id])}
                />
                <span><strong>{contact.name}</strong><small>{contact.title || "Role unavailable"} · {contact.company || "Company unavailable"}</small></span>
                <em>{activeElsewhere ? "Already active" : contact.qualifyContact ? "Qualified" : "Review"}</em>
              </label>
            );
          })}
        {!candidates.length && <p className="linkedin-outreach-hint">No CRM contacts with LinkedIn URLs are ready. Add reviewed leads to the CRM first.</p>}
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
  const [candidates, setCandidates] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    const [statusResult, sequencesResult, draftsResult, candidatesResult, analyticsResult] = await Promise.all([
      fetchLinkedinOutreachStatus(),
      fetchLinkedinSequences(),
      fetchLinkedinReplyDrafts(),
      fetchLinkedinCandidates(),
      fetchLinkedinAnalytics(),
    ]);
    setStatus(statusResult);
    setSequences(sequencesResult);
    setDrafts(draftsResult);
    setCandidates(candidatesResult);
    setAnalytics(analyticsResult);
  };

  useEffect(() => {
    let active = true;
    Promise.all([fetchLinkedinOutreachStatus(), fetchLinkedinSequences(), fetchLinkedinReplyDrafts(), fetchLinkedinCandidates(), fetchLinkedinAnalytics()])
      .then(([statusResult, sequencesResult, draftsResult, candidatesResult, analyticsResult]) => {
        if (active) {
          setStatus(statusResult);
          setSequences(sequencesResult);
          setDrafts(draftsResult);
          setCandidates(candidatesResult);
          setAnalytics(analyticsResult);
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

  const syncInbox = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await registerLinkedinInboxWebhook();
      const result = await syncLinkedinInbox(100);
      setNotice(`Inbox synchronized: ${result.messagesImported} new messages imported from ${result.chatsSeen} conversations.`);
      await load();
    } catch (syncError) {
      setError(apiError(syncError, "Could not synchronize the LinkedIn inbox."));
    } finally {
      setBusy(false);
    }
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
      {notice && <p className="linkedin-outreach-notice">{notice}</p>}
      <ConnectionPanel
        status={status}
        busy={busy}
        onConnect={connect}
        onDisconnect={disconnect}
        notice={redirectNotice}
      />
      {status?.connected && (
        <>
          <section className="linkedin-outreach-card linkedin-operations">
            <div className="linkedin-outreach-card-heading">
              <div><h2>Outreach command center</h2><p className="linkedin-outreach-hint">Invitations and messages are sent from the connected personal profile. Human review remains the default.</p></div>
              <div className="linkedin-operation-actions"><Button variant="outline" disabled={busy} onClick={syncInbox}>Sync LinkedIn inbox</Button><Link className="linkedin-outreach-link" to="/social/inbox?provider=linkedin">Open unified inbox</Link></div>
            </div>
            <div className="linkedin-metric-grid">
              <article><strong>{analytics?.invitationsSent || 0}</strong><span>Invitations sent</span></article>
              <article><strong>{analytics?.acceptanceRate || 0}%</strong><span>Acceptance rate</span></article>
              <article><strong>{analytics?.replies || 0}</strong><span>Replies received</span></article>
              <article><strong>{analytics?.meetingsBooked || 0}</strong><span>Meetings booked</span></article>
            </div>
          </section>
          <section className="linkedin-outreach-card">
            <h2>Find and prepare the right people</h2>
            <p className="linkedin-outreach-hint">LinkedIn delivers outreach; it does not scrape people. Every person must be reviewed before entering a sequence.</p>
            <div className="linkedin-source-grid">
              <Link to="/discovery"><strong>Apollo + public research</strong><span>Find and qualify program-fit decision makers.</span></Link>
              <Link to="/social/leads"><strong>Social engagement leads</strong><span>Review people already engaging with your content.</span></Link>
              <Link to="/crm/contacts"><strong>CRM and imports</strong><span>Use existing relationships or an owner-provided LinkedIn export.</span></Link>
              <Link to="/programs"><strong>Program targeting</strong><span>Keep the offer and ideal student criteria current.</span></Link>
            </div>
          </section>
          <LinkedinLeadSearch onImported={load} />
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
                candidates={candidates}
              />
            ))}
          </section>
          <ReplyDrafts drafts={drafts} onSend={sendDraft} onDiscard={discardDraft} />
        </>
      )}
    </main>
  );
}
