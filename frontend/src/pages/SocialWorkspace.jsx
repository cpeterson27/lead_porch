import { useEffect, useState } from "react";
import { FaFacebookF, FaInstagram } from "react-icons/fa6";
import {
  FunnelChart,
  Funnel,
  Cell,
  LabelList,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import { Link, NavLink, useParams, useSearchParams } from "react-router-dom";
import SocialLeads from "./SocialLeads.jsx";
import Content from "./Content.jsx";
import SocialConnectedAccounts from "../components/SocialConnectedAccounts.jsx";
import SocialReplyComposer from "../components/SocialReplyComposer.jsx";
import Modal from "../components/Modal.jsx";
import Button from "../components/Button.jsx";
import SocialOnboardingSettings from "../components/SocialOnboardingSettings.jsx";
import SocialAutomationControls from "../components/SocialAutomationControls.jsx";
import SocialDistributionForm from "../components/SocialDistributionForm.jsx";
import SocialAutomation from "./SocialAutomation.jsx";
import {
  refreshInstagramAuthorization,
  fetchSocialWorkspace,
  mutateSocialWorkspace,
  getSocialInboxStreamUrl,
  beginSocialConnection,
  disconnectSocialConnection,
  selectSocialAssets,
  fetchContentBriefs,
  cancelSocialContent,
  scheduleSocialContent,
  fetchGrowthAnalytics,
} from "../services/api.js";
import "./SocialWorkspace.css";

const sections = [
  ["overview", "Overview"],
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
const currency = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
const STAGE_LABELS = {
  interactions: "Interactions",
  conversations: "Conversations",
  leads: "Leads",
  applications: "Applications",
  calls_booked: "Booked calls",
  enrollments: "Enrollments",
};
const PLATFORM_ICONS = { facebook: FaFacebookF, instagram: FaInstagram };
const FUNNEL_COLORS = ["#1f5c50", "#2f7566", "#3f8f7d", "#5aab93", "#7fc4ad", "#a8dcc9"];
function FunnelTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="social-funnel-tooltip">
      <strong>{row.name}</strong>
      <span>{row.value}</span>
      {row.rateLabel ? <small>{row.rateLabel}</small> : null}
    </div>
  );
}
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
    [busy, setBusy] = useState(false),
    [pendingDeleteId, setPendingDeleteId] = useState(null),
    [deleting, setDeleting] = useState(false),
    [growth, setGrowth] = useState(null),
    [growthError, setGrowthError] = useState("");
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
  useEffect(() => {
    if (section !== "analytics") return undefined;
    let active = true;
    fetchGrowthAnalytics()
      .then((value) => {
        if (active) {
          setGrowth(value);
          setGrowthError("");
        }
      })
      .catch(() => {
        if (active) setGrowthError("CTA performance data could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [section]);
  // Live inbox updates: the backend pushes a notice over Server-Sent Events
  // the instant a new message is saved, so the list and any open conversation
  // refresh immediately rather than on a fixed polling interval (which
  // browsers throttle heavily in a backgrounded tab — the most likely reason
  // a message previously needed a manual page refresh to appear). A
  // visibility listener and a long-interval fallback cover the rare case
  // where the stream itself drops without the browser noticing.
  useEffect(() => {
    if (section !== "inbox") return undefined;
    let active = true;
    const listEndpoint = `inbox?filter=${filter}&provider=${provider}`;
    const refresh = () => {
      fetchSocialWorkspace(listEndpoint)
        .then((value) => {
          if (active) setData(value);
        })
        .catch(() => {});
      if (selected)
        fetchSocialWorkspace(`inbox/${selected}`)
          .then((value) => {
            if (active) setDetail(value);
          })
          .catch(() => {});
    };
    const source = new EventSource(getSocialInboxStreamUrl(), {
      withCredentials: true,
    });
    source.onmessage = refresh;
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const fallback = setInterval(refresh, 60000);
    return () => {
      active = false;
      source.close();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(fallback);
    };
  }, [section, selected, filter, provider]);
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
  const confirmDeleteMessage = async () => {
    const messageId = pendingDeleteId;
    if (!messageId) return;
    setDeleting(true);
    try {
      const result = await mutateSocialWorkspace(
        `inbox/${detail.thread._id}/messages/${messageId}/delete`,
        {},
      );
      if (result.threadDeleted) {
        setDetail(null);
        setSelected(null);
        setData(
          await fetchSocialWorkspace(
            `inbox?filter=${filter}&provider=${provider}`,
          ),
        );
      } else {
        await openThread(detail.thread);
      }
      setPendingDeleteId(null);
    } catch {
      setError("Could not delete this message.");
    } finally {
      setDeleting(false);
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

      {section === "content" || section === "create" ? (
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
          {growth ? (
            (() => {
              const stageValue = (key) =>
                growth.socialFunnel.stages.find((row) => row.key === key)
                  ?.value ?? 0;
              const kpis = [
                { key: "interactions", label: "Interactions", value: stageValue("interactions") },
                { key: "conversations", label: "Conversations", value: stageValue("conversations") },
                { key: "leads", label: "Leads", value: stageValue("leads") },
                { key: "applications", label: "Applications", value: stageValue("applications") },
                { key: "calls_booked", label: "Booked calls", value: stageValue("calls_booked") },
                { key: "enrollments", label: "Enrollments", value: stageValue("enrollments") },
                { key: "revenue", label: "Revenue", value: currency(growth.socialFunnel.revenue) },
              ];
              const ctas = [...(growth.socialFunnel.byCta || [])].sort(
                (a, b) =>
                  b.interactionToLeadRate - a.interactionToLeadRate ||
                  b.leads - a.leads,
              );
              const [topCta, ...restCta] = ctas;
              const platforms = (growth.attribution.social || []).filter(
                (row) => row.source === "facebook" || row.source === "instagram",
              );
              const funnelData = growth.socialFunnel.stages.map((stage, index) => ({
                name: STAGE_LABELS[stage.key] || human(stage.key),
                value: stage.value,
                rateLabel:
                  index > 0
                    ? `${growth.socialFunnel.conversions[index - 1].rate}% of ${(
                        STAGE_LABELS[growth.socialFunnel.stages[index - 1].key] || ""
                      ).toLowerCase()}`
                    : "100% of interactions",
              }));
              return (
                <>
                  <div className="social-stat-grid">
                    {kpis.map((kpi) => (
                      <article key={kpi.key}>
                        <strong>{kpi.value}</strong>
                        <span>{kpi.label}</span>
                      </article>
                    ))}
                  </div>

                  <div className="social-panel social-funnel-panel">
                    <h3>Social funnel</h3>
                    <p>
                      How a CTA keyword trigger turns into a conversation, a
                      lead, an application, a booked call, and an enrollment —
                      from real CRM and comment/DM activity.
                    </p>
                    <div className="social-funnel-chart">
                      <ResponsiveContainer width="100%" height={280}>
                        <FunnelChart>
                          <RechartsTooltip content={<FunnelTooltip />} />
                          <Funnel dataKey="value" data={funnelData} isAnimationActive>
                            <LabelList
                              position="right"
                              dataKey="name"
                              fill="var(--color-text)"
                              stroke="none"
                              fontSize={13}
                              fontWeight={700}
                            />
                            {funnelData.map((entry, index) => (
                              <Cell key={entry.name} fill={FUNNEL_COLORS[index % FUNNEL_COLORS.length]} />
                            ))}
                          </Funnel>
                        </FunnelChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="social-funnel-detail">
                      {growth.socialFunnel.stages.map((stage, index) => (
                        <div className="social-funnel-detail__item" key={stage.key}>
                          <span
                            className="social-funnel-detail__dot"
                            style={{ background: FUNNEL_COLORS[index % FUNNEL_COLORS.length] }}
                          />
                          <span className="social-funnel-detail__label">
                            {STAGE_LABELS[stage.key] || human(stage.key)}
                          </span>
                          <strong>{stage.value}</strong>
                          {index > 0 ? (
                            <small>{growth.socialFunnel.conversions[index - 1].rate}% conv.</small>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="social-panel social-cta-panel">
                    <h3>CTA performance</h3>
                    {topCta ? (
                      <>
                        <div className="social-cta-highlight">
                          <strong>
                            “{topCta.label}” is your highest-converting CTA
                          </strong>
                          <p>
                            {topCta.interactions} interactions →{" "}
                            {topCta.conversations} conversations →{" "}
                            {topCta.leads} leads → {topCta.applications}{" "}
                            applications
                          </p>
                          <span>
                            {topCta.interactionToLeadRate}%
                            interaction-to-lead conversion
                          </span>
                        </div>
                        {restCta.length ? (
                          <div style={{ overflowX: "auto" }}>
                            <table className="analytics-table">
                              <thead>
                                <tr>
                                  <th>CTA</th>
                                  <th>Platform</th>
                                  <th>Interactions</th>
                                  <th>Conversations</th>
                                  <th>Leads</th>
                                  <th>Applications</th>
                                  <th>Sales</th>
                                  <th>Revenue</th>
                                  <th>Conversion</th>
                                </tr>
                              </thead>
                              <tbody>
                                {restCta.map((cta) => (
                                  <tr key={cta.automationId}>
                                    <th>{cta.label}</th>
                                    <td>{human(cta.provider)}</td>
                                    <td>{cta.interactions}</td>
                                    <td>{cta.conversations}</td>
                                    <td>{cta.leads}</td>
                                    <td>{cta.applications}</td>
                                    <td>{cta.sales}</td>
                                    <td>{currency(cta.revenue)}</td>
                                    <td>{cta.interactionToLeadRate}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p>
                        No CTA keyword interactions recorded yet. Set up a
                        comment or DM keyword automation to start tracking CTA
                        performance.
                      </p>
                    )}
                  </div>

                  <div className="social-panel">
                    <h3>Facebook vs Instagram</h3>
                    {platforms.length ? (
                      <div className="social-platform-compare">
                        {platforms.map((row) => {
                          const Icon = PLATFORM_ICONS[row.source];
                          return (
                            <article
                              key={row.source}
                              className={`social-platform-card social-platform-card--${row.source}`}
                            >
                              <header>
                                {Icon ? <Icon /> : null}
                                <strong>{human(row.source)}</strong>
                              </header>
                              <dl>
                                <div>
                                  <dt>Leads</dt>
                                  <dd>{row.leads}</dd>
                                </div>
                                <div>
                                  <dt>Applications</dt>
                                  <dd>{row.applications}</dd>
                                </div>
                                <div>
                                  <dt>Sales</dt>
                                  <dd>{row.sales}</dd>
                                </div>
                                <div>
                                  <dt>Revenue</dt>
                                  <dd>{currency(row.revenue)}</dd>
                                </div>
                                <div>
                                  <dt>Conversion</dt>
                                  <dd>{row.conversionRate}%</dd>
                                </div>
                              </dl>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <p>No Facebook or Instagram leads recorded yet.</p>
                    )}
                  </div>

                  <div className="social-panel">
                    <h3>Performance by post</h3>
                    <p>
                      Every post with at least one real comment or DM,
                      individually — from the same live interaction records
                      as the funnel above.
                    </p>
                    {growth.socialFunnel.byPost?.length ? (
                      <div style={{ overflowX: "auto" }}>
                        <table className="analytics-table">
                          <thead>
                            <tr>
                              <th>Post</th>
                              <th>Platform</th>
                              <th>Interactions</th>
                              <th>Conversations</th>
                              <th>Leads</th>
                              <th>Applications</th>
                              <th>Sales</th>
                              <th>Revenue</th>
                            </tr>
                          </thead>
                          <tbody>
                            {growth.socialFunnel.byPost.map((post) => (
                              <tr key={post.contentBriefId}>
                                <th>{post.title}</th>
                                <td>
                                  {post.providers.map((provider) => {
                                    const Icon = PLATFORM_ICONS[provider];
                                    return Icon ? (
                                      <Icon
                                        key={provider}
                                        title={human(provider)}
                                        style={{ marginRight: 4 }}
                                      />
                                    ) : null;
                                  })}
                                </td>
                                <td>{post.interactions}</td>
                                <td>{post.conversations}</td>
                                <td>{post.leads}</td>
                                <td>{post.applications}</td>
                                <td>{post.sales}</td>
                                <td>{currency(post.revenue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p>
                        No individual post has a recorded comment or DM yet.
                      </p>
                    )}
                  </div>
                </>
              );
            })()
          ) : growthError ? (
            <p role="alert" className="form-error">
              {growthError}
            </p>
          ) : (
            <p>Loading CTA performance…</p>
          )}

          <div className="social-analytics-secondary">
            <div className="social-panel social-panel--secondary">
              <h3>Known social attribution</h3>
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
            <div className="social-panel social-panel--secondary">
              <h3>Connected account insights</h3>
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
                  No selected Facebook or Instagram account insights are
                  available yet.
                </p>
              )}
            </div>
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
                      {row.postTitle ? ` · From: ${row.postTitle}` : ""}
                    </small>
                  </button>
                ))}
              {Array.isArray(data) && !data.length && (
                <p>No matching social conversations.</p>
              )}
            </section>
            <section className="social-conversation-pane">
              {detail ? (
                (() => {
                  const identity = detail.identity;
                  const contactName =
                    detail.thread.contactIds?.[0]?.name || "Conversation";
                  const profileLink =
                    identity?.username && detail.thread.channel === "instagram"
                      ? `https://instagram.com/${identity.username}`
                      : null;
                  return (
                    <>
                      <header className="social-conversation-header">
                        <span className="social-conversation-avatar" aria-hidden="true">
                          {identity?.avatarUrl ? (
                            <img src={identity.avatarUrl} alt="" referrerPolicy="no-referrer" />
                          ) : (
                            contactName.charAt(0).toUpperCase()
                          )}
                        </span>
                        <div>
                          <h2>{contactName}</h2>
                          <span>
                            {human(detail.thread.channel)} conversation
                            {identity?.username ? ` · @${identity.username}` : ""}
                          </span>
                          {profileLink && (
                            <a
                              className="social-conversation-profile-link"
                              href={profileLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View Instagram profile
                            </a>
                          )}
                          {!profileLink && detail.thread.channel === "facebook" && (
                            <span className="social-conversation-profile-note">
                              Facebook does not provide a profile link for
                              message senders.
                            </span>
                          )}
                          {detail.thread.metadata?.postContext ? (
                            <p className="social-conversation-origin">
                              From your post:{" "}
                              <a
                                href={detail.thread.metadata.postContext.permalink}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {detail.thread.metadata.postContext.text ||
                                  "View post"}
                              </a>
                            </p>
                          ) : detail.thread.postTitle ? (
                            <p className="social-conversation-origin">
                              From your post: {detail.thread.postTitle}
                            </p>
                          ) : null}
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
                                  onClick={() => setPendingDeleteId(message._id)}
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
                  );
                })()
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
      <Modal
        isOpen={Boolean(pendingDeleteId)}
        onClose={() => setPendingDeleteId(null)}
        title="Delete this message?"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setPendingDeleteId(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmDeleteMessage}
              loading={deleting}
            >
              Delete message
            </Button>
          </>
        }
      >
        <p>
          This removes the message from Lead Porch only. Instagram and
          Facebook do not offer any way for a business to unsend a message
          on their side, so the recipient will still have their copy.
        </p>
      </Modal>
    </main>
  );
}
