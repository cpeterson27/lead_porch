import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { fetchApplicationConfig, updateApplicationConfig, uploadEventImage } from "../services/api.js";

const fileData = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export default function ApplicationImageSettings() {
  const [config, setConfig] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => fetchApplicationConfig()
      .then(setConfig)
      .catch((err) => setError(err.response?.data?.error || "Unable to load the application page settings.")), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!config) return error ? <p className="form-error">{error}</p> : null;

  const uploadLogo = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
      return;
    }
    try {
      setUploading(true);
      setError("");
      const asset = await uploadEventImage({ file: await fileData(file), filename: file.name });
      setConfig((current) => ({ ...current, logoUrl: asset.url }));
      setMessage("Logo uploaded. Save to publish the change.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload the logo.");
    } finally {
      setUploading(false);
    }
  };

  const removeLogo = () => {
    setConfig((current) => ({ ...current, logoUrl: "" }));
    setMessage("");
  };

  const save = async () => {
    try {
      setSaving(true);
      setConfig(await updateApplicationConfig(config));
      setMessage("Application page logo saved.");
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the logo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="account-settings-panel account-settings-panel--refined">
      <header>
        <p className="page-eyebrow">Applications</p>
        <h2>Application page logo</h2>
        <p>Shown at the top of your public application page. For best results, use a transparent PNG — it renders as-is, with no background box behind it.</p>
      </header>
      {message ? <p className="discovery-notice">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <section className="settings-section account-profile-form account-profile-form--compact">
        {config.logoUrl ? (
          <div className="application-hero-preview">
            <img src={config.logoUrl} alt="Application page logo" />
          </div>
        ) : (
          <p className="account-settings-empty">No logo set yet. The application page will use your site's main logo instead.</p>
        )}
        <label className="form-field">
          <span>{config.logoUrl ? "Replace logo" : "Upload logo"}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={uploading}
            onChange={(event) => uploadLogo(event.target.files?.[0])}
          />
        </label>
        {config.logoUrl ? (
          <Button type="button" variant="outline" size="sm" onClick={removeLogo}>
            Remove logo
          </Button>
        ) : null}
      </section>
      <footer>
        <Button loading={saving} disabled={uploading} onClick={save}>Save logo</Button>
      </footer>
    </section>
  );
}
