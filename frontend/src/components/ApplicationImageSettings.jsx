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

  const uploadHeroImage = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
      return;
    }
    try {
      setUploading(true);
      setError("");
      const asset = await uploadEventImage({ file: await fileData(file), filename: file.name });
      setConfig((current) => ({ ...current, heroImageUrl: asset.url }));
      setMessage("Hero image uploaded. Save to publish the change.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload the hero image.");
    } finally {
      setUploading(false);
    }
  };

  const removeHeroImage = () => {
    setConfig((current) => ({ ...current, heroImageUrl: "" }));
    setMessage("");
  };

  const save = async () => {
    try {
      setSaving(true);
      setConfig(await updateApplicationConfig(config));
      setMessage("Application page hero image saved.");
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the hero image.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="account-settings-panel account-settings-panel--refined">
      <header>
        <p className="page-eyebrow">Applications</p>
        <h2>Application page hero image</h2>
        <p>Shown at the top of your public application page. Choose a photo that represents your program.</p>
      </header>
      {message ? <p className="discovery-notice">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <section className="settings-section account-profile-form account-profile-form--compact">
        {config.heroImageUrl ? (
          <div className="application-hero-preview">
            <img src={config.heroImageUrl} alt="Application page hero" />
          </div>
        ) : (
          <p className="account-settings-empty">No hero image set yet. The application page will use its default layout.</p>
        )}
        <label className="form-field">
          <span>{config.heroImageUrl ? "Replace hero image" : "Upload hero image"}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={uploading}
            onChange={(event) => uploadHeroImage(event.target.files?.[0])}
          />
        </label>
        {config.heroImageUrl ? (
          <Button type="button" variant="outline" size="sm" onClick={removeHeroImage}>
            Remove hero image
          </Button>
        ) : null}
      </section>
      <footer>
        <Button loading={saving} disabled={uploading} onClick={save}>Save hero image</Button>
      </footer>
    </section>
  );
}
