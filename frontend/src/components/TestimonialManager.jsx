import { useEffect, useRef, useState } from "react";
import { FiStar } from "react-icons/fi";
import Button from "./Button.jsx";
import TestimonialVideoPlayer from "./TestimonialVideoPlayer.jsx";
import {
  createManagedTestimonial,
  deleteManagedTestimonial,
  fetchManagedTestimonials,
  updateManagedTestimonial,
  uploadEventImage,
  uploadTestimonialVideo,
} from "../services/api.js";
import "./WebsiteManagement.css";

const blank = {
  displayName: "",
  headline: "",
  body: "",
  avatarUrl: "",
  resultContext: "",
  rating: "",
  videoUrl: "",
  status: "pending",
  featured: false,
  sortOrder: 0,
  consentConfirmed: true,
};

// Lets the admin scrub through the uploaded video and capture whatever frame
// is showing as the cover photo, instead of uploading a separate image.
function VideoCoverPicker({ videoUrl, coverUrl, onCapture }) {
  const videoRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setCapturing(true);
    setError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error("Could not capture this frame"));
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.9);
      });
      await onCapture(dataUrl);
    } catch {
      setError("Could not capture this frame — try a different spot in the video.");
    } finally {
      setCapturing(false);
    }
  };
  return (
    <div className="testimonial-cover-picker">
      <video
        ref={videoRef}
        className="testimonial-cover-picker__video"
        src={videoUrl}
        crossOrigin="anonymous"
        preload="metadata"
        muted
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime || 0)}
      />
      <input
        type="range"
        className="testimonial-cover-picker__scrubber"
        min="0"
        max={duration || 0}
        step="0.05"
        value={time}
        onChange={(event) => {
          const value = Number(event.target.value);
          setTime(value);
          if (videoRef.current) videoRef.current.currentTime = value;
        }}
      />
      <div className="testimonial-cover-picker__actions">
        <Button type="button" size="sm" loading={capturing} onClick={capture}>
          Use this frame as the cover photo
        </Button>
        {coverUrl ? <img className="testimonial-cover-picker__result" src={coverUrl} alt="Chosen cover frame" /> : null}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function PublicPreviewCard({ draft }) {
  return (
    <aside className="testimonial-public-preview">
      <strong>Public preview</strong>
      <div className="testimonial-public-preview__card">
        {draft.videoUrl ? (
          <TestimonialVideoPlayer videoUrl={draft.videoUrl} coverUrl={draft.avatarUrl} />
        ) : draft.avatarUrl ? (
          <img className="testimonial-avatar" src={draft.avatarUrl} alt="" />
        ) : null}
        {draft.rating ? (
          <div className="testimonial-stars" aria-hidden="true">
            {Array.from({ length: Number(draft.rating) }, (_, i) => (
              <FiStar key={i} />
            ))}
          </div>
        ) : null}
        <p>"{draft.body || "Your testimonial preview appears here."}"</p>
        {draft.resultContext ? <small>{draft.resultContext}</small> : null}
        <footer>
          <strong>{draft.displayName || "Client name"}</strong>
          {draft.headline ? <span>{draft.headline}</span> : null}
        </footer>
      </div>
    </aside>
  );
}

export default function TestimonialManager() {
  const [rows, setRows] = useState([]),
    [draft, setDraft] = useState(null),
    [confirmId, setConfirmId] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    fetchManagedTestimonials()
      .then(setRows)
      .catch((err) => setError(err.response?.data?.error || "Unable to load testimonials."));
  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const edit = (row = blank) => setDraft({ ...blank, ...row, rating: row.rating || "" });
  const save = async () => {
    try {
      setSaving(true);
      const payload = {
        ...draft,
        rating: draft.rating === "" ? null : Number(draft.rating),
        sortOrder: Number(draft.sortOrder) || 0,
      };
      const saved = draft._id
        ? await updateManagedTestimonial(draft._id, payload)
        : await createManagedTestimonial(payload);
      setRows((items) =>
        draft._id ? items.map((item) => (item._id === saved._id ? saved : item)) : [saved, ...items],
      );
      setDraft(null);
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save testimonial.");
    } finally {
      setSaving(false);
    }
  };
  const update = async (row, values) => {
    try {
      const saved = await updateManagedTestimonial(row._id, { ...row, ...values });
      setRows((items) => items.map((item) => (item._id === saved._id ? saved : item)));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update testimonial.");
    }
  };
  const remove = async (id) => {
    if (confirmId !== id) return setConfirmId(id);
    try {
      await deleteManagedTestimonial(id);
      setRows((items) => items.filter((item) => item._id !== id));
      setConfirmId("");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to delete testimonial.");
    }
  };
  const uploadVideo = async (file) => {
    if (!file) return;
    const allowed = ["video/mp4", "video/webm", "video/quicktime"];
    if (!allowed.includes(file.type) || file.size > 75 * 1024 * 1024)
      return setError("Choose an MP4, WEBM, or MOV video up to 75 MB.");
    try {
      setSaving(true);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const asset = await uploadTestimonialVideo({ file: data });
      setDraft((current) => ({ ...current, videoUrl: asset.url, avatarUrl: "" }));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload testimonial video.");
    } finally {
      setSaving(false);
    }
  };
  const captureCover = async (dataUrl) => {
    const asset = await uploadEventImage({ file: dataUrl, filename: "cover.jpg" });
    setDraft((current) => ({ ...current, avatarUrl: asset.url }));
  };
  return (
    <section
      className="account-settings-panel account-settings-panel--refined website-testimonials"
      id="website-testimonials"
    >
      <header>
        <div>
          <p className="page-eyebrow">Website content</p>
          <h2>Testimonials</h2>
          <p>Manage the client video stories displayed on your website. Only Published testimonials can appear publicly.</p>
        </div>
        <Button onClick={() => edit()}>Add Testimonial</Button>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      {draft ? (
        <section className="settings-section testimonial-editor" aria-label={draft._id ? "Edit testimonial" : "Add testimonial"}>
          <div className="account-profile-form account-profile-form--compact">
            <label className="form-field">
              <span>Customer/client name</span>
              <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            </label>
            <label className="form-field">
              <span>Title or subtitle</span>
              <input value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} />
            </label>
            <label className="form-field settings-address-fields__wide">
              <span>Testimonial</span>
              <textarea rows="5" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </label>
            <label className="form-field settings-address-fields__wide">
              <span>Optional result/context</span>
              <textarea value={draft.resultContext} onChange={(e) => setDraft({ ...draft, resultContext: e.target.value })} />
            </label>
            <label className="form-field settings-address-fields__wide">
              <span>Video testimonial (MP4/WEBM/MOV up to 75 MB)</span>
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                onChange={(e) => uploadVideo(e.target.files?.[0])}
              />
              {draft.videoUrl ? (
                <span className="testimonial-video">
                  <video src={draft.videoUrl} controls />
                  <button type="button" onClick={() => setDraft({ ...draft, videoUrl: "", avatarUrl: "" })}>
                    Remove video
                  </button>
                </span>
              ) : null}
            </label>
            {draft.videoUrl ? (
              <div className="form-field settings-address-fields__wide">
                <span>Cover photo — scrub the video and pick the frame to use</span>
                <VideoCoverPicker videoUrl={draft.videoUrl} coverUrl={draft.avatarUrl} onCapture={captureCover} />
              </div>
            ) : null}
            <label className="form-field">
              <span>Display order</span>
              <input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} />
            </label>
            <label className="form-field">
              <span>Visibility</span>
              <select
                value={draft.status}
                onChange={(e) =>
                  setDraft({ ...draft, status: e.target.value, featured: e.target.value === "approved" ? draft.featured : false })
                }
              >
                <option value="pending">Hidden</option>
                <option value="approved">Published</option>
              </select>
            </label>
            <label className="form-field">
              <span>
                <input
                  type="checkbox"
                  checked={draft.featured}
                  disabled={draft.status !== "approved"}
                  onChange={(e) => setDraft({ ...draft, featured: e.target.checked })}
                />{" "}
                Featured on homepage
              </span>
            </label>
          </div>
          <PublicPreviewCard draft={draft} />
          <div className="testimonial-editor__actions">
            <Button loading={saving} disabled={!draft.displayName.trim() || !draft.body.trim()} onClick={save}>
              Save testimonial
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
      <div className="website-testimonial-list">
        {rows.map((row) => (
          <article key={row._id}>
            <div>
              {row.avatarUrl ? <img src={row.avatarUrl} alt="" /> : <span>{row.displayName.slice(0, 1)}</span>}
              <div>
                <strong>{row.displayName}</strong>
                <p>{row.body}</p>
                <small>
                  {row.status === "approved" ? "Published" : "Hidden"}
                  {row.featured ? " · Featured on homepage" : ""}
                  {row.videoUrl ? " · Has video" : ""} · Order {row.sortOrder || 0}
                </small>
              </div>
            </div>
            <div className="website-testimonial-actions">
              <Button size="sm" variant="outline" onClick={() => edit(row)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => update(row, { status: row.status === "approved" ? "pending" : "approved" })}
              >
                {row.status === "approved" ? "Hide" : "Publish"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={row.status !== "approved"}
                onClick={() => update(row, { featured: !row.featured })}
              >
                {row.featured ? "Unfeature" : "Feature"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(row._id)}>
                {confirmId === row._id ? "Confirm delete" : "Delete"}
              </Button>
              {confirmId === row._id ? (
                <Button size="sm" variant="outline" onClick={() => setConfirmId("")}>
                  Keep
                </Button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
