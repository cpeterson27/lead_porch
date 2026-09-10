import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  FiArrowUpRight,
  FiBriefcase,
  FiCheck,
  FiCopy,
  FiCpu,
  FiCreditCard,
  FiImage,
  FiLock,
  FiMail,
  FiShield,
  FiTrash2,
  FiUser,
  FiUsers,
} from "react-icons/fi";
import Button from "../components/Button.jsx";
import TeamAccess from "../components/TeamAccess.jsx";
import ApplicationNotificationSettings from "../components/ApplicationNotificationSettings.jsx";
import WebsiteBrandManager from "../components/WebsiteBrandManager.jsx";
import ApplicationRouting from "../components/ApplicationRouting.jsx";
import ApplicationImageSettings from "../components/ApplicationImageSettings.jsx";
import LaunchReadiness from "../components/LaunchReadiness.jsx";
import PrivacyRequests from "../components/PrivacyRequests.jsx";
import InvitationTemplates from "../components/InvitationTemplates.jsx";
import PaymentSettings from "../components/PaymentSettings.jsx";
import useAuth from "../context/useAuth.js";
import {
  changePassword,
  createMcpAccessToken,
  fetchCampaigns,
  fetchGmailConnection,
  fetchMcpAccessTokens,
  fetchOAuthConnections,
  fetchWorkspaceConfig,
  getGptActionsSchemaEndpoint,
  getMcpEndpoint,
  revokeMcpAccessToken,
  revokeOAuthConnection,
  updateWorkspaceConfig,
} from "../services/api.js";
import { hasPermission } from "../utils/roleAccess.js";
import {
  getWorkspaceSettings,
  saveWorkspaceSettings,
} from "../utils/workspaceSettings.js";
import "./Settings.css";

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useAuth();

  const [activeSection, setActiveSection] = useState(() =>
    location.pathname.endsWith("/payments")
      ? "payments"
      : location.pathname.includes("/communications/invitations")
        ? "invitations"
        : location.pathname.endsWith("/privacy")
          ? "privacy"
          : location.pathname.endsWith("/website")
            ? "public"
            : location.pathname.endsWith("/applications")
              ? "applications"
              : location.pathname.endsWith("/team")
                ? "team"
                : "profile",
  );

  const [workspaceName, setWorkspaceName] = useState(
    () => getWorkspaceSettings().workspaceName,
  );
  const [accountEmail, setAccountEmail] = useState("");
  const [legalBusinessName, setLegalBusinessName] = useState("");
  const [address, setAddress] = useState({
    line1: "",
    line2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "United States",
  });
  const [websiteUrl, setWebsiteUrl] = useState("");
  // No UI edits this directly anymore (logos live only under Website &
  // Brand) — kept only so saving the Organization profile form doesn't
  // wipe out a value set before that consolidation.
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState("");
  const [invitationIdentity, setInvitationIdentity] = useState({
    senderName: "",
    senderEmail: "",
    replyToEmail: "",
  });
  const [campaigns, setCampaigns] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [mcpTokens, setMcpTokens] = useState([]);

  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const [newMcpToken, setNewMcpToken] = useState(null);
  const [mcpName, setMcpName] = useState("Lead Porch");
  const [oauthConnections, setOauthConnections] = useState([]);
  const [copiedValue, setCopiedValue] = useState("");

  const mcpEndpoint = getMcpEndpoint();
  const codexCommand = `codex mcp add growth-operator --url "${mcpEndpoint}"`;
  const codexLoginCommand = "codex mcp login growth-operator";
  const codexSetupCommands = `${codexCommand}\n${codexLoginCommand}`;

  const copyValue = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(label);
      window.setTimeout(
        () => setCopiedValue((current) => (current === label ? "" : current)),
        1800,
      );
    } catch {
      setError(
        "Copying was blocked by the browser. Select the value and copy it manually.",
      );
    }
  };

  useEffect(() => {
    fetchWorkspaceConfig()
      .then((config) => {
        setWorkspaceName(config.workspaceName);
        setLegalBusinessName(config.legalBusinessName || "");
        setAddress({
          line1:
            config.addressLine1 ||
            (!config.addressCity ? config.postalAddress || "" : ""),
          line2: config.addressLine2 || "",
          city: config.addressCity || "",
          region: config.addressRegion || "",
          postalCode: config.addressPostalCode || "",
          country: config.addressCountry || "United States",
        });
        setWebsiteUrl(config.websiteUrl || "");
        setOrganizationLogoUrl(config.organizationLogoUrl || "");
        setInvitationIdentity({
          senderName: config.invitationIdentity?.senderName || "",
          senderEmail: config.invitationIdentity?.senderEmail || "",
          replyToEmail: config.invitationIdentity?.replyToEmail || "",
        });
      })
      .catch(() => {});
    fetchGmailConnection()
      .then((connection) => setAccountEmail(connection.email || ""))
      .catch(() => {});
    fetchCampaigns()
      .then((items) => setCampaigns(items || []))
      .catch(() => {});
    fetchMcpAccessTokens()
      .then((data) => setMcpTokens(data.data || []))
      .catch(() => {});
    fetchOAuthConnections()
      .then((data) => setOauthConnections(data.connections || []))
      .catch(() => {});
  }, []);

  const connectAi = async () => {
    try {
      setSaving(true);
      const response = await createMcpAccessToken(mcpName);
      setNewMcpToken(response.data);
      setMcpTokens((items) => [response.data, ...items]);
      setError("");
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to create the AI connection.",
      );
    } finally {
      setSaving(false);
    }
  };

  const revokeAi = async (id) => {
    try {
      await revokeMcpAccessToken(id);
      setMcpTokens((items) =>
        items.filter((item) => (item._id || item.id) !== id),
      );
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to revoke the AI connection.",
      );
    }
  };

  const disconnectAiApp = async (clientId) => {
    try {
      await revokeOAuthConnection(clientId);
      setOauthConnections((items) =>
        items.filter((item) => item.clientId !== clientId),
      );
    } catch (err) {
      setError(err.response?.data?.error || "Unable to disconnect the AI app.");
    }
  };

  const savePassword = async () => {
    try {
      setSaving(true);
      await changePassword(passwords);
      setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setSaved(true);
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to change password.");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      const cityLine = [address.city, address.region].filter(Boolean).join(", ");
      const postalAddress = [
        address.line1,
        address.line2,
        [cityLine, address.postalCode].filter(Boolean).join(" "),
        address.country,
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(", ");
      const config = await updateWorkspaceConfig({
        workspaceName,
        legalBusinessName,
        postalAddress,
        addressLine1: address.line1,
        addressLine2: address.line2,
        addressCity: address.city,
        addressRegion: address.region,
        addressPostalCode: address.postalCode,
        addressCountry: address.country,
        websiteUrl,
        organizationLogoUrl,
        invitationIdentity,
      });
      const local = { ...getWorkspaceSettings(), workspaceName: config.workspaceName };
      saveWorkspaceSettings(local);
      setWorkspaceName(config.workspaceName);
      window.dispatchEvent(
        new CustomEvent("workspace-organization-updated", {
          detail: {
            workspaceName: config.workspaceName,
            organizationLogoUrl: config.organizationLogoUrl || "",
          },
        }),
      );
      setSaved(true);
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the workspace name.");
    } finally {
      setSaving(false);
    }
  };


  /* ─── Nav helper ─────────────────────────────────────────────────────── */
  const navBtn = (id, label, Icon, path) => (
    <button
      key={id}
      className={`settings-nav-btn${activeSection === id ? " is-active" : ""}`}
      onClick={() => {
        setActiveSection(id);
        if (path) navigate(path);
      }}
    >
      <Icon aria-hidden="true" />
      {label}
    </button>
  );

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <div className="settings-page page-dashboard">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Workspace</p>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Manage your account, organization, and workspace configuration.
          </p>
        </div>
      </div>

      {error ? <p className="settings-error">{error}</p> : null}

      <div className="settings-shell">
        {/* ── Sidebar nav ──────────────────────────────────────────────── */}
        <nav className="settings-sidebar" aria-label="Settings sections">
          {/* Account group */}
          <div className="settings-nav-group">
            <p className="settings-nav-group__label">Account</p>
            {navBtn("profile", "Organization profile", FiUser)}
            {navBtn("login", "Login & password", FiLock)}
            {navBtn("security", "Security", FiShield)}
            {navBtn("ai", "AI connections", FiCpu)}
          </div>

          {/* Workspace group */}
          <div className="settings-nav-group">
            <p className="settings-nav-group__label">Workspace</p>
            {navBtn("team", "Team & Access", FiUsers, "/settings/team")}
            {hasPermission(session, "payments.view") ||
            hasPermission(session, "payments.manage")
              ? navBtn("payments", "Payments", FiCreditCard, "/settings/payments")
              : null}
            {hasPermission(session, "team.manage")
              ? navBtn(
                  "invitations",
                  "Invitation templates",
                  FiMail,
                  "/settings/communications/invitations",
                )
              : null}
          </div>

          {/* Publishing group */}
          {hasPermission(session, "workspace.manage") ? (
            <div className="settings-nav-group">
              <p className="settings-nav-group__label">Publishing</p>
              {navBtn("public", "Website & Brand", FiImage, "/settings/website")}
              {navBtn(
                "applications",
                "Student Application",
                FiBriefcase,
                "/settings/applications",
              )}
              {navBtn("readiness", "Launch readiness", FiCheck)}
              {navBtn("privacy", "Privacy requests", FiShield, "/settings/privacy")}
            </div>
          ) : null}
        </nav>

        {/* ── Content panel ────────────────────────────────────────────── */}

        {/* Organization profile */}
        {activeSection === "profile" ? (
          <div className="settings-panel">
            <header className="settings-panel__header">
              <p className="page-eyebrow">Organization profile</p>
              <h2>Identity &amp; email brand</h2>
              <p>
                Set the client-level identity once. Individual events and
                programs can use their own logo and campaign branding.
              </p>
            </header>

            {/* Business details */}
            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiBriefcase /></div>
                <div className="settings-section__head-text">
                  <h3>Business details</h3>
                  <p>
                    Used in navigation and the compliance footer on campaign
                    email. Your logo lives in one place —{" "}
                    <button
                      type="button"
                      className="settings-inline-link"
                      onClick={() => setActiveSection("public")}
                    >
                      Website &amp; Brand
                    </button>
                    .
                  </p>
                </div>
              </div>
              <div className="settings-form">
                <label className="form-field">
                  <span>Business / display name</span>
                  <input
                    value={workspaceName}
                    onChange={(e) => { setWorkspaceName(e.target.value); setSaved(false); }}
                  />
                  <small>Used in Lead Porch and as [Business name] in invitations.</small>
                </label>
                <label className="form-field">
                  <span>Legal business name</span>
                  <input
                    value={legalBusinessName}
                    onChange={(e) => { setLegalBusinessName(e.target.value); setSaved(false); }}
                  />
                </label>
                <label className="form-field">
                  <span>Default invitation sender name</span>
                  <input
                    value={invitationIdentity.senderName}
                    onChange={(e) => {
                      setInvitationIdentity({ ...invitationIdentity, senderName: e.target.value });
                      setSaved(false);
                    }}
                    placeholder={session?.user?.name || "Authenticated inviter"}
                  />
                  <small>Optional. If blank, [Invited by] uses the person who sent the invitation.</small>
                </label>
                <label className="form-field">
                  <span>Invitation sender email</span>
                  <input
                    type="email"
                    value={invitationIdentity.senderEmail}
                    onChange={(e) => {
                      setInvitationIdentity({ ...invitationIdentity, senderEmail: e.target.value });
                      setSaved(false);
                    }}
                    placeholder="team@yourdomain.com"
                  />
                  <small>Required before sending. Use an address on a verified sending domain.</small>
                </label>
                <label className="form-field">
                  <span>Invitation reply-to email</span>
                  <input
                    type="email"
                    value={invitationIdentity.replyToEmail}
                    onChange={(e) => {
                      setInvitationIdentity({ ...invitationIdentity, replyToEmail: e.target.value });
                      setSaved(false);
                    }}
                    placeholder={session?.user?.email || "name@example.com"}
                  />
                  <small>Optional. Replies to invitation emails are directed here.</small>
                </label>
                <label className="form-field">
                  <span>Business website</span>
                  <input
                    type="url"
                    value={websiteUrl}
                    onChange={(e) => { setWebsiteUrl(e.target.value); setSaved(false); }}
                    placeholder="https://elliescoaching.com"
                  />
                </label>

                <fieldset className="settings-address">
                  <legend>Business mailing address</legend>
                  <p>Saved in the compliance footer of campaign emails.</p>
                  <label className="form-field settings-address__wide">
                    <span>Street address</span>
                    <input
                      value={address.line1}
                      onChange={(e) => { setAddress({ ...address, line1: e.target.value }); setSaved(false); }}
                      placeholder="123 Main Street"
                    />
                  </label>
                  <label className="form-field settings-address__wide">
                    <span>Unit, suite, or mailbox</span>
                    <input
                      value={address.line2}
                      onChange={(e) => { setAddress({ ...address, line2: e.target.value }); setSaved(false); }}
                      placeholder="Suite 200 (optional)"
                    />
                  </label>
                  <label className="form-field">
                    <span>City</span>
                    <input
                      value={address.city}
                      onChange={(e) => { setAddress({ ...address, city: e.target.value }); setSaved(false); }}
                    />
                  </label>
                  <label className="form-field">
                    <span>State / region</span>
                    <input
                      value={address.region}
                      onChange={(e) => { setAddress({ ...address, region: e.target.value }); setSaved(false); }}
                    />
                  </label>
                  <label className="form-field">
                    <span>Postal code</span>
                    <input
                      value={address.postalCode}
                      onChange={(e) => { setAddress({ ...address, postalCode: e.target.value }); setSaved(false); }}
                    />
                  </label>
                  <label className="form-field">
                    <span>Country</span>
                    <input
                      value={address.country}
                      onChange={(e) => { setAddress({ ...address, country: e.target.value }); setSaved(false); }}
                    />
                  </label>
                </fieldset>
              </div>
            </section>

            {/* Email connection */}
            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiMail /></div>
                <div className="settings-section__head-text">
                  <h3>Email connection</h3>
                  <p>Mailbox access is managed from Integrations.</p>
                </div>
              </div>
              <div className="settings-email-row">
                <span>{accountEmail || "No Gmail account connected"}</span>
                <Button variant="outline" size="sm" onClick={() => navigate("/integrations/gmail")}>
                  Manage connection
                </Button>
              </div>
            </section>

            {/* Campaign brands */}
            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiImage /></div>
                <div className="settings-section__head-text">
                  <h3>Campaign brands</h3>
                  <p>Give each event or program its own logo, website, and email color.</p>
                </div>
              </div>
              <div className="settings-brand-list">
                {campaigns.length ? (
                  campaigns.map((campaign) => (
                    <button
                      key={campaign._id}
                      className="settings-brand-item"
                      onClick={() => navigate(`/campaigns/${campaign._id}`)}
                    >
                      <div className="settings-brand-item__left">
                        <div className="settings-brand-item__logo">
                          {campaign.brand?.logoUrl ? (
                            <img src={campaign.brand.logoUrl} alt="" />
                          ) : (
                            <FiImage />
                          )}
                        </div>
                        <div className="settings-brand-item__label">
                          <span className="settings-brand-item__kind">
                            {campaign.campaignKind === "program" ? "Program" : "Event"}
                          </span>
                          <span className="settings-brand-item__name">
                            {campaign.programName || campaign.name}
                          </span>
                        </div>
                      </div>
                      <span className="settings-brand-item__action">
                        Manage brand <FiArrowUpRight />
                      </span>
                    </button>
                  ))
                ) : (
                  <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", margin: 0 }}>
                    No campaigns yet. Create an event or program campaign first.
                  </p>
                )}
              </div>
            </section>

            <footer className="settings-panel__footer">
              <Button
                loading={saving}
                disabled={workspaceName.trim().length < 2}
                onClick={save}
              >
                Save organization profile
              </Button>
              {saved ? (
                <span className="settings-save-ok" role="status">
                  <FiCheck /> Saved successfully
                </span>
              ) : null}
            </footer>
          </div>

        ) : activeSection === "login" ? (
          /* ── Login & password ──────────────────────────────────────────── */
          <form
            className="settings-panel"
            onSubmit={(e) => { e.preventDefault(); savePassword(); }}
          >
            <header className="settings-panel__header">
              <p className="page-eyebrow">Login &amp; password</p>
              <h2>Sign-in details</h2>
              <p>
                Change the password for {session?.user?.email}. Your other
                signed-in devices will be logged out.
              </p>
            </header>

            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiLock /></div>
                <div className="settings-section__head-text">
                  <h3>Change password</h3>
                  <p>Use at least 12 characters and a password unique to Lead Porch.</p>
                </div>
              </div>
              <div className="settings-form">
                <label className="form-field">
                  <span>Current password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={passwords.currentPassword}
                    onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
                  />
                </label>
                <span />
                <label className="form-field">
                  <span>New password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={passwords.newPassword}
                    onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
                  />
                </label>
                <label className="form-field">
                  <span>Confirm new password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={passwords.confirmPassword}
                    onChange={(e) => setPasswords({ ...passwords, confirmPassword: e.target.value })}
                  />
                </label>
              </div>
            </section>

            <footer className="settings-panel__footer">
              <Button
                type="submit"
                loading={saving}
                disabled={
                  !passwords.currentPassword ||
                  passwords.newPassword.length < 12 ||
                  passwords.newPassword !== passwords.confirmPassword
                }
              >
                Update password
              </Button>
              {saved ? (
                <span className="settings-save-ok" role="status">
                  <FiCheck /> Password updated
                </span>
              ) : null}
            </footer>
          </form>

        ) : activeSection === "security" ? (
          /* ── Security ──────────────────────────────────────────────────── */
          <div className="settings-panel">
            <header className="settings-panel__header">
              <p className="page-eyebrow">Security</p>
              <h2>Account protection</h2>
              <p>Review the security controls protecting this workspace.</p>
            </header>

            <section className="settings-section">
              <div className="settings-security-list">
                <div className="settings-security-item">
                  <div className="settings-security-item__icon"><FiShield /></div>
                  <div className="settings-security-item__text">
                    <strong>Secure server-side sessions</strong>
                    <small>Sessions expire automatically after 14 days.</small>
                  </div>
                  <span className="settings-security-badge">Active</span>
                </div>
                <div className="settings-security-item">
                  <div className="settings-security-item__icon"><FiLock /></div>
                  <div className="settings-security-item__text">
                    <strong>Protected account changes</strong>
                    <small>Passwords are hashed and current-password verification is required.</small>
                  </div>
                  <span className="settings-security-badge">Active</span>
                </div>
                <div className="settings-security-item">
                  <div className="settings-security-item__icon"><FiUsers /></div>
                  <div className="settings-security-item__text">
                    <strong>Capability-based workspace access</strong>
                    <small>
                      Your roles are{" "}
                      {(session?.roles || [session?.role || "member"]).join(", ")}.
                    </small>
                  </div>
                  <span className="settings-security-badge">Active</span>
                </div>
              </div>
            </section>
          </div>

        ) : activeSection === "ai" ? (
          /* ── AI connections ────────────────────────────────────────────── */
          <div className="settings-panel">
            <header className="settings-panel__header">
              <p className="page-eyebrow">Lead Porch connections</p>
              <h2>Connect to ChatGPT, Claude, Codex, or an MCP client</h2>
              <p>
                Give AI tools controlled access to Lead Porch research and ranked
                lead lists. Email sending is not available through this connection.
              </p>
            </header>

            {/* Codex OAuth */}
            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiCpu /></div>
                <div className="settings-section__head-text">
                  <h3>Connect Codex</h3>
                  <p>
                    Sign in once. Codex stores and refreshes its own
                    authorization — no secret token to copy or remember.
                  </p>
                </div>
              </div>
              <div style={{ display: "grid", gap: "14px" }}>
                <div className="settings-copy-block">
                  <span className="settings-copy-block__label">MCP server URL</span>
                  <div className="settings-copy-row">
                    <code>{mcpEndpoint}</code>
                    <button
                      type="button"
                      className="settings-copy-btn"
                      onClick={() => copyValue("endpoint", mcpEndpoint)}
                    >
                      {copiedValue === "endpoint" ? <FiCheck /> : <FiCopy />}
                      {copiedValue === "endpoint" ? "Copied" : "Copy URL"}
                    </button>
                  </div>
                </div>
                <div className="settings-copy-block">
                  <span className="settings-copy-block__label">Codex setup commands</span>
                  <div className="settings-copy-row">
                    <code style={{ lineHeight: 1.8 }}>
                      {codexCommand}
                      <br />
                      {codexLoginCommand}
                    </code>
                    <button
                      type="button"
                      className="settings-copy-btn"
                      onClick={() => copyValue("codex", codexSetupCommands)}
                    >
                      {copiedValue === "codex" ? <FiCheck /> : <FiCopy />}
                      {copiedValue === "codex" ? "Copied" : "Copy commands"}
                    </button>
                  </div>
                </div>
                <ol className="settings-steps">
                  <li>Run both commands in Terminal.</li>
                  <li>Your browser opens Lead Porch. Sign in and approve the requested access.</li>
                  <li>Restart Codex once. Lead Porch will then be available whenever you need it.</li>
                </ol>
                <div className="settings-oauth-note">
                  <FiShield />
                  <span>
                    <strong>Professional OAuth connection</strong>
                    <small>
                      Short-lived access, automatic refresh, workspace-scoped
                      permissions, and one-click revocation from this page.
                    </small>
                  </span>
                </div>
              </div>
            </section>

            {/* Manual token */}
            <section className="settings-section settings-section--muted">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiLock /></div>
                <div className="settings-section__head-text">
                  <h3>Manual token for Custom GPTs</h3>
                  <p>
                    Use this only when a client cannot sign in with OAuth.
                    Tokens expire after 90 days and are shown once.
                  </p>
                </div>
              </div>
              <div className="settings-ai-create">
                <input
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder="Connection name"
                />
                <Button
                  loading={saving}
                  disabled={mcpName.trim().length < 2}
                  onClick={connectAi}
                >
                  Create manual token
                </Button>
              </div>
              {newMcpToken ? (
                <div className="settings-token-reveal">
                  <strong>Copy this token now — it will not be shown again.</strong>
                  <div className="settings-copy-row">
                    <code>{newMcpToken.token}</code>
                    <button
                      type="button"
                      className="settings-copy-btn"
                      onClick={() => copyValue("token", newMcpToken.token)}
                    >
                      {copiedValue === "token" ? <FiCheck /> : <FiCopy />}
                      {copiedValue === "token" ? "Copied" : "Copy token"}
                    </button>
                  </div>
                  <small>ChatGPT Actions schema: {getGptActionsSchemaEndpoint()}</small>
                  <small>
                    Keep this connection private. Anyone with its token can use your Lead Porch permissions.
                  </small>
                </div>
              ) : null}
              {mcpTokens.length && !newMcpToken ? (
                <div className="settings-token-warning">
                  <strong>Lost an existing manual token?</strong> For security, it
                  cannot be recovered. Revoke it below and create a replacement.
                </div>
              ) : null}
            </section>

            {/* Active connections */}
            <section className="settings-section">
              <div className="settings-section__head">
                <div className="settings-section__icon"><FiShield /></div>
                <div className="settings-section__head-text">
                  <h3>Active connections</h3>
                  <p>Every tool call is workspace-scoped and recorded in the audit log.</p>
                </div>
              </div>
              <div className="settings-connections-list">
                {oauthConnections.map((connection) => (
                  <div key={connection.id} className="settings-connection-item">
                    <div className="settings-connection-item__info">
                      <strong>{connection.name}</strong>
                      <small>OAuth · {connection.scopes.join(" · ")}</small>
                    </div>
                    <button
                      className="settings-revoke"
                      onClick={() => disconnectAiApp(connection.clientId)}
                      aria-label={`Disconnect ${connection.name}`}
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                ))}
                {mcpTokens.map((token) => (
                  <div key={token._id || token.id} className="settings-connection-item">
                    <div className="settings-connection-item__info">
                      <strong>{token.name}</strong>
                      <small>
                        {token.prefix}… · expires{" "}
                        {new Date(token.expiresAt).toLocaleDateString()} · secret hidden after creation
                      </small>
                    </div>
                    <button
                      className="settings-revoke"
                      onClick={() => revokeAi(token._id || token.id)}
                      aria-label={`Revoke ${token.name}`}
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                ))}
                {!oauthConnections.length && !mcpTokens.length ? (
                  <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", margin: 0 }}>
                    No AI assistants connected yet.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

        ) : activeSection === "payments" ? (
          <PaymentSettings />

        ) : activeSection === "public" ? (
          <WebsiteBrandManager websiteUrl={websiteUrl} />

        ) : activeSection === "applications" ? (
          <div className="settings-applications-stack">
            <ApplicationRouting />
            <ApplicationImageSettings />
            <ApplicationNotificationSettings />
          </div>

        ) : activeSection === "readiness" ? (
          <LaunchReadiness />

        ) : activeSection === "privacy" ? (
          <PrivacyRequests />

        ) : activeSection === "invitations" ? (
          <InvitationTemplates />

        ) : (
          <TeamAccess
            canManage={hasPermission(session, "team.manage")}
            actorRoles={session?.roles || [session?.role].filter(Boolean)}
          />
        )}
      </div>
    </div>
  );
}
