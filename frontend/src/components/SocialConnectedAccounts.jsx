import { useState } from "react";
import { Link } from "react-router-dom";
import { FaFacebookF, FaInstagram, FaLinkedinIn } from "react-icons/fa";
import Button from "./Button.jsx";
import {
  channelDefinitions,
  connectionState,
} from "./socialConnectionPresentation.js";
import "./SocialConnectedAccounts.css";

const icons = {
  meta: FaFacebookF,
  instagram: FaInstagram,
  linkedin: FaLinkedinIn,
};
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not recorded";
const socialAssetIdentity = (asset) => ({
  primary: asset?.username
    ? `@${String(asset.username).replace(/^@/, "")}`
    : asset?.name || "Account",
  secondary:
    asset?.username && asset?.name && asset.name !== asset.username
      ? asset.name
      : "",
});
function AssetAvatar({ asset }) {
  const identity = socialAssetIdentity(asset);
  return asset?.avatarUrl ? (
    <img
      className="social-asset-avatar"
      src={asset.avatarUrl}
      alt={`${identity.primary} profile`}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="social-asset-avatar social-asset-initials" aria-hidden="true">
      {(asset?.name || asset?.username || "Account").slice(0, 1).toUpperCase()}
    </span>
  );
}
function emptyAssetsGuidance(provider) {
  if (provider === "linkedin")
    return "No manageable LinkedIn Pages were returned. Confirm that you administer a LinkedIn Page and that organization access is approved, then click Reconnect to refresh this list.";
  return "No Facebook Pages were found for this Facebook profile. In Meta Business Suite, confirm this profile has admin access to the Facebook Page linked to your Instagram business account, then click Reconnect below to refresh this list.";
}
function ChannelRow({
  channel,
  connection,
  connections,
  busy,
  onConnect,
  onDisconnect,
  onSelectAssets,
  onRefresh,
}) {
  const Icon = icons[channel.provider];
  const state = connectionState(connection);
  const [manageOpen, setManageOpen] = useState(false);
  const selectedIds = connection.selectedAssetIds || [];
  const assets = connection.assets || [];
  const account = connection.account || {};
  const isDirectInstagram = channel.provider === "instagram";
  const manageableAssets = isDirectInstagram
    ? []
    : channel.provider === "meta"
      ? assets.filter((asset) =>
          ["facebook_page", "instagram_business"].includes(asset.type),
        )
      : assets.filter(
          (asset) => !channel.assetType || asset.type === channel.assetType,
        );
  const selected = manageableAssets.filter((asset) =>
    selectedIds.includes(asset.id),
  );
  const directAsset = isDirectInstagram ? assets[0] : null;
  const directActive = directAsset ? selectedIds.includes(directAsset.id) : false;
  const elsewhere = new Set(
    connections
      .filter((row) => row.provider !== connection.provider)
      .flatMap((row) => row.selectedAssetIds || []),
  );
  const needsDecision =
    connection.connected && !isDirectInstagram && selected.length === 0;
  const showManage = manageOpen || needsDecision;
  const choose = (asset, checked) =>
    onSelectAssets(
      connection.provider,
      checked
        ? [...selectedIds, asset.id]
        : selectedIds.filter(
            (id) =>
              id !== asset.id &&
              !assets.some((row) => row.id === id && row.parentId === asset.id),
          ),
    );
  const toggleDirect = (checked) =>
    onSelectAssets(connection.provider, checked ? [directAsset.id] : []);
  const picker = manageableAssets.length > 0 && (
    <fieldset className="social-page-picker" disabled={busy}>
      <legend>
        {channel.provider === "meta"
          ? "Choose which Facebook Page to manage"
          : "Choose which LinkedIn Page to manage"}
      </legend>
      <p className="social-page-picker-hint">
        Only selected accounts are used. If a Page or account is missing, click
        Reconnect below to refresh this list.
      </p>
      {manageableAssets.map((asset) => {
        const ownedElsewhere = elsewhere.has(asset.id);
        const needsParent =
          asset.type === "instagram_business" &&
          asset.parentId &&
          !selectedIds.includes(asset.parentId);
        const linked = manageableAssets.find(
          (row) => row.parentId === asset.id,
        );
        const identity = socialAssetIdentity(asset);
        const isChecked = selectedIds.includes(asset.id);
        return (
          <label
            key={asset.id}
            className={
              asset.parentId ? "social-page-picker-row--child" : undefined
            }
          >
            <input
              type="checkbox"
              className="social-checkbox"
              checked={isChecked}
              disabled={ownedElsewhere || needsParent}
              onChange={(event) => choose(asset, event.target.checked)}
            />
            <AssetAvatar asset={asset} />
            <span>
              {identity.primary}
              <small>
                {[
                  identity.secondary,
                  ownedElsewhere
                    ? "Already connected through another method — deselect it there to switch"
                    : needsParent
                      ? "Select its Facebook Page first"
                      : isChecked
                        ? "Active for Lead Porch"
                        : "Available to select",
                  linked
                    ? `Linked Instagram: @${linked.username || linked.name}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
          </label>
        );
      })}
      {channel.provider === "meta" && (
        <p>
          A linked Instagram account becomes active only after you select it
          together with its Facebook Page.
        </p>
      )}
    </fieldset>
  );
  const subscriptionRows = connection.webhookSubscriptions || [];
  const subscriptionSummary = subscriptionRows.length
    ? subscriptionRows.every((row) => row.status === "subscribed")
      ? { tone: "connected", text: "Message and comment notifications are active." }
      : {
          tone: "attention",
          text: "Message notifications need attention. Try Reconnect below, or reselect the account above.",
        }
    : null;
  const identityBlock = connection.connected && (
    <div className="social-identity" aria-label={`${channel.name} signed-in profile`}>
      <AssetAvatar asset={account} />
      <span>
        <strong>Signed in as</strong>
        <span className="social-identity-name">
          {account.username
            ? `@${String(account.username).replace(/^@/, "")}`
            : account.name || "Account"}
        </span>
        {account.name && account.username && account.name !== account.username && (
          <small>{account.name}</small>
        )}
        {account.id && <small>Account ID: {account.id}</small>}
      </span>
    </div>
  );
  if (!connection.connected && !channel.secondary)
    return (
      <article className="social-channel social-channel--choice">
        <div className="social-choice-heading">
          <span
            className={`social-channel-icon social-channel-icon--${channel.provider}`}
            aria-hidden="true"
          >
            {Icon ? <Icon /> : "𝕏"}
          </span>
          {channel.recommended && (
            <span className="social-recommended-badge">Recommended</span>
          )}
        </div>
        <div className="social-channel-copy">
          <h3>{channel.name}</h3>
          <p>{channel.description}</p>
        </div>
        {channel.preConnectNotice && (
          <p className="social-precheck-notice" role="note">
            {channel.preConnectNotice}
          </p>
        )}
        {connection.configured ? (
          <Button
            disabled={busy}
            onClick={() => onConnect(connection.provider)}
          >
            {channel.connectLabel || `Connect ${channel.name}`}
          </Button>
        ) : (
          <span className="social-setup-label">Setup required</span>
        )}
        {(connection.authorizationNotice || connection.lastError) && (
          <details className="social-connection-details">
            <summary>Connection details</summary>
            <p role="status">
              {connection.authorizationNotice || connection.lastError}
            </p>
          </details>
        )}
      </article>
    );
  return (
    <article
      className={`social-channel ${connection.connected ? "social-channel--connected" : ""} ${channel.secondary ? "social-channel--secondary" : ""}`}
    >
      <div className="social-channel-main">
        <span
          className={`social-channel-icon social-channel-icon--${channel.provider}`}
          aria-hidden="true"
        >
          {Icon ? <Icon /> : "𝕏"}
        </span>
        <div className="social-channel-copy">
          <h3>{channel.name}</h3>
          <p>
            {connection.connected ? "Connected accounts" : channel.description}
          </p>
        </div>
        <span
          className={`social-connection-badge social-connection-badge--${state.tone}`}
        >
          {state.label}
        </span>
        {connection.connected && !isDirectInstagram && (
          <div className="social-channel-action">
            <button
              type="button"
              className="social-manage-link"
              aria-expanded={showManage}
              onClick={() => setManageOpen((open) => !open)}
            >
              {showManage ? "Hide account list" : "Manage connection"}
            </button>
          </div>
        )}
      </div>
      {identityBlock}
      {connection.connected && isDirectInstagram && directAsset && (
        <div
          className={`social-direct-toggle ${directActive ? "social-direct-toggle--active" : ""}`}
        >
          <span
            className={`social-connection-badge social-connection-badge--${directActive ? "connected" : "neutral"}`}
          >
            {directActive ? "Active for Lead Porch" : "Not active yet"}
          </span>
          <p>
            {directActive
              ? "Lead Porch automations and publishing use this Instagram account."
              : "This Instagram account is authorized but not yet in use anywhere in Lead Porch. Activate it below."}
          </p>
          <Button
            variant={directActive ? "outline" : undefined}
            disabled={busy}
            onClick={() => toggleDirect(!directActive)}
          >
            {directActive ? "Deactivate this account" : "Activate this account"}
          </Button>
        </div>
      )}
      {connection.connected && !isDirectInstagram && selected.length > 0 && (
        <div className="social-connected-assets">
          {selected.map((asset) => {
            const identity = socialAssetIdentity(asset);
            return (
              <div className="social-connected-asset" key={asset.id}>
                <AssetAvatar asset={asset} />
                <span>
                  <strong>
                    {asset.type === "facebook_page"
                      ? "Facebook"
                      : asset.type === "linkedin_organization"
                        ? "LinkedIn"
                        : "Instagram"}
                  </strong>
                  <span>{identity.primary}</span>
                  {identity.secondary && <small>{identity.secondary}</small>}
                </span>
                <span className="social-asset-state social-asset-state--selected">
                  Active
                </span>
              </div>
            );
          })}
        </div>
      )}
      {connection.connected && !isDirectInstagram && showManage && (
        <div className="social-manage-panel">
          {manageableAssets.length > 0 ? (
            picker
          ) : (
            <p className="social-empty-assets">
              {emptyAssetsGuidance(channel.provider)}
            </p>
          )}
        </div>
      )}
      <details className="social-connection-details">
        <summary>Connection details</summary>
        {connection.authorizationNotice && (
          <p role="status">{connection.authorizationNotice}</p>
        )}
        <dl>
          <div>
            <dt>Authorization method</dt>
            <dd>{channel.method}</dd>
          </div>
          <div>
            <dt>Last verified</dt>
            <dd>{date(connection.lastVerifiedAt)}</dd>
          </div>
          <div>
            <dt>Authorization expires</dt>
            <dd>{date(connection.expiresAt)}</dd>
          </div>
          <div>
            <dt>Granted permissions</dt>
            <dd>{connection.scopes?.join(", ") || "None yet"}</dd>
          </div>
          {connection.declinedScopes?.length > 0 && (
            <div>
              <dt>Permissions needing attention</dt>
              <dd>{connection.declinedScopes.join(", ")}</dd>
            </div>
          )}
        </dl>
        {subscriptionSummary && (
          <p
            className={`social-subscription-status social-subscription-status--${subscriptionSummary.tone}`}
            role="status"
          >
            {subscriptionSummary.text}
          </p>
        )}
        <p>
          {channel.provider === "meta"
            ? "Facebook Login can also authorize linked professional Instagram accounts. Available actions depend on the selected assets and approved permissions."
            : channel.provider === "instagram"
              ? "A professional Instagram account and approved permissions are required."
              : channel.provider === "linkedin"
                ? "Organization publishing requires approved Community Management access and organization permissions."
                : "Text publishing is available after external setup. Media upload and account-activity ingestion are not implemented."}{" "}
          Provider credentials and app approval are managed by your
          administrator.
        </p>
        {connection.disconnectNotice && <p>{connection.disconnectNotice}</p>}
        {connection.connected && (
          <div className="social-connection-actions">
            {onRefresh && channel.provider === "instagram" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onRefresh("instagram")}
              >
                Refresh authorization
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onConnect(connection.provider)}
            >
              Reconnect
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onDisconnect(connection.provider)}
            >
              Disconnect
            </Button>
          </div>
        )}
      </details>
    </article>
  );
}

export default function SocialConnectedAccounts({
  data,
  busy,
  onConnect,
  onDisconnect,
  onSelectAssets,
  onRefresh,
}) {
  const render = (channel) => {
    const connection = data.connections.find(
      (row) => row.provider === channel.provider,
    );
    return connection ? (
      <ChannelRow
        key={channel.provider}
        connections={data.connections}
        {...{
          channel,
          connection,
          busy,
          onConnect,
          onDisconnect,
          onSelectAssets,
          onRefresh,
        }}
      />
    ) : null;
  };
  return (
    <div className="social-connections" aria-busy={busy}>
      {Array.isArray(data.capabilityChecklist) && (
        <section
          className="social-capability-checklist"
          aria-labelledby="social-capability-heading"
        >
          <header className="social-connections-heading">
            <h2 id="social-capability-heading">Lead generation capabilities</h2>
            <p>
              Connect accounts, complete Meta review, and enable production
              controls to unlock each workflow. Lead capture and tracked CTAs
              are available now.
            </p>
          </header>
          <div className="social-capability-list">
            {data.capabilityChecklist.map((item) => (
              <div className="social-capability-item" key={item.key}>
                <span
                  className={`social-connection-badge social-connection-badge--${item.ready ? "connected" : "neutral"}`}
                >
                  {item.ready
                    ? "Ready"
                    : item.review
                      ? "Needs Meta setup"
                      : "Available"}
                </span>
                <strong>{item.label}</strong>
                {item.review && !item.ready && (
                  <small>
                    Grant the permission, configure the webhook, and complete
                    App Review.
                  </small>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="connected-accounts-heading">
        <header className="social-connections-heading">
          <h2 id="connected-accounts-heading">Connect your social accounts</h2>
          <p>
            Choose how you want to connect. You can change or disconnect
            accounts later.
          </p>
        </header>
        <div className="social-channel-list social-channel-list--choices">
          {channelDefinitions
            .filter((channel) => !channel.secondary)
            .map(render)}
        </div>
        <details className="social-choice-help">
          <summary>Which option should I choose?</summary>
          <p>
            <strong>Facebook + Instagram:</strong> Choose this when your
            Facebook Page and professional Instagram account are linked in Meta.
          </p>
          <p>
            <strong>Instagram only:</strong> Choose this when connecting an
            Instagram professional account directly.
          </p>
        </details>
      </section>
      <section aria-labelledby="more-channels-heading">
        <header className="social-connections-heading">
          <h2 id="more-channels-heading">More channels</h2>
          <p>Additional channels may need provider setup and approval.</p>
        </header>
        <div className="social-channel-list">
          {channelDefinitions
            .filter((channel) => channel.secondary)
            .map(render)}
        </div>
      </section>
      <section
        className="social-automation-safety"
        aria-labelledby="automation-safety-heading"
      >
        <div>
          <h2 id="automation-safety-heading">Automation safety</h2>
          <p>
            Connecting an account does not enable publishing or automatic
            replies.
          </p>
        </div>
        <dl>
          {[
            ["Publishing", data.publishingEnabled],
            ["Automatic replies", data.automaticRepliesEnabled],
          ].map(([label, enabled]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd
                className={`social-connection-badge social-connection-badge--${enabled === true ? "attention" : "neutral"}`}
              >
                {enabled === true
                  ? "Enabled"
                  : enabled === false
                    ? "Disabled"
                    : "Status unavailable"}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <details className="social-workspace-details">
        <summary>Workspace tools</summary>
        <p>
          AI:{" "}
          {data.ai?.enabled
            ? "Enabled"
            : "Setup required — manual creation remains available"}
        </p>
        <Link to="/automations/content-template">
          Manage introduction content template
        </Link>
      </details>
    </div>
  );
}
