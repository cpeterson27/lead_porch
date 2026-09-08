import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import Button from "../components/Button.jsx";
import {
  fetchEventbriteConnection,
  fetchEventbriteWebhookStatus,
  fetchEvents,
  fetchIntegrationHub,
  fetchGmailConnection,
  beginGmailConnection,
  disconnectGmail,
  fetchSocialConnection,
  beginSocialConnection,
  disconnectSocialConnection,
  selectSocialAssets,
  fetchSkoolStatus,
  configureSkool,
  fetchMeetupStatus,
  beginMeetupConnection,
  disconnectMeetup,
  fetchMeetupAssets,
  selectMeetupGroups,
} from "../services/api.js";
import "./Integrations.css";

const statusLabels = {
  ready: "Ready to use",
  connected: "Connected",
  disconnected: "Disconnected",
  configuration_required: "Setup required",
  planned: "OAuth planned",
  public_only: "Public access only",
};

const externalCrms = [
  { name: "HubSpot", detail: "Contact, company, and deal synchronization for teams already using HubSpot." },
  { name: "Salesforce", detail: "Lead, contact, account, and opportunity synchronization for enterprise sales teams." },
  { name: "monday CRM", detail: "Board and contact synchronization for teams managing pipelines in monday." },
];

function providerSummary(provider, eventbriteReady) {
  if (provider.id === "eventbrite") {
    return eventbriteReady
      ? "Connected for event publishing, registrations, check-ins, and reporting."
      : "Connect Eventbrite and verify automatic event updates.";
  }
  if (provider.id === "csv") {
    return "Import contact spreadsheets from Contacts → Import.";
  }
  if (provider.id === "linkedin" || provider.id === "facebook") {
    return `${provider.description}. This is for each customer’s own authorized business assets—not for searching private people or exporting group members.`;
  }
  if (provider.id === "meetup") {
    return "Public Meetup discovery and an authorized Meetup Pro connection are separate. Discovery never implies Lead Porch can message a community.";
  }
  return provider.description;
}

export default function Integrations() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState([]);
  const [eventbriteConnection, setEventbriteConnection] = useState(null);
  const [eventbriteWebhook, setEventbriteWebhook] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("meetup") === "error") return "Meetup authorization did not complete.";
    const provider = params.get("social");
    const status = params.get("status");
    return provider && status && status !== "connected" ? params.get("message") || `${provider} connection did not complete.` : "";
  });
  const [gmail, setGmail] = useState(null);
  const [socialConnections, setSocialConnections] = useState({ linkedin: null, meta: null, instagram: null });
  const [socialBusy, setSocialBusy] = useState("");
  const [skool, setSkool] = useState(null);
  const [meetup, setMeetup] = useState(null);
  const [meetupAssets, setMeetupAssets] = useState({ network: null, groups: [], events: [] });
  const [meetupNetwork, setMeetupNetwork] = useState("");
  const [meetupBusy, setMeetupBusy] = useState(false);
  const [skoolForm, setSkoolForm] = useState({ mode: "manual", groupId: "", groupSlug: "", groupName: "", groupUrl: "", zapierHookUrl: "", adapterSecret: "" });

  const loadProviders = async () => {
    try {
      setLoading(true);
      const [response, connection, webhook, eventData, gmailConnection, linkedin, meta, skoolStatus, meetupStatus, instagram] = await Promise.all([
        fetchIntegrationHub(),
        fetchEventbriteConnection().catch(() => null),
        fetchEventbriteWebhookStatus().catch(() => null),
        fetchEvents().catch(() => []),
        fetchGmailConnection().catch(() => null),
        fetchSocialConnection("linkedin").catch(() => null),
        fetchSocialConnection("meta").catch(() => null),
        fetchSkoolStatus().catch(() => null),
        fetchMeetupStatus().catch(() => null),
        fetchSocialConnection("instagram").catch(() => null),
      ]);
      setProviders(response.data?.providers || []);
      setEventbriteConnection(connection);
      setEventbriteWebhook(webhook);
      setEvents(Array.isArray(eventData) ? eventData : []);
      setGmail(gmailConnection);
      setSocialConnections({ linkedin, meta, instagram });
      setSkool(skoolStatus);
      setMeetup(meetupStatus);
      setMeetupNetwork(meetupStatus?.proNetworkUrlname || "");
      if (skoolStatus) setSkoolForm((current) => ({ ...current, mode: skoolStatus.mode || "manual", groupId: skoolStatus.groupId || "", groupSlug: skoolStatus.groupSlug || "", groupName: skoolStatus.groupName || "", groupUrl: skoolStatus.groupUrl || "" }));
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to load integrations");
    } finally {
      setLoading(false);
    }
  };

  const connectGmail = async () => {
    try {
      const response = await beginGmailConnection();
      window.location.assign(response.authorizationUrl);
    } catch (err) {
      setError(err.response?.data?.error || "Google app credentials must be configured before Gmail can connect.");
    }
  };

  const removeGmail = async () => {
    await disconnectGmail();
    await loadProviders();
  };

  useEffect(() => {
    const initialLoad = window.setTimeout(loadProviders, 0);
    return () => window.clearTimeout(initialLoad);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("meetup")) window.history.replaceState({}, "", window.location.pathname);
    const provider = params.get("social");
    const status = params.get("status");
    if (!provider || !status) return;
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const connectSocial = async (provider) => {
    try {
      setSocialBusy(provider);
      const response = await beginSocialConnection(provider);
      window.location.assign(response.authorizationUrl);
    } catch (err) {
      setError(err.response?.data?.error || `${provider} developer application setup is incomplete.`);
      setSocialBusy("");
    }
  };

  const disconnectSocial = async (provider) => {
    try {
      setSocialBusy(provider);
      await disconnectSocialConnection(provider);
      await loadProviders();
    } finally { setSocialBusy(""); }
  };

  const toggleSocialAsset = async (provider, assetId) => {
    const connection = socialConnections[provider];
    const selected = new Set(connection?.selectedAssetIds || []);
    if (selected.has(assetId)) selected.delete(assetId); else selected.add(assetId);
    try {
      setSocialBusy(`${provider}:${assetId}`);
      const response = await selectSocialAssets(provider, [...selected]);
      setSocialConnections((current) => ({ ...current, [provider]: response.connection }));
    } finally { setSocialBusy(""); }
  };

  const latestEventbriteSync = events
    .map((event) => event.eventbriteLogistics?.lastSyncedAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];
  const eventbriteReady = Boolean(
    eventbriteConnection?.connected &&
      eventbriteWebhook?.configured &&
      eventbriteWebhook?.lastReceivedAt &&
      latestEventbriteSync,
  );

  const saveSkool = async (event) => {
    event.preventDefault();
    try { const value = await configureSkool(skoolForm); setSkool(value); setSkoolForm((current) => ({ ...current, zapierHookUrl: "", adapterSecret: "" })); setError(""); }
    catch (err) { setError(err.response?.data?.error || "Unable to save Skool setup."); }
  };

  const connectMeetup = async () => { try { setMeetupBusy(true); const response = await beginMeetupConnection(); window.location.assign(response.authorizationUrl); } catch (err) { setError(err.response?.data?.error || "Meetup OAuth app setup is incomplete."); setMeetupBusy(false); } };
  const loadMeetupAssets = async () => { try { setMeetupBusy(true); const value = await fetchMeetupAssets(meetupNetwork); setMeetupAssets(value); setMeetup(await fetchMeetupStatus()); setError(""); } catch (err) { setError(err.response?.data?.error || "Unable to read that authorized Meetup Pro network."); } finally { setMeetupBusy(false); } };
  const toggleMeetupGroup = async (urlname) => { const selected = new Set(meetup?.selectedGroupUrlnames || []); if (selected.has(urlname)) selected.delete(urlname); else selected.add(urlname); try { setMeetupBusy(true); setMeetup(await selectMeetupGroups([...selected])); } finally { setMeetupBusy(false); } };
  const removeMeetup = async () => { try { setMeetupBusy(true); setMeetup(await disconnectMeetup()); setMeetupAssets({ network: null, groups: [], events: [] }); } finally { setMeetupBusy(false); } };

  return (
    <div className="page-dashboard integrations-page">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Data & connections</p>
          <h1 className="page-title">Integrations</h1>
          <p className="page-subtitle">Set up the accounts Lead Porch uses for events, contacts, discovery, marketing, and outreach.</p>
        </div>
        <Button variant="outline" onClick={loadProviders}>Refresh status</Button>
      </div>

      <h2 className="integration-section-title">CRM and contact sources</h2>
      <section className="crm-connection-grid">
        <article className="crm-connection-card">
          <div><span className="integration-status integration-status--connected">Active</span><h2>Lead Porch CRM</h2></div>
          <p>Your built-in CRM for contacts, audience profiles, campaign assignments, outreach history, and CSV imports. No external CRM account is required.</p>
          <div className="crm-connection-actions">
            <Button onClick={() => navigate("/contacts")}>Open CRM</Button>
          </div>
        </article>
        {externalCrms.map((crm) => (
          <article className="crm-connection-card" key={crm.name}>
            <div><span className="integration-status">Planned</span><h2>{crm.name}</h2></div>
            <p>{crm.detail}</p>
            <button className="integration-disabled-action" disabled>Coming soon</button>
          </article>
        ))}
      </section>

      <h2 className="integration-section-title">Email and inbox</h2>
      <section className="crm-connection-grid">
        <article className="crm-connection-card">
          <div><span className={`integration-status integration-status--${gmail?.connected ? "connected" : "configuration_required"}`}>{gmail?.connected ? "Connected" : gmail?.configured ? "Ready to connect" : "App setup required"}</span><h2>Gmail</h2></div>
          <p>{gmail?.connected ? `${gmail.email} is authorized for inbox visibility and approved sending.` : "Connect a client’s Google account so Lead Porch can read relevant threads, prepare replies, and send only after user approval."}</p>
          <div className="crm-connection-actions">
            {gmail?.connected ? <><Button onClick={() => navigate("/inbox")}>Open inbox</Button><Button variant="outline" onClick={removeGmail}>Disconnect Gmail</Button></> : <><Button onClick={connectGmail} disabled={!gmail?.configured}>Connect Gmail</Button><Button variant="outline" onClick={() => navigate("/integrations/gmail")}>Setup details</Button></>}
          </div>
          {!gmail?.configured ? <small>Add the Google OAuth client ID, secret, redirect URI, and credential encryption key to the backend environment first.</small> : null}
        </article>
        <article className="crm-connection-card">
          <div><span className="integration-status integration-status--connected">Connected</span><h2>Resend</h2></div>
          <p>Resend remains the campaign delivery provider. Gmail is for the connected inbox and personal replies; the two integrations have separate jobs.</p>
        </article>
      </section>

      <h2 className="integration-section-title">Connected apps</h2>
      {error ? <p className="form-error">{error}</p> : null}
      <section className="crm-connection-grid">
        <article className="crm-connection-card meetup-connection-card">
          <div><span className="integration-status integration-status--ready">Public discovery</span><h2>Public Meetup Discovery</h2></div>
          <p>Find public communities and organizers for research. These results are public evidence only; Lead Porch cannot message or manage them.</p>
          <Button variant="outline" onClick={() => navigate("/discovery?tab=monitoring")}>Open public discovery</Button>
        </article>
        <article className="crm-connection-card meetup-connection-card">
          <div><span className={`integration-status integration-status--${meetup?.connected ? "connected" : "configuration_required"}`}>{meetup?.connected ? "Connected" : meetup?.configured ? "Ready to connect" : "App setup required"}</span><h2>Connected Meetup Pro</h2></div>
          <p>{meetup?.connected ? `${meetup.accountName} is authorized. Only owned/managed network assets are available.` : "Connect through official Meetup OAuth. Lead Porch never receives or stores the Meetup password."}</p>
          {meetup?.connected ? <>
            <label>Pro network URL name<input value={meetupNetwork} onChange={(event) => setMeetupNetwork(event.target.value)} placeholder="network-urlname" /></label>
            <div className="crm-connection-actions"><Button onClick={loadMeetupAssets} loading={meetupBusy}>Load authorized assets</Button><Button variant="outline" onClick={removeMeetup} disabled={meetupBusy}>Disconnect</Button></div>
            {meetupAssets.groups.length ? <div className="social-asset-picker"><strong>Authorized groups</strong>{meetupAssets.groups.map((group) => <label key={group.id}><input type="checkbox" checked={(meetup?.selectedGroupUrlnames || []).includes(group.urlname)} disabled={meetupBusy} onChange={() => toggleMeetupGroup(group.urlname)} /><span>{group.name}<small>{group.memberships?.totalCount || 0} members · {group.urlname}</small></span></label>)}</div> : null}
            <small>{meetupAssets.events.length ? `${meetupAssets.events.length} upcoming network event(s) visible.` : "Load a Pro network to verify groups and upcoming events."} {meetup.lastVerifiedAt ? `Authorization last verified ${new Date(meetup.lastVerifiedAt).toLocaleString()}. ` : ""}Outbound event changes always enter human approval; provider execution is disabled initially.</small>
          </> : <div className="crm-connection-actions"><Button onClick={connectMeetup} loading={meetupBusy} disabled={!meetup?.configured}>Connect Meetup</Button></div>}
        </article>
        <article className="crm-connection-card">
          <div><span className={`integration-status integration-status--${skool?.configured ? "connected" : "configuration_required"}`}>{skool?.configured ? "Configured (not live-tested)" : "Setup required"}</span><h2>Skool</h2></div>
          <p>Map Coaching Programs to your Skool group and courses. Lead Porch uses canonical Contacts and Enrollments; it does not create a second student record.</p>
          <form className="coaching-form" onSubmit={saveSkool}>
            <label>Workflow mode<select value={skoolForm.mode} onChange={(event) => setSkoolForm({ ...skoolForm, mode: event.target.value })}><option value="manual">Manual</option><option value="zapier">Zapier adapter</option></select></label>
            <label>Group name<input value={skoolForm.groupName} onChange={(event) => setSkoolForm({ ...skoolForm, groupName: event.target.value })} /></label>
            <label>Group ID or slug<input required value={skoolForm.groupId || skoolForm.groupSlug} onChange={(event) => setSkoolForm({ ...skoolForm, groupId: event.target.value, groupSlug: "" })} /></label>
            <label>Group URL<input type="url" value={skoolForm.groupUrl} onChange={(event) => setSkoolForm({ ...skoolForm, groupUrl: event.target.value })} /></label>
            {skoolForm.mode === "zapier" ? <><label>Zapier catch-hook URL<input type="url" required={!skool?.configured} value={skoolForm.zapierHookUrl} onChange={(event) => setSkoolForm({ ...skoolForm, zapierHookUrl: event.target.value })} /></label><label>Adapter signing secret<input type="password" required={!skool?.configured} autoComplete="new-password" value={skoolForm.adapterSecret} onChange={(event) => setSkoolForm({ ...skoolForm, adapterSecret: event.target.value })} /></label></> : null}
            <Button type="submit">Save Skool setup</Button>
          </form>
          <small>Skool does not document a general REST API. Automated access uses Skool’s official Zapier actions; revocation remains an honest manual step.</small>
        </article>
      </section>
      {loading ? <p>Loading integrations…</p> : (
        <section className="integration-provider-grid">
          {providers.filter((provider) => !["resend", "meetup"].includes(provider.id)).map((provider) => {
            const isEventbrite = provider.id === "eventbrite";
            const socialProvider = provider.id === "facebook" ? "meta" : ["linkedin", "instagram"].includes(provider.id) ? provider.id : "";
            const socialConnection = socialProvider ? socialConnections[socialProvider] : null;
            const selectedInstagramAsset = provider.id === "instagram" ? socialConnection?.assets?.find((asset) => asset.type === "instagram_business" && (socialConnection.selectedAssetIds || []).includes(asset.id)) : null;
            const selectedMetaInstagramAsset = provider.id === "instagram" ? socialConnections.meta?.assets?.find((asset) => asset.type === "instagram_business" && (socialConnections.meta.selectedAssetIds || []).includes(asset.id)) : null;
            const instagramAccountMismatch = Boolean(selectedInstagramAsset?.username && selectedMetaInstagramAsset?.username && selectedInstagramAsset.username.toLowerCase() !== selectedMetaInstagramAsset.username.toLowerCase());
            const status = socialProvider ? (socialConnection?.connected ? "connected" : socialConnection?.configured ? "configuration_required" : "planned") : isEventbrite && eventbriteReady ? "connected" : provider.status;
            return (
              <article className="crm-connection-card integration-provider-card" key={provider.id}>
                <div><span className={`integration-status integration-status--${status}`}>{statusLabels[status] || status}</span><h2>{provider.name}</h2></div>
                <p>{providerSummary(provider, eventbriteReady)}</p>
                <p className="integration-capabilities">{provider.capabilities?.join(" · ") || "No capabilities reported"}</p>
                {provider.limitation ? <p className="integration-limitation"><strong>Important:</strong> {provider.limitation}</p> : null}
                {instagramAccountMismatch ? <p className="integration-limitation"><strong>Reconnect required:</strong> Instagram Login is connected to @{selectedInstagramAsset.username}, but Lead Porch publishes to @{selectedMetaInstagramAsset.username}. Disconnect Instagram below, sign into @{selectedMetaInstagramAsset.username}, and reconnect it so new posts can be managed and deleted from Lead Porch.</p> : null}
                <div className="crm-connection-actions">
                  {isEventbrite ? (
                    <Button onClick={() => navigate("/integrations/eventbrite")}>{eventbriteReady ? "Manage setup" : "Set up Eventbrite"}</Button>
                  ) : provider.id === "csv" ? (
                    <Button variant="outline" onClick={() => navigate("/contacts")}>Import contacts</Button>
                  ) : provider.status === "public_only" ? (
                    <Button variant="outline" onClick={() => navigate("/discovery?tab=monitoring")}>Open public discovery</Button>
                  ) : socialProvider && socialConnection?.connected ? (
                    <><Button variant="outline" onClick={() => disconnectSocial(socialProvider)} loading={socialBusy === socialProvider}>Disconnect</Button></>
                  ) : socialProvider && socialConnection?.configured ? (
                    <Button onClick={() => connectSocial(socialProvider)} loading={socialBusy === socialProvider}>Connect {provider.name}</Button>
                  ) : provider.status === "planned" ? (
                    <button className="integration-disabled-action" disabled>Add provider app credentials first</button>
                  ) : (
                    <Button variant="outline" disabled>Details coming soon</Button>
                  )}
                </div>
                {socialProvider && socialConnection?.connected ? <div className="social-asset-picker"><strong>Authorized business assets</strong>{socialConnection.declinedScopes?.length ? <p>Meta did not grant: {socialConnection.declinedScopes.join(", ")}. Reconnect after those permissions are available.</p> : null}{socialConnection.assets?.length ? socialConnection.assets.map((asset) => { const subscription = socialConnection.webhookSubscriptions?.find((row) => row.assetId === asset.id); return <label key={`${asset.type}:${asset.id}`}><input type="checkbox" checked={(socialConnection.selectedAssetIds || []).includes(asset.id)} disabled={Boolean(socialBusy)} onChange={() => toggleSocialAsset(socialProvider, asset.id)} /><span>{asset.name}<small>{asset.type.replaceAll("_", " ")}{asset.username ? ` · @${asset.username}` : ""}</small>{subscription ? <small>Webhook: {subscription.status.replaceAll("_", " ")}{subscription.fields?.length ? ` · ${subscription.fields.join(", ")}` : ""}</small> : null}</span></label>; }) : <p>No manageable Pages or organizations were returned. Confirm the signed-in user is an administrator and that the provider approved the required scopes.</p>}</div> : null}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
