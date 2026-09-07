import { useEffect, useState } from "react";
import { Link, NavLink, useParams, useSearchParams } from "react-router-dom";
import SocialLeads from "./SocialLeads.jsx";
import Content from "./Content.jsx";
import SocialConnectedAccounts from "../components/SocialConnectedAccounts.jsx";
import SocialStudio from "./SocialStudio.jsx";
import SocialReplyComposer from "../components/SocialReplyComposer.jsx";
import SocialOnboardingSettings from "../components/SocialOnboardingSettings.jsx";
import SocialAutomationControls from "../components/SocialAutomationControls.jsx";
import SocialDistributionForm from "../components/SocialDistributionForm.jsx";
import SocialAutomation from "./SocialAutomation.jsx";
import {
  refreshInstagramAuthorization,
  fetchSocialWorkspace,
  mutateSocialWorkspace,
  beginSocialConnection,
  disconnectSocialConnection,
  selectSocialAssets,
  fetchContentBriefs,
  cancelSocialContent,
  scheduleSocialContent,
} from "../services/api.js";
import "./SocialWorkspace.css";

const sections = [
  ["overview", "Overview"],
  ["create", "Create post"],
  ["leads", "Leads"],
  ["calendar", "Calendar"],
  ["content", "Content"],
  ["inbox", "Inbox"],
  ["automations", "Automations"],
  ["distribution", "Ambassadors"],
  ["analytics", "Analytics"],
  ["accounts", "Connected accounts"],
  ["settings", "Setup center"],
];
const human = (value) => String(value || "").replaceAll("_", " ");
const date = (value) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
export default function SocialWorkspace({ connectionsOnly = false, section: sectionProp }) {
  const { section: sectionParam = "overview" } = useParams();
  const section = sectionProp || sectionParam;
  const [params] = useSearchParams();
  const threadId = params.get("thread");
  const [scheduleDates, setScheduleDates] = useState({});
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [filter, setFilter] = useState(""),
    [provider, setProvider] = useState(""),
    [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [busy, setBusy] = useState(false);
  const oauthStatus = connectionsOnly ? params.get("status") : "";
  const oauthProvider = params.get("social") || "social account";
  const providerName = oauthProvider === "meta" ? "Facebook + Instagram" : oauthProvider === "linkedin" ? "LinkedIn" : oauthProvider === "instagram" ? "Instagram" : oauthProvider === "x" ? "X" : "Social account";
  const oauthNotice = oauthStatus === "connected" ? `${providerName} connected. Choose the account Lead Porch should use.` : "";
  const oauthError = oauthStatus === "denied" ? `${providerName} authorization was cancelled. You can connect it when you are ready.` : oauthStatus === "failed" ? params.get("message") || `${providerName} connection failed. Try again or ask the app administrator to verify provider configuration.` : "";
  useEffect(() => {
    let active = true;
    if (section === "inbox" && threadId)
      fetchSocialWorkspace(`inbox/${threadId}`)
        .then((value) => {
          if (active) {
            setDetail(value);
            setSelected(threadId);
          }
        })
        .catch(() => {
          if (active) setError("Conversation unavailable.");
        });
    return () => {
      active = false;
    };
  }, [section, threadId]);
  useEffect(() => {
    let active = true;
    const endpoint =
      section === "overview"
        ? "overview"
        : section === "settings"
          ? "accounts"
          : section === "inbox"
            ? `inbox?filter=${filter}&provider=${provider}`
            : section;
    if (["create", "content", "automations", "leads"].includes(section)) return;
    const request =
      section === "calendar"
        ? fetchContentBriefs("social").then((result) => result.data || [])
        : fetchSocialWorkspace(endpoint);
    request
      .then((value) => {
        if (active) {
          setData(value);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError(connectionsOnly ? "Connected Accounts could not load. Refresh the page or ask the workspace owner to verify this review account's Social access." : "Unable to load this Social area.");
      });
    return () => {
      active = false;
    };
  }, [section, filter, provider, connectionsOnly]);
  const action = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setData(await fetchSocialWorkspace("accounts"));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update account.");
    } finally {
      setBusy(false);
    }
  };
  const openThread = async (row) => {
    setSelected(row._id);
    try {
      setDetail(await fetchSocialWorkspace(`inbox/${row._id}`));
    } catch {
      setError("Conversation unavailable.");
    }
  };
  const deleteMessage = async (messageId) => {
    if (
      !window.confirm(
        "Delete this message from Lead Porch? This only removes it from your inbox here — Instagram and Facebook have no way for a business to unsend a message, so the recipient still has their copy.",
      )
    )
      return;
    try {
      await mutateSocialWorkspace(
        `inbox/${detail.thread._id}/messages/${messageId}/delete`,
        {},
      );
      await openThread(detail.thread);
    } catch {
      setError("Could not delete this message.");
    }
  };
  return (
    <main className="social-workspace">
      <header>
        <p className="page-eyebrow">Lead Porch</p>
        <h1 className="page-title">Social</h1>
        <p className="page-subtitle">
          Connect and manage the social accounts Lead Porch can use for
          content, conversations, and automations.
        </p>
      </header>

      {!connectionsOnly ? (
        <nav aria-label="Social workspace">
          {sections.map(([key, label]) => (
            <NavLink
              key={key}
              to={`/social/${key}`}
              end
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      ) : null}

      {(error || oauthError) && (
        <p role="alert" className="form-error">
          {error || oauthError}
        </p>
      )}
      {oauthNotice ? <p role="status" className="discovery-notice">{oauthNotice}</p> : null}

      {section === "leads" && (
        <div className="social-panel">
          <SocialLeads />
        </div>
      )}

      {section === "create" ? (
        <div className="social-panel">
          <SocialStudio />
        </div>
      ) : section === "content" ? (
        <div className="social-panel">
          <Content />
        </div>
      ) : null}

      {section === "automations" ? (
        <div className="social-panel">
          <SocialAutomation />
          <Link to="/automations">
            Open workflow builder and execution history
          </Link>
        </div>
      ) : null}

      {["overview", "analytics"].includes(section) && data?.counts ? (
        <>
          <div className="social-stat-grid">
            {Object.entries(data.counts).map(([key, value]) => (
              <article key={key}>
                <strong>{value}</strong>
                <span>{human(key.replace(/([A-Z])/g, " $1"))}</span>
              </article>
            ))}
          </div>
          <p>
            Counts reflect stored activity. Content counts cover the latest{" "}
            {data.boundedContentCount} items. Reach, impressions, likes, and
            inferred conversions are not fabricated.
          </p>
          <div className="social-panel">
            <h2>
              {section === "analytics"
                ? "Known social activity"
                : "Recent activity"}
            </h2>
            {data.activity?.length ? (
              data.activity.map((row) => (
                <article key={row._id}>
                  <strong>{row.title}</strong>
                  <small>{date(row.occurredAt)}</small>
                  {row.contactId ? (
                    <Link to={`/crm/contacts/${row.contactId}`}>
                      Open CRM contact
                    </Link>
                  ) : null}
                </article>
              ))
            ) : (
              <p>No recorded social activity yet.</p>
            )}
          </div>
        </>
      ) : null}

      {section === "analytics" && data?.rows ? (
        <>
          <div className="social-panel">
            <h2>Known social attribution</h2>
            <p>{data.attributionNote}</p>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Interactions</th>
                    <th>Contacts</th>
                    <th>Tracked clicks</th>
                    <th>Applications</th>
                    <th>Linked enrollments</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.provider}>
                      <th>{row.provider}</th>
                      <td>{row.interactions}</td>
                      <td>{row.identifiableContacts}</td>
                      <td>{row.trackedClicks}</td>
                      <td>{row.attributedApplications}</td>
                      <td>{row.linkedEnrollments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="social-panel">
            <h2>Connected account insights</h2>
            <p>{data.metricsNote}</p>
            {data.providerInsights?.assets?.length ? (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Followers</th>
                      <th>Reach</th>
                      <th>Engagements</th>
                      <th>Profile views</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providerInsights.assets.map((row) => (
                      <tr key={`${row.provider}:${row.assetId}`}>
                        <th>{row.assetName || row.provider}</th>
                        <td>{row.followers ?? "—"}</td>
                        <td>{row.reach ?? "—"}</td>
                        <td>{row.engagements ?? "—"}</td>
                        <td>{row.profileViews ?? "—"}</td>
                        <td>
                          {row.status === "available"
                            ? "Available"
                            : row.status === "permission_required"
                              ? "Permission required"
                              : "Unavailable"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>
                No selected Facebook or Instagram account insights are available
                yet.
              </p>
            )}
          </div>
        </>
      ) : null}

      {section === "calendar" && Array.isArray(data) ? (
        <div className="social-panel">
          <h2>Content calendar</h2>
          <label>
            Network
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">All networks</option>
              {["instagram", "facebook", "linkedin", "x"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          {data
            .filter(
              (row) =>
                row.social?.requestedPublishAt &&
                (!provider ||
                  row.social.destinations?.some(
                    (d) => d.provider === provider,
                  )),
            )
            .sort(
              (a, b) =>
                new Date(a.social.requestedPublishAt) -
                new Date(b.social.requestedPublishAt),
            )
            .map((row) => (
              <article key={row._id}>
                <div>
                  <h3>{row.title}</h3>
                  <p>
                    {date(row.social.requestedPublishAt)} · {human(row.status)}
                  </p>
                  <Link to={`/social/content?content=${row._id}`}>
                    Open content
                  </Link>
                </div>
                {row.status === "scheduled" ? (
                  <div>
                    <button
                      onClick={async () => {
                        try {
                          await cancelSocialContent(row._id);
                          setData((await fetchContentBriefs("social")).data);
                        } catch {
                          setError("Unable to cancel schedule.");
                        }
                      }}
                    >
                      Cancel schedule
                    </button>
                    <label>
                      Reschedule
                      <input
                        type="datetime-local"
                        onChange={(e) => {
                          setScheduleDates({
                            ...scheduleDates,
                            [row._id]: e.target.value,
                          });
                        }}
                      />
                    </label>
                    <button
                      onClick={async () => {
                        if (!scheduleDates[row._id]) return;
                        try {
                          await cancelSocialContent(row._id);
                          await scheduleSocialContent(
                            row._id,
                            new Date(scheduleDates[row._id]).toISOString(),
                          );
                          setData((await fetchContentBriefs("social")).data);
                        } catch {
                          setError(
                            "Reschedule failed. Check the current content status before retrying.",
                          );
                        }
                      }}
                    >
                      Save new time
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          {!data.some((row) => row.social?.requestedPublishAt) ? (
            <p>No scheduled content. Create and approve a draft first.</p>
          ) : null}
        </div>
      ) : null}

      {section === "inbox" ? (
        <div className="social-panel social-inbox-shell">
          <div className="social-inbox-toolbar">
            <div>
              <span className="social-inbox-eyebrow">Messages</span>
              <h2>Social inbox</h2>
            </div>
            <div className="social-filters">
            <label>
              Show
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">All</option>
                <option value="unread">Unread</option>
                <option value="needs_reply">Needs reply</option>
                <option value="assigned">Assigned to me</option>
              </select>
            </label>
            <label>
              Network
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="">All networks</option>
                {["instagram", "facebook", "linkedin", "x"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            </div>
          </div>
          <div className="social-inbox">
            <section className="social-thread-list" aria-label="Social conversations">
              {Array.isArray(data) &&
                data.map((row) => (
                  <button
                    className={selected === row._id ? "selected" : ""}
                    key={row._id}
                    onClick={() => openThread(row)}
                  >
                    <strong>
                      {row.contactIds?.[0]?.name || row.subject || row.channel}
                    </strong>
                    <span>{row.preview}</span>
                    <small>
                      {row.channel} · {date(row.lastMessageAt)} ·{" "}
                      {row.unreadCount} unread
                    </small>
                  </button>
                ))}
              {Array.isArray(data) && !data.length && (
                <p>No matching social conversations.</p>
              )}
            </section>
            <section className="social-conversation-pane">
              {detail ? (
                <>
                  <header className="social-conversation-header">
                    <span className="social-conversation-avatar" aria-hidden="true">
                      {(detail.thread.contactIds?.[0]?.name || "C").charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <h2>{detail.thread.contactIds?.[0]?.name || "Conversation"}</h2>
                      <span>{human(detail.thread.channel)} conversation</span>
                    </div>
                  </header>
                  <div className="social-message-stream">
                    {detail.messages.map((message) => {
                      const inbound = message.direction === "inbound";
                      const sender = inbound
                        ? message.sender?.name || "Contact"
                        : message.metadata?.senderType === "automation"
                          ? "Lead Porch automation"
                          : message.createdBy?.name || "Team";
                      return (
                        <article
                          className={`social-message ${inbound ? "social-message--inbound" : "social-message--outbound"}`}
                          key={message._id}
                        >
                          <div className="social-message-head">
                            <strong>{sender}</strong>
                            <button
                              type="button"
                              className="social-message-delete"
                              aria-label="Delete this message from Lead Porch"
                              onClick={() => deleteMessage(message._id)}
                            >
                              Delete
                            </button>
                          </div>
                          <div className="social-message-bubble"><p>{message.body}</p></div>
                          <small>{date(message.createdAt)} · {message.deliveryStatus}</small>
                        </article>
                      );
                    })}
                  </div>
                  <div className="social-composer-dock">
                    <SocialReplyComposer
                      key={detail.thread._id}
                      thread={detail.thread}
                      initialAnalysis={detail.socialAi}
                      onSent={() => openThread(detail.thread)}
                    />
                  </div>
                </>
              ) : (
                <p className="social-inbox-empty">
                  Select a conversation to see the exact incoming and outgoing
                  messages.
                </p>
              )}
            </section>
          </div>
        </div>
      ) : null}

      {["accounts", "settings"].includes(section) && data?.connections ? (
        <div className="social-panel">
          <SocialConnectedAccounts
            data={data}
            busy={busy}
            onRefresh={() => action(() => refreshInstagramAuthorization())}
            onConnect={(provider) =>
              action(async () => {
                const result = await beginSocialConnection(provider);
                window.location.assign(result.authorizationUrl);
              })
            }
            onDisconnect={(provider) =>
              action(() => disconnectSocialConnection(provider))
            }
            onSelectAssets={(provider, ids) =>
              action(() => selectSocialAssets(provider, ids))
            }
          />
        </div>
      ) : null}

      {section === "settings" ? (
        <div className="social-panel">
          <SocialAutomationControls />
          <SocialOnboardingSettings />
        </div>
      ) : null}

      {section === "distribution" ? (
        <div className="social-panel">
          <SocialDistributionForm />
        </div>
      ) : null}

      {section === "distribution" && Array.isArray(data) ? (
        <div className="social-panel">
          <h2>Ambassador content tasks</h2>
          <p>
            Assign reviewed content from the Content Library. Ambassadors
            publish to their own accounts themselves.
          </p>
          {data.map((task) => (
            <article key={task._id}>
              <h3>{task.title}</h3>
              <p>
                {task.ambassadorProfileId?.displayName} · {human(task.status)} ·
                Due {date(task.dueAt)}
              </p>
              {task.postUrl && (
                <a href={task.postUrl} target="_blank" rel="noreferrer">
                  Submitted post
                </a>
              )}
            </article>
          ))}
          {!data.length && <p>No content tasks assigned yet.</p>}
        </div>
      ) : null}
    </main>
  );
}
