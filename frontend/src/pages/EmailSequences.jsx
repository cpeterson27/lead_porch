import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import {
  fetchEmailSequences,
  fetchEmailSequence,
  fetchEmailSequenceEnrollments,
  createEmailSequence,
  updateEmailSequence,
  setEmailSequenceEnrollmentStatus,
} from "../services/api.js";
import "./EmailSequences.css";

const emptyStep = () => ({ subject: "", body: "", delayDays: 0 });

const STATUS_LABELS = { draft: "Draft", active: "Active", paused: "Paused", archived: "Archived" };
const ENROLLMENT_STATUS_LABELS = { active: "Active", paused: "Paused", completed: "Completed", stopped: "Stopped", failed: "Failed" };

function contactName(contact) {
  if (!contact) return "Unknown contact";
  return contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.email || "Unknown contact";
}

export default function EmailSequences() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingSequence, setEditingSequence] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detailSequence, setDetailSequence] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(false);
  const [enrollmentBusyId, setEnrollmentBusyId] = useState("");

  const load = useCallback(() => {
    fetchEmailSequences()
      .then((res) => { setSequences(res.data || []); setError(""); })
      .catch((err) => setError(err.response?.data?.error || "Unable to load email sequences."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEnrollments = useCallback((sequence) => {
    setDetailSequence(sequence);
    setEnrollmentsLoading(true);
    fetchEmailSequenceEnrollments(sequence._id)
      .then((res) => setEnrollments(res.data || []))
      .catch(() => setEnrollments([]))
      .finally(() => setEnrollmentsLoading(false));
  }, []);

  // Deep-link support (/email-sequences/:id): fetches the sequence and its
  // enrollments directly by id rather than waiting on the list above, so it
  // works as soon as routeId is known. Every state update here happens
  // inside a .then()/.catch(), never synchronously in the effect body.
  useEffect(() => {
    if (!routeId) return undefined;
    let cancelled = false;
    Promise.all([fetchEmailSequence(routeId), fetchEmailSequenceEnrollments(routeId)])
      .then(([sequenceRes, enrollmentRes]) => {
        if (cancelled) return;
        setDetailSequence(sequenceRes.data);
        setEnrollments(enrollmentRes.data || []);
      })
      .catch(() => { if (!cancelled) setError("Unable to load this sequence."); })
      .finally(() => { if (!cancelled) setEnrollmentsLoading(false); });
    return () => { cancelled = true; };
  }, [routeId]);

  const openNewSequence = () => {
    setEditingSequence({ name: "", description: "", stopOnReply: true, steps: [emptyStep()] });
  };

  const openEditSequence = async (sequence) => {
    try {
      const res = await fetchEmailSequence(sequence._id);
      setEditingSequence(res.data);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to load this sequence.");
    }
  };

  const updateStep = (index, patch) => {
    setEditingSequence((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    }));
  };

  const addStep = () => setEditingSequence((current) => ({ ...current, steps: [...current.steps, emptyStep()] }));
  const removeStep = (index) => setEditingSequence((current) => ({ ...current, steps: current.steps.filter((_, stepIndex) => stepIndex !== index) }));

  const saveSequence = async () => {
    setSaving(true);
    setError("");
    try {
      if (editingSequence._id) {
        await updateEmailSequence(editingSequence._id, editingSequence);
      } else {
        await createEmailSequence(editingSequence);
      }
      setEditingSequence(null);
      setNotice("Sequence saved.");
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save this sequence.");
    } finally {
      setSaving(false);
    }
  };

  const toggleSequenceStatus = async (sequence, status) => {
    try {
      await updateEmailSequence(sequence._id, { status });
      setNotice(`"${sequence.name}" is now ${STATUS_LABELS[status].toLowerCase()}.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update this sequence.");
    }
  };

  const actOnEnrollment = async (enrollment, action) => {
    setEnrollmentBusyId(enrollment._id);
    try {
      await setEmailSequenceEnrollmentStatus(enrollment._id, action);
      const res = await fetchEmailSequenceEnrollments(detailSequence._id);
      setEnrollments(res.data || []);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update that enrollment.");
    } finally {
      setEnrollmentBusyId("");
    }
  };

  return (
    <div className="email-sequences-page">
      <header className="email-sequences-header">
        <div>
          <p className="page-eyebrow">Outreach</p>
          <h1>Email Sequences</h1>
          <p>
            Build a short series of emails once, then enroll contacts one at a time from the CRM.
            Each contact gets their own timer and moves through the steps on schedule — Lead Porch
            stops their sequence automatically if they reply.
          </p>
        </div>
        <Button onClick={openNewSequence}>New sequence</Button>
      </header>

      <DashboardCard title="How this is different from Campaigns, Newsletter, and Automations" className="email-sequences-explainer">
        <dl className="email-sequences-explainer__grid">
          <div>
            <dt>Email Sequences (this page)</dt>
            <dd>A series you write once. You enroll contacts individually from the CRM, and each one privately works through the steps on their own timeline.</dd>
          </div>
          <div>
            <dt>Campaigns</dt>
            <dd>A one-time personalized email you send once to a list of contacts you pick.</dd>
          </div>
          <div>
            <dt>Newsletter</dt>
            <dd>A one-time email sent to literally everyone in your CRM at once — no list to pick.</dd>
          </div>
          <div>
            <dt>Automations</dt>
            <dd>A separate, rule-based feature that reacts to events (e.g. "application gone stale") and can send its own emails or take other actions automatically — not built or edited here.</dd>
          </div>
        </dl>
        <p className="email-sequences-explainer__footnote">
          All four now send through the same protected delivery system, so the same spam
          protections, sending limits, and compliance footer apply no matter which one you use.
        </p>
      </DashboardCard>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="discovery-notice">{notice}</p> : null}

      {loading ? <p>Loading…</p> : sequences.length ? (
        <div className="email-sequence-list">
          {sequences.map((sequence) => (
            <DashboardCard
              key={sequence._id}
              title={sequence.name}
              action={<span className={`email-sequence-status email-sequence-status--${sequence.status}`}>{STATUS_LABELS[sequence.status] || sequence.status}</span>}
            >
              <p className="email-sequence-description">{sequence.description || `${sequence.steps.length} step${sequence.steps.length === 1 ? "" : "s"}`}</p>
              <div className="email-sequence-counts">
                <span><strong>{sequence.enrollmentCounts?.active || 0}</strong> active</span>
                <span><strong>{sequence.enrollmentCounts?.completed || 0}</strong> completed</span>
                <span><strong>{sequence.enrollmentCounts?.stopped || 0}</strong> stopped</span>
                <span><strong>{sequence.enrollmentCounts?.failed || 0}</strong> failed</span>
              </div>
              <div className="email-sequence-actions">
                <Button size="sm" variant="outline" onClick={() => openEditSequence(sequence)}>Edit steps</Button>
                <Button size="sm" variant="outline" onClick={() => { navigate(`/email-sequences/${sequence._id}`); openEnrollments(sequence); }}>View enrollments</Button>
                {sequence.status === "active" ? <Button size="sm" variant="outline" onClick={() => toggleSequenceStatus(sequence, "paused")}>Pause</Button> : null}
                {sequence.status !== "active" && sequence.status !== "archived" ? <Button size="sm" onClick={() => toggleSequenceStatus(sequence, "active")}>{sequence.status === "draft" ? "Activate" : "Resume"}</Button> : null}
              </div>
            </DashboardCard>
          ))}
        </div>
      ) : (
        <p>No email sequences yet. Create one, then enroll contacts from the CRM's bulk actions.</p>
      )}

      {detailSequence ? (
        <DashboardCard title={`Enrollments — ${detailSequence.name}`} action={<Button variant="outline" size="sm" onClick={() => { setDetailSequence(null); navigate("/email-sequences"); }}>Close</Button>}>
          {enrollmentsLoading ? <p>Loading…</p> : enrollments.length ? (
            <table className="email-sequence-enrollment-table">
              <thead>
                <tr><th>Contact</th><th>Status</th><th>Step</th><th>Next action</th><th /></tr>
              </thead>
              <tbody>
                {enrollments.map((enrollment) => (
                  <tr key={enrollment._id}>
                    <td>{contactName(enrollment.contactId)}<small>{enrollment.contactId?.email}</small></td>
                    <td><span className={`email-sequence-status email-sequence-status--${enrollment.status}`}>{ENROLLMENT_STATUS_LABELS[enrollment.status] || enrollment.status}</span>{enrollment.stoppedReason ? <small>{enrollment.stoppedReason}</small> : null}</td>
                    <td>{enrollment.currentStepIndex + 1} of {detailSequence.steps.length}</td>
                    <td>{enrollment.status === "active" ? new Date(enrollment.nextActionDueAt).toLocaleString() : "—"}</td>
                    <td className="email-sequence-enrollment-table__actions">
                      {enrollment.status === "active" ? <Button size="sm" variant="outline" loading={enrollmentBusyId === enrollment._id} onClick={() => actOnEnrollment(enrollment, "pause")}>Pause</Button> : null}
                      {enrollment.status === "paused" ? <Button size="sm" variant="outline" loading={enrollmentBusyId === enrollment._id} onClick={() => actOnEnrollment(enrollment, "resume")}>Resume</Button> : null}
                      {["active", "paused"].includes(enrollment.status) ? <Button size="sm" variant="outline" loading={enrollmentBusyId === enrollment._id} onClick={() => actOnEnrollment(enrollment, "stop")}>Stop</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p>No one is enrolled in this sequence yet — select contacts in the CRM and choose "Add to sequence."</p>}
        </DashboardCard>
      ) : null}

      <Modal
        isOpen={Boolean(editingSequence)}
        onClose={() => setEditingSequence(null)}
        title={editingSequence?._id ? "Edit sequence" : "New email sequence"}
        size="workspace"
        footer={<>
          <Button variant="outline" onClick={() => setEditingSequence(null)} disabled={saving}>Cancel</Button>
          <Button onClick={saveSequence} loading={saving}>Save sequence</Button>
        </>}
      >
        {editingSequence ? (
          <div className="email-sequence-form">
            <label className="form-field">
              <span>Sequence name</span>
              <input value={editingSequence.name} onChange={(event) => setEditingSequence({ ...editingSequence, name: event.target.value })} placeholder="e.g. New lead nurture" />
            </label>
            <label className="form-field">
              <span>Description (optional)</span>
              <input value={editingSequence.description || ""} onChange={(event) => setEditingSequence({ ...editingSequence, description: event.target.value })} />
            </label>
            <label className="email-sequence-form__checkbox">
              <input type="checkbox" checked={editingSequence.stopOnReply} onChange={(event) => setEditingSequence({ ...editingSequence, stopOnReply: event.target.checked })} />
              Stop the sequence automatically if the contact replies
            </label>

            <h3>Steps</h3>
            <p className="email-sequence-form__steps-hint">
              Each step fires this many days after the step before it (step 1 fires on enrollment day).
            </p>
            <div className="email-sequence-timeline">
              {editingSequence.steps.map((step, index) => (
                <div className="email-sequence-timeline__item" key={index}>
                  <div className="email-sequence-timeline__rail">
                    <span className="email-sequence-timeline__marker">{index + 1}</span>
                    {index < editingSequence.steps.length - 1 ? <i className="email-sequence-timeline__line" /> : null}
                  </div>
                  <div className="email-sequence-timeline__content">
                    <header>
                      <label className="email-sequence-timeline__delay">
                        Send
                        <input type="number" min="0" max="365" value={step.delayDays} onChange={(event) => updateStep(index, { delayDays: Number(event.target.value) })} />
                        day{step.delayDays === 1 ? "" : "s"} after {index === 0 ? "enrollment" : "the previous step"}
                      </label>
                      {editingSequence.steps.length > 1 ? <Button size="sm" variant="outline" onClick={() => removeStep(index)}>Remove step</Button> : null}
                    </header>
                    <label className="form-field">
                      <span>Subject</span>
                      <input value={step.subject} onChange={(event) => updateStep(index, { subject: event.target.value })} placeholder="{{firstName}}, ..." />
                    </label>
                    <label className="form-field">
                      <span>Message</span>
                      <textarea rows={6} value={step.body} onChange={(event) => updateStep(index, { body: event.target.value })} placeholder={"Hi {{firstName}},\n\n..."} />
                      <small>Tokens: {"{{firstName}}"}, {"{{lastName}}"}, {"{{company}}"}</small>
                    </label>
                  </div>
                </div>
              ))}
              <div className="email-sequence-timeline__item email-sequence-timeline__item--add">
                <div className="email-sequence-timeline__rail">
                  <span className="email-sequence-timeline__marker email-sequence-timeline__marker--add">+</span>
                </div>
                <div className="email-sequence-timeline__content">
                  <Button variant="outline" onClick={addStep}>Add another step</Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
