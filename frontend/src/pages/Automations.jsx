import { useEffect, useRef, useState } from "react";
import {
  createAutomation,
  createAutomationFromTemplate,
  fetchAutomationCatalog,
  fetchAutomationExecutions,
  fetchAutomations,
  retryAutomationExecution,
  updateAutomation,
  updateAutomationStatus,
} from "../services/api.js";
import { Link } from "react-router-dom";
import useAuth from "../context/useAuth.js";
import { hasPermission } from "../utils/roleAccess.js";
import "./Automations.css";
const readConfig = (value) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const label = (value) => value.replaceAll(".", " · ").replaceAll("_", " ");

const EMPTY = {
  id: "",
  name: "",
  description: "",
  trigger: "contact.created",
  conditionField: "",
  conditionOperator: "equals",
  conditionValue: "",
  actionType: "contact.add_tag",
  delayMinutes: 0,
  actionConfig: '{"tag":"new-lead"}',
  actionsJson: "",
};
function definition(form) {
  let config;
  let actions;
  try {
    config = JSON.parse(form.actionConfig || "{}");
    actions = form.actionsJson
      ? JSON.parse(form.actionsJson)
      : [
          {
            type: form.actionType,
            delayMinutes: Number(form.delayMinutes) || 0,
            config,
          },
        ];
  } catch {
    throw new Error("Action configuration must be valid JSON.");
  }
  if (!Array.isArray(actions))
    throw new Error("Ordered actions must be a JSON array.");
  return {
    name: form.name,
    description: form.description,
    trigger: { eventType: form.trigger },
    conditions: form.conditionField
      ? [
          {
            field: form.conditionField,
            operator: form.conditionOperator,
            value: form.conditionValue,
          },
        ]
      : [],
    actions,
  };
}

export default function Automations() {
  const { session } = useAuth();
  const editorRef = useRef(null);
  const [pendingStatus, setPendingStatus] = useState({});
  const [catalog, setCatalog] = useState(null);
  const [automations, setAutomations] = useState([]);
  const [executions, setExecutions] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const [nextCatalog, nextAutomations, nextExecutions] = await Promise.all([
      fetchAutomationCatalog(),
      fetchAutomations(),
      fetchAutomationExecutions(),
    ]);
    setCatalog(nextCatalog);
    setAutomations(nextAutomations);
    setExecutions(nextExecutions);
    setLoading(false);
  };
  useEffect(() => {
    let active = true;
    Promise.all([
      fetchAutomationCatalog(),
      fetchAutomations(),
      fetchAutomationExecutions(),
    ])
      .then(([nextCatalog, nextAutomations, nextExecutions]) => {
        if (active) {
          setCatalog(nextCatalog);
          setAutomations(nextAutomations);
          setExecutions(nextExecutions);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setMessage("Automations could not be loaded.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async (event) => {
    event.preventDefault();
    try {
      const values = definition(form);
      if (form.id) await updateAutomation(form.id, values);
      else await createAutomation(values);
      setForm(EMPTY);
      setMessage("Automation saved as a draft.");
      await load();
    } catch (error) {
      setMessage(error.response?.data?.error || error.message);
    }
  };
  const edit = (item) => {
    setForm({
      id: item._id,
      name: item.name,
      description: item.description || "",
      trigger: item.trigger.eventType,
      conditionField: item.conditions?.[0]?.field || "",
      conditionOperator: item.conditions?.[0]?.operator || "equals",
      conditionValue: item.conditions?.[0]?.value ?? "",
      actionType: item.actions?.[0]?.type || "contact.add_tag",
      delayMinutes: item.actions?.[0]?.delayMinutes || 0,
      actionConfig: JSON.stringify(item.actions?.[0]?.config || {}, null, 2),
      actionsJson: JSON.stringify(item.actions || [], null, 2),
    });
    requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      editorRef.current?.querySelector("input")?.focus({ preventScroll: true });
    });
  };
  const toggleStatus = async (item) => {
    setPendingStatus((current) => ({ ...current, [item._id]: true }));
    try {
      const status = item.status === "enabled" ? "disabled" : "enabled";
      await updateAutomationStatus(item._id, status);
      setAutomations((current) => current.map((entry) => entry._id === item._id ? { ...entry, status } : entry));
      setMessage(`${item.name} ${status}.`);
    } catch (error) {
      setMessage(error.response?.data?.error || "The status could not be saved. Please try again.");
    } finally {
      setPendingStatus((current) => ({ ...current, [item._id]: false }));
    }
  };
  if (loading)
    return (
      <main className="automations-page">
        <p>Loading automations…</p>
      </main>
    );
  return (
    <main className="automations-page">
      <header>
        <div>
          <p className="eyebrow">Workflows</p>
          <h1>Automations</h1>
          <p>
            Choose a starting point, decide who it applies to, and select the follow-up.
          </p>
        </div>
        <span>New workflows start disabled</span>
      </header>
      {message ? (
        <div className="automation-notice" role="status">
          {message}
        </div>
      ) : null}
      <section className="automation-panel">
        <h2>How this connects to social leads</h2>
        <p>
          Use Social Automation to capture a Meta comment or message and send
          any permitted reply. Use this page for the CRM work that follows, such
          as tags, tasks, notifications, campaigns, and follow-up.
        </p>
        <Link to="/social-automation">Configure social lead capture</Link>
      </section>
      <section className="automation-panel">
        <h2>Starter workflows</h2>
        <p>
          Ambassador onboarding starts with an invitation, reminds them to
          complete their profile, and prepares introduction content for review.
        </p>
        {hasPermission(session, "ambassadors.manage") && (
          <Link to="/automations/content-template">
            Edit ambassador introduction template
          </Link>
        )}
        <div className="template-grid">
          {catalog.templates.map((template) => (
            <article key={template.key}>
              <strong>{template.name}</strong>
              <p>{template.description}</p>
              <button
                type="button"
                onClick={async () => {
                  await createAutomationFromTemplate(template.key);
                  setMessage(`${template.name} added as a disabled draft.`);
                  await load();
                }}
              >
                Add draft
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="automation-layout">
        <form ref={editorRef} className="automation-panel" onSubmit={save}>
          <h2>{form.id ? "Edit automation" : "Create automation"}</h2>
          <label>
            Name
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <h3>Start here</h3>
          <label>
            What starts this workflow?
            <select
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value })}
            >
              {catalog.triggers.map((item) => (
                <option key={item} value={item}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          <h3>Who should it apply to? <small>Optional</small></h3>
          <label>
            Field
            <select
              value={form.conditionField}
              onChange={(e) =>
                setForm({ ...form, conditionField: e.target.value })
              }
            >
              <option value="">No condition</option>
              {catalog.conditionFields.map((item) => (
                <option key={item} value={item}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Operator
            <select
              value={form.conditionOperator}
              onChange={(e) =>
                setForm({ ...form, conditionOperator: e.target.value })
              }
            >
              {[
                "equals",
                "not_equals",
                "in",
                "not_in",
                "exists",
                "not_exists",
                "contains",
                "gte",
                "lte",
                "older_than_minutes",
              ].map((item) => (
                <option key={item} value={item}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Value
            <input
              value={form.conditionValue}
              onChange={(e) =>
                setForm({ ...form, conditionValue: e.target.value })
              }
            />
          </label>
          <h3>Choose the follow-up</h3>
          <label>
            Action
            <select
              value={form.actionType}
              onChange={(e) => setForm({ ...form, actionType: e.target.value })}
            >
              {catalog.actions.map((item) => (
                <option key={item} value={item}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delay in minutes
            <input
              type="number"
              min="0"
              value={form.delayMinutes}
              onChange={(e) =>
                setForm({ ...form, delayMinutes: e.target.value })
              }
            />
          </label>
          {!form.actionsJson &&
            [
              "contact.add_tag",
              "contact.remove_tag",
              "task.create",
              "notification.create",
            ].includes(form.actionType) && (
              <label>
                {form.actionType.startsWith("contact.")
                  ? "Tag"
                  : "Task / notification title"}
                <input
                  value={
                    readConfig(form.actionConfig)[
                      form.actionType.startsWith("contact.") ? "tag" : "title"
                    ] || ""
                  }
                  onChange={(e) =>
                    setForm({
                      ...form,
                      actionConfig: JSON.stringify({
                        ...readConfig(form.actionConfig),
                        [form.actionType.startsWith("contact.")
                          ? "tag"
                          : "title"]: e.target.value,
                      }),
                    })
                  }
                />
              </label>
            )}
          <details>
            <summary>Advanced action settings</summary>
            <label>
              Action configuration{" "}
              <small>Structured JSON; no executable code</small>
              <textarea
                rows="6"
                value={form.actionConfig}
                onChange={(e) =>
                  setForm({ ...form, actionConfig: e.target.value })
                }
              />
            </label>
            {form.id ? (
              <label>
                All ordered actions{" "}
                <small>
                  Edit action order, per-action conditions, delays, and
                  configuration as structured JSON.
                </small>
                <textarea
                  rows="12"
                  value={form.actionsJson}
                  onChange={(e) =>
                    setForm({ ...form, actionsJson: e.target.value })
                  }
                />
              </label>
            ) : null}
          </details>
          <button type="submit">
            {form.id ? "Save changes" : "Save draft"}
          </button>
        </form>
        <section className="automation-panel">
          <h2>Configured automations</h2>
          {automations.length ? (
            automations.map((item) => (
              <article className="automation-item" key={item._id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {label(item.trigger.eventType)} · {item.actions.length}{" "}
                    action{item.actions.length === 1 ? "" : "s"}
                  </span>
                  <small>{item.description}</small>
                </div>
                <div className="automation-item-actions">
                  <button type="button" onClick={() => edit(item)}>
                    Edit
                  </button>
                  <button
                    className={item.status === "enabled" ? "is-enabled" : ""}
                    type="button"
                    aria-pressed={item.status === "enabled"}
                    aria-label={`${item.status === "enabled" ? "Disable" : "Enable"} ${item.name}`}
                    disabled={Boolean(pendingStatus[item._id])}
                    aria-busy={Boolean(pendingStatus[item._id])}
                    onClick={() => toggleStatus(item)}
                  >
                    {pendingStatus[item._id] ? "Saving…" : item.status === "enabled" ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p>No automations yet. Add a starter template or create a draft.</p>
          )}
        </section>
      </section>
      <section className="automation-panel">
        <h2>Recent execution history</h2>
        {executions.length ? (
          <div className="execution-list">
            {executions.map((item) => (
              <article key={item._id}>
                <div>
                  <strong>{item.automationId?.name || "Automation"}</strong>
                  <span>
                    {label(item.triggerEventType)} · {item.status}
                  </span>
                  <small>
                    {item.lastError ||
                      `${item.steps?.length || 0} recorded steps`}
                  </small>
                </div>
                {item.status === "failed" &&
                item.attempts < item.maxAttempts ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await retryAutomationExecution(item._id);
                      await load();
                    }}
                  >
                    Retry safely
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p>
            No execution history yet. Enabled workflows begin with newly
            recorded events.
          </p>
        )}
      </section>
    </main>
  );
}
