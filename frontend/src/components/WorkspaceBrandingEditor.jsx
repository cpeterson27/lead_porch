import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { uploadEventImage } from "../services/api.js";

const ASSETS = [
  ["faviconUrl", "Website favicon", "Shown in the visitor's browser tab."],
];
const APP_ASSETS = [
  [
    "faviconUrl",
    "App favicon",
    "Shown in the browser tab while staff are working.",
  ],
];
const SOCIALS = [
  ["Facebook", "https://facebook.com/"],
  ["Instagram", "https://instagram.com/"],
  ["LinkedIn", "https://linkedin.com/"],
  ["X", "https://x.com/"],
  ["YouTube", "https://youtube.com/"],
];

function AssetField({ label, help, value, onChange, onUpload, busy }) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <article className="brand-asset-field">
      <div className="brand-asset-field__preview">
        {value ? <img src={value} alt="" /> : <span>No asset selected</span>}
      </div>
      <div>
        <strong>{label}</strong>
        <small>{help}</small>
        <div className="brand-asset-field__actions">
          <label className="website-upload-button">
            {busy ? "Uploading…" : value ? "Replace" : "Upload"}
            <input
              disabled={busy}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => onUpload(event.target.files?.[0])}
            />
          </label>
          {value ? (
            <button type="button" onClick={() => onChange("")}>
              Remove
            </button>
          ) : null}
        </div>
        <button
          className="brand-advanced-toggle"
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
        >
          Advanced URL {advanced ? "−" : "+"}
        </button>
        {advanced ? (
          <input
            type="url"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://…"
          />
        ) : null}
      </div>
    </article>
  );
}

function LogoSlot({ surface, value, onChange, onUpload, busy }) {
  const [advanced, setAdvanced] = useState(false);
  const isDark = surface === "dark";
  return (
    <article className="logo-slot">
      <div
        className={`logo-slot__swatch logo-slot__swatch--${surface}`}
        aria-hidden="true"
      >
        {value ? (
          <img src={value} alt="" />
        ) : (
          <span className="logo-slot__placeholder">No logo yet</span>
        )}
      </div>
      <div className="logo-slot__body">
        <strong>{isDark ? "Dark backgrounds" : "Light backgrounds"}</strong>
        <small>
          {isDark
            ? "Used on dark surfaces — the dashboard sidebar, the application page, and your website when its surface is set to dark or charcoal."
            : "Used on light surfaces — your website header and footer when its surface is set to light."}
        </small>
        <div className="logo-slot__actions">
          <label className="website-upload-button">
            {busy ? "Uploading…" : value ? "Replace" : "Upload"}
            <input
              disabled={busy}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => onUpload(event.target.files?.[0])}
            />
          </label>
          {value ? (
            <button type="button" onClick={() => onChange("")}>
              Remove
            </button>
          ) : null}
        </div>
        <button
          className="brand-advanced-toggle"
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
        >
          Advanced URL {advanced ? "−" : "+"}
        </button>
        {advanced ? (
          <input
            type="url"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://…"
          />
        ) : null}
      </div>
    </article>
  );
}

function LogoField({
  lightValue,
  darkValue,
  onChangeLight,
  onChangeDark,
  onUploadLight,
  onUploadDark,
  busyLight,
  busyDark,
}) {
  return (
    <section className="logo-field">
      <header>
        <h4>Logo</h4>
        <p>
          One logo, in two variants. Used everywhere — your public website,
          the dashboard sidebar, and the program application page — so you
          only ever set it here.
        </p>
      </header>
      <div className="logo-field__slots">
        <LogoSlot
          surface="light"
          value={lightValue}
          onChange={onChangeLight}
          onUpload={onUploadLight}
          busy={busyLight}
        />
        <LogoSlot
          surface="dark"
          value={darkValue}
          onChange={onChangeDark}
          onUpload={onUploadDark}
          busy={busyDark}
        />
      </div>
    </section>
  );
}

export default function WorkspaceBrandingEditor({
  config,
  setConfig,
  onSave,
  saving,
  setError,
}) {
  const [uploading, setUploading] = useState(""),
    [saveMessage, setSaveMessage] = useState("");
  useEffect(() => {
    if (!saveMessage) return undefined;
    const timer = window.setTimeout(() => setSaveMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);
  const patchPublic = (key, value) =>
    setConfig((current) => ({
      ...current,
      branding: { ...current.branding, [key]: value },
    }));
  const patchApp = (key, value) => {
    const cssProperties = {
      sidebarBackgroundColor: "--app-sidebar-background",
      sidebarTextColor: "--app-sidebar-text",
      headerColor: "--app-header",
      primaryActionColor: "--app-primary-action",
      accentColor: "--app-accent",
      backgroundColor: "--app-background",
    };
    if (cssProperties[key])
      document.documentElement.style.setProperty(cssProperties[key], value);
    setConfig((current) => ({
      ...current,
      appBranding: { ...current.appBranding, [key]: value },
    }));
  };
  const patchSite = (key, value) =>
    setConfig((current) => ({
      ...current,
      publicSite: { ...current.publicSite, [key]: value },
    }));
  const patchSocial = (label, url) => {
    const current = config.publicSite?.socialLinks || [];
    const others = current.filter(
      (item) => item.label.toLowerCase() !== label.toLowerCase(),
    );
    patchSite("socialLinks", url.trim() ? [...others, { label, url }] : others);
  };
  const upload = async (scope, key, file) => {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp)$/.test(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      return setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
    try {
      setUploading(`${scope}.${key}`);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const asset = await uploadEventImage({ file: data });
      (scope === "branding"
        ? patchPublic
        : scope === "publicSite"
          ? patchSite
          : patchApp)(key, asset.url);
    } catch (error) {
      setError(error.response?.data?.error || "Unable to upload this image.");
    } finally {
      setUploading("");
    }
  };
  const app = config.appBranding || {},
    brand = config.branding || {};
  return (
    <div className="workspace-branding-editor">
      <section>
        <header>
          <p className="page-eyebrow">Public website branding</p>
          <h4>Visitor-facing identity</h4>
          <p>
            Your logo below is shared app-wide. Everything else on this page
            — name, colors, and copy — belongs only to the public website.
          </p>
        </header>
        <LogoField
          lightValue={brand.publicSiteLogoUrl || ""}
          darkValue={brand.publicSiteLogoDarkUrl || ""}
          onChangeLight={(value) => patchPublic("publicSiteLogoUrl", value)}
          onChangeDark={(value) => patchPublic("publicSiteLogoDarkUrl", value)}
          onUploadLight={(file) => upload("branding", "publicSiteLogoUrl", file)}
          onUploadDark={(file) => upload("branding", "publicSiteLogoDarkUrl", file)}
          busyLight={uploading === "branding.publicSiteLogoUrl"}
          busyDark={uploading === "branding.publicSiteLogoDarkUrl"}
        />
        <label>
          Public site name
          <input
            value={brand.publicSiteName || ""}
            onChange={(event) =>
              patchPublic("publicSiteName", event.target.value)
            }
          />
        </label>
        <label>
          Intro label
          <input
            value={config.publicSite?.introLabel || ""}
            onChange={(event) => patchSite("introLabel", event.target.value)}
          />
          <small>The short label shown above the homepage intro section.</small>
        </label>
        <label>
          Headline accent
          <input
            value={config.publicSite?.headlineAccent || ""}
            onChange={(event) =>
              patchSite("headlineAccent", event.target.value)
            }
          />
          <small>
            The exact text must appear inside the homepage headline to be
            highlighted.
          </small>
        </label>
        <label>
          Intro title accent
          <input
            value={config.publicSite?.introTitleAccent || ""}
            onChange={(event) =>
              patchSite("introTitleAccent", event.target.value)
            }
          />
          <small>
            The exact text must appear inside the homepage intro title to be
            highlighted.
          </small>
        </label>
        <label>
          Hero quote attribution
          <input
            value={config.publicSite?.heroQuoteAttribution || ""}
            onChange={(event) =>
              patchSite("heroQuoteAttribution", event.target.value)
            }
          />
          <small>The name or source shown below the hero quote.</small>
        </label>
        <label>
          About quote
          <textarea
            value={config.publicSite?.aboutQuote || ""}
            onChange={(event) => patchSite("aboutQuote", event.target.value)}
            rows="4"
          />
          <small>The pull-quote shown beside the homepage about story.</small>
        </label>
        <div className="brand-assets-list">
          {ASSETS.map(([key, label, help]) => (
            <AssetField
              key={key}
              label={label}
              help={help}
              value={brand[key] || ""}
              busy={uploading === `branding.${key}`}
              onChange={(value) => patchPublic(key, value)}
              onUpload={(file) => upload("branding", key, file)}
            />
          ))}

          <AssetField
            label="Brand feature / hero image"
            help="Optional visitor-facing image used in the homepage hero."
            value={config.publicSite?.heroMediaUrl || ""}
            busy={uploading === "publicSite.heroMediaUrl"}
            onChange={(value) => patchSite("heroMediaUrl", value)}
            onUpload={(file) => upload("publicSite", "heroMediaUrl", file)}
          />
          <AssetField
            label="About page photo"
            help="Shown beside the About story on the homepage. A vertical or square portrait works best."
            value={config.publicSite?.aboutImageUrl || ""}
            busy={uploading === "publicSite.aboutImageUrl"}
            onChange={(value) => patchSite("aboutImageUrl", value)}
            onUpload={(file) => upload("publicSite", "aboutImageUrl", file)}
          />
        </div>
        <div className="brand-color-grid">
          <label>
            Primary color
            <input
              type="color"
              value={brand.primaryColor || "#173f36"}
              onChange={(event) =>
                patchPublic("primaryColor", event.target.value)
              }
            />
          </label>
          <label>
            Accent color
            <input
              type="color"
              value={brand.accentColor || "#a8d65e"}
              onChange={(event) =>
                patchPublic("accentColor", event.target.value)
              }
            />
          </label>
          <label>
            Website surface
            <select
              value={brand.surfaceMode || "light"}
              onChange={(event) =>
                patchPublic("surfaceMode", event.target.value)
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="charcoal">Charcoal</option>
            </select>
          </label>
        </div>
        <div
          className={`brand-live-preview is-${brand.surfaceMode || "light"}`}
        >
          <span>Live preview · website</span>
          {brand.publicSiteLogoUrl ? (
            <img src={brand.publicSiteLogoUrl} alt="" />
          ) : (
            <strong>{brand.publicSiteName || "Your website"}</strong>
          )}
          <button type="button">Primary action</button>
        </div>
        <div className="social-profile-editor">
          <header>
            <h4>Social profiles</h4>
            <p>Add the profiles visitors can open from your public website.</p>
          </header>
          {SOCIALS.map(([label, placeholder]) => {
            const item = (config.publicSite?.socialLinks || []).find(
              (row) => row.label.toLowerCase() === label.toLowerCase(),
            );
            return (
              <label key={label}>
                <strong>{label}</strong>
                <input
                  type="url"
                  value={item?.url || ""}
                  placeholder={placeholder}
                  onChange={(event) => patchSocial(label, event.target.value)}
                />
                <span
                  className={`social-profile-state ${item?.url ? "is-on" : ""}`}
                >
                  {item?.url ? "Displayed" : "Hidden"}
                </span>
              </label>
            );
          })}
        </div>
      </section>
      <section>
        <header>
          <p className="page-eyebrow">Lead Porch app branding</p>
          <h4>Authenticated workspace identity</h4>
          <p>
            Used by Owner, Admin, Coach, Closer, Ambassador, Member, and Viewer
            portals. The sidebar always shows the dark-backgrounds logo set
            above — there's no separate logo to manage here.
          </p>
        </header>
        <div className="brand-assets-list">
          {APP_ASSETS.map(([key, label, help]) => (
            <AssetField
              key={key}
              label={label}
              help={help}
              value={app[key] || ""}
              busy={uploading === `appBranding.${key}`}
              onChange={(value) => patchApp(key, value)}
              onUpload={(file) => upload("appBranding", key, file)}
            />
          ))}
        </div>
        <div className="brand-color-grid">
          {[
            ["sidebarBackgroundColor", "Sidebar background"],
            ["sidebarTextColor", "Sidebar text"],
            ["headerColor", "App header"],
            ["primaryActionColor", "Primary action"],
            ["accentColor", "Accent"],
            ["backgroundColor", "App background"],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="color"
                value={app[key] || "#ffffff"}
                onChange={(event) => patchApp(key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <div
          className="brand-live-preview brand-app-preview"
          style={{
            background: app.sidebarBackgroundColor,
            color: app.sidebarTextColor,
          }}
        >
          <span>Live preview · app shell</span>
          {brand.publicSiteLogoDarkUrl || brand.publicSiteLogoUrl ? (
            <img
              src={brand.publicSiteLogoDarkUrl || brand.publicSiteLogoUrl}
              alt=""
            />
          ) : (
            <strong>Workspace</strong>
          )}
          <button
            type="button"
            style={{ background: app.primaryActionColor, color: "white" }}
          >
            Primary action
          </button>
        </div>
      </section>
      <footer>
        <Button
          loading={saving}
          onClick={async () => {
            setSaveMessage("");
            try {
              await onSave();
              setSaveMessage("Saved successfully.");
            } catch {
              setSaveMessage("Save failed. Review the message above.");
            }
          }}
        >
          Save branding
        </Button>
        <output className="branding-save-status" aria-live="polite">
          {saving ? "Saving all branding changes…" : saveMessage}
        </output>
      </footer>
    </div>
  );
}
