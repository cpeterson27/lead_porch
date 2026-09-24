import { useEffect, useState } from "react";
import {
  FaFacebookF,
  FaInstagram,
  FaComments,
  FaUserGroup,
  FaClipboardCheck,
  FaPhone,
  FaGraduationCap,
  FaSackDollar,
  FaCircleCheck,
  FaCircleExclamation,
  FaCircleQuestion,
} from "react-icons/fa6";
import {
  Cell,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
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
const FUNNEL_COLORS = ["#235d49", "#1877f2", "#8134af", "#dd2a7b", "#f58529", "#c9a227"];
const KPI_META = {
  interactions: { icon: FaComments, color: "#1877f2" },
  conversations: { icon: FaUserGroup, color: "#8134af" },
  leads: { icon: FaUserGroup, color: "#235d49" },
  applications: { icon: FaClipboardCheck, color: "#dd2a7b" },
  calls_booked: { icon: FaPhone, color: "#f58529" },
  enrollments: { icon: FaGraduationCap, color: "#0a66c2" },
  revenue: { icon: FaSackDollar, color: "#2f6b1f" },
};
const PROVIDER_COLORS = { instagram: "#dd2a7b", facebook: "#1877f2", linkedin: "#0a66c2", x: "#0f1419", tiktok: "#25d3c4" };
const STATUS_META = {
  available: { icon: FaCircleCheck, label: "Available", tone: "published" },
  permission_required: { icon: FaCircleQuestion, label: "Permission required", tone: "pending_approval" },
  authorization_required: { icon: FaCircleQuestion, label: "Reconnect needed", tone: "pending_approval" },
  unavailable: { icon: FaCircleExclamation, label: "Unavailable", tone: "failed" },
};
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
    [growthError, setGrowthError] = useState(""),
    [postEngagement, setPostEngagement] = useState({});
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
    fetchSocialWorkspace("analytics/post-engagement")
      .then((value) => {
        if (active) setPostEngagement(value.engagement || {});
      })
      .catch(() => {});
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
    // Meta will not push a new DM or comment to Lead Porch on its own (see
    // services/socialCommentSyncRunner.js) — a slow background poll covers
    // everyone all the time, but while someone actually has the Inbox open
    // and is watching it, asking Meta directly every few seconds gets a new
    // message showing up within a couple of seconds instead of up to a
    // minute later. SSE (above) then reflects that DB change instantly once
    // it lands, so this is the one remaining real latency source. Paused
    // whenever the tab isn't visible so it doesn't run unattended.
    const fastSync = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      mutateSocialWorkspace("inbox/sync", {}).catch(() => {});
    }, 5000);
    return () => {
      active = false;
      source.close();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(fallback);
      clearInterval(fastSync);
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
                  <div className="social-stat-grid social-stat-grid--kpi">
                    {kpis.map((kpi) => {
                      const meta = KPI_META[kpi.key];
                      const Icon = meta?.icon;
                      return (
                        <article key={kpi.key} style={{ "--kpi-color": meta?.color || "var(--color-brand)" }}>
                          <span className="social-kpi-icon">{Icon ? <Icon /> : null}</span>
                          <strong>{kpi.value}</strong>
                          <span>{kpi.label}</span>
                        </article>
                      );
                    })}
                  </div>
                  <p className="social-kpi-note">
                    Interactions counts every comment and DM Lead Porch has synced from your connected Facebook and Instagram accounts, combined — including anything sent while testing. It updates automatically as new activity comes in.
                  </p>

                  <div className="social-panel social-funnel-panel">
                    <h3>Social funnel</h3>
                    <p>
                      How a CTA keyword trigger turns into a conversation, a
                      lead, an application, a booked call, and an enrollment —
                      from real CRM and comment/DM activity.
                    </p>
                    <div className="social-funnel-bars">
                      {(() => {
                        const maxValue = Math.max(1, ...funnelData.map((row) => row.value));
                        return growth.socialFunnel.stages.map((stage, index) => (
                          <div className="social-funnel-bar-row" key={stage.key}>
                            <span className="social-funnel-bar-row__label">
                              {STAGE_LABELS[stage.key] || human(stage.key)}
                            </span>
                            <div className="social-funnel-bar-row__track">
                              <div
                                className="social-funnel-bar-row__fill"
                                style={{
                                  width: `${Math.max(stage.value ? (stage.value / maxValue) * 100 : 2, 2)}%`,
                                  background: FUNNEL_COLORS[index % FUNNEL_COLORS.length],
                                }}
                              />
                              <strong className="social-funnel-bar-row__value">{stage.value}</strong>
                            </div>
                            <span className="social-funnel-bar-row__rate">
                              {index > 0 ? `${growth.socialFunnel.conversions[index - 1].rate}% conv.` : ""}
                            </span>
                          </div>
                        ));
                      })()}
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
                      Real Meta engagement for the post itself (Likes,
                      Comments, Shares), alongside what it actually produced
                      in your CRM (Interactions, Leads, Sales).
                    </p>
                    {growth.socialFunnel.byPost?.length ? (
                      <div className="social-post-card-grid">
                        {growth.socialFunnel.byPost.map((post) => {
                          const meta = post.providers.reduce(
                            (sum, provider) => {
                              const row = postEngagement[`${post.contentBriefId}:${provider}`];
                              return {
                                likes: sum.likes + (row?.likes || 0),
                                comments: sum.comments + (row?.comments || 0),
                                shares: sum.shares + (row?.shares ?? 0),
                              };
                            },
                            { likes: 0, comments: 0, shares: 0 },
                          );
                          return (
                            <article className="social-post-card" key={post.contentBriefId}>
                              <header>
                                <span className="social-post-card__platforms">
                                  {post.providers.map((provider) => {
                                    const Icon = PLATFORM_ICONS[provider];
                                    return Icon ? <Icon key={provider} title={human(provider)} /> : null;
                                  })}
                                </span>
                                <strong title={post.title}>{post.title}</strong>
                              </header>
                              <div className="social-post-card__stats">
                                <div>
                                  <dt>Likes</dt>
                                  <dd>{meta.likes || 0}</dd>
                                </div>
                                <div>
                                  <dt>Comments</dt>
                                  <dd>{meta.comments || 0}</dd>
                                </div>
                                <div>
                                  <dt>Shares</dt>
                                  <dd>{meta.shares || 0}</dd>
                                </div>
                                <div>
                                  <dt>Interactions</dt>
                                  <dd>{post.interactions}</dd>
                                </div>
                                <div>
                                  <dt>Leads</dt>
                                  <dd>{post.leads}</dd>
                                </div>
                                <div>
                                  <dt>Sales</dt>
                                  <dd>{post.sales}</dd>
                                </div>
                              </div>
                              {post.revenue > 0 ? (
                                <span className="social-post-card__revenue">{currency(post.revenue)} revenue</span>
                              ) : null}
                            </article>
                          );
                        })}
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

          {(() => {
            const attributionTotal = (data.rows || []).reduce((sum, row) => sum + row.interactions, 0);
            const attributionPie = (data.rows || [])
              .filter((row) => row.interactions > 0)
              .map((row) => ({ name: human(row.provider), key: row.provider, value: row.interactions }));
            return (
              <div className="social-analytics-secondary">
                <div className="social-panel social-panel--secondary">
                  <h3>Known social attribution</h3>
                  <p>{data.attributionNote}</p>
                  {attributionTotal ? (
                    <div className="social-attribution-layout">
                      <div className="social-attribution-chart">
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <RechartsTooltip formatter={(value, _name, item) => [`${value} interactions`, item.payload.name]} />
                            <Pie
                              data={attributionPie}
                              dataKey="value"
                              nameKey="name"
                              innerRadius={48}
                              outerRadius={72}
                              paddingAngle={attributionPie.length > 1 ? 3 : 0}
                              isAnimationActive
                            >
                              {attributionPie.map((entry) => (
                                <Cell key={entry.key} fill={PROVIDER_COLORS[entry.key] || "#8e8e93"} />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="social-attribution-chart__center">
                          <strong>{attributionTotal}</strong>
                          <span>total</span>
                        </div>
                      </div>
                      <ul className="social-attribution-legend">
                        {data.rows.map((row) => (
                          <li key={row.provider}>
                            <span className="social-attribution-legend__dot" style={{ background: PROVIDER_COLORS[row.provider] || "#8e8e93" }} />
                            <span className="social-attribution-legend__name">{human(row.provider)}</span>
                            <strong>{row.interactions}</strong>
                            <small>
                              {row.identifiableContacts} contact{row.identifiableContacts === 1 ? "" : "s"} · {row.attributedApplications} application{row.attributedApplications === 1 ? "" : "s"}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p>No social interactions recorded yet.</p>
                  )}
                </div>
                <div className="social-panel social-panel--secondary">
                  <h3>Connected account insights</h3>
                  <p>{data.metricsNote}</p>
                  {data.providerInsights?.assets?.length ? (
                    <div className="social-account-insight-grid">
                      {data.providerInsights.assets.map((row) => {
                        const Icon = PLATFORM_ICONS[row.provider];
                        const statusMeta = STATUS_META[row.status] || STATUS_META.unavailable;
                        const StatusIcon = statusMeta.icon;
                        const stats = [
                          ["Followers", row.followers],
                          ["Reach", row.reach],
                          ["Engagements", row.engagements],
                          ["Profile views", row.profileViews],
                          ["Page views", row.pageViews],
                          ["Accounts engaged", row.accountsEngaged],
                          ["Total interactions", row.totalInteractions],
                          ["Likes", row.likes],
                          ["Comments", row.comments],
                          ["Shares", row.shares],
                          ["Saves", row.saves],
                          ["Website clicks", row.websiteClicks],
                        ].filter(([, value]) => value !== null && value !== undefined);
                        return (
                          <article key={`${row.provider}:${row.assetId}`} className={`social-account-insight-card social-account-insight-card--${row.provider}`}>
                            <header>
                              <span className="social-account-insight-card__icon">{Icon ? <Icon /> : null}</span>
                              <strong>{row.assetName || row.provider}</strong>
                              <span className={`social-status-pill social-status-pill--${statusMeta.tone}`}>
                                <StatusIcon aria-hidden="true" /> {statusMeta.label}
                              </span>
                            </header>
                            {stats.length ? (
                              <dl>
                                {stats.map(([label, value]) => (
                                  <div key={label}>
                                    <dt>{label}</dt>
                                    <dd>{value}</dd>
                                  </div>
                                ))}
                              </dl>
                            ) : (
                              <p>
                                {row.status === "permission_required"
                                  ? `Grant ${row.requiredPermission || "the required permission"} to see this account's metrics.`
                                  : row.error || "Meta did not return metrics for this account."}
                              </p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <p>
                      No selected Facebook or Instagram account insights are
                      available yet.
                    </p>
                  )}
                </div>
              </div>
            );
          })()}
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
                      : detail.thread.channel === "linkedin"
                        ? detail.thread.contactIds?.[0]?.linkedin || (identity?.username ? `https://www.linkedin.com/in/${identity.username}` : null)
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
                              View {detail.thread.channel === "linkedin" ? "LinkedIn" : "Instagram"} profile
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
