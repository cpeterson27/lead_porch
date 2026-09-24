import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "./Button.jsx";
import WorkspaceBrandingEditor from "./WorkspaceBrandingEditor.jsx";
import {
  createManagedProfile,
  createManagedTestimonial,
  createStudentProfileEditToken,
  fetchCoaches,
  fetchCoachingPrograms,
  fetchContacts,
  fetchManagedProfiles,
  fetchManagedTestimonials,
  fetchPublicManagementConfig,
  fetchWorkspaceMembers,
  loadLeadPorchStarterSite,
  updateManagedProfile,
  updateManagedTestimonial,
  updateProgramPublicPresentation,
  updatePublicManagementConfig,
  uploadEventImage,
  uploadHomepageVideo as uploadHomepageVideoAsset,
  uploadDiscoveryCallVideo as uploadDiscoveryCallVideoAsset,
} from "../services/api.js";
import "./PublicSiteAdmin.css";

const blankTestimonial = {
  displayName: "",
  headline: "",
  body: "",
  videoUrl: "",
  consentConfirmed: true,
  status: "pending",
  featured: false,
};
const blankProfile = {
  ownerType: "coach",
  coachProfileId: "",
  contactId: "",
  userId: "",
  slug: "",
  displayName: "",
  publicTitle: "",
  headline: "",
  bio: "",
  avatarUrl: "",
  specialties: [],
  featured: false,
  sortOrder: 0,
};
const visibilityLabels = {
  video: "Intro video",
  proof: "Trust metrics",
  programs: "Programs",
  journey: "Student journey",
  team: "Team",
  testimonials: "Testimonials",
  results: "Show Results page",
  event: "Upcoming event",
  community: "Skool/community",
  heroCopy: "Hero heading, text & buttons",
  heroImage: "Hero photo",
  heroQuote: "Hero pull-quote",
};
const bookingDays = [
  [0, "Sunday"], [1, "Monday"], [2, "Tuesday"], [3, "Wednesday"],
  [4, "Thursday"], [5, "Friday"], [6, "Saturday"],
];
const starterFaqs = [
  { question: "Who are the coaching programs for?", answer: "The programs are designed for aspiring and active multifamily real estate investors who want structured education, practical guidance, and accountability." },
  { question: "Is coaching available online?", answer: "Yes. Coaching is primarily delivered virtually. Select programs may also include in-person property tours or educational experiences when offered." },
  { question: "Which program should I choose?", answer: "Review the coaching programs, then book a discovery call or submit an application so the team can help identify the most appropriate next step." },
];
const lines = (value) => (value || []).join("\n");
const list = (value) =>
  String(value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
const metricText = (value) =>
  (value || []).map((row) => `${row.value}|${row.label}`).join("\n");
const metrics = (value) =>
  String(value || "")
    .split("\n")
    .map((row) => {
      const i = row.indexOf("|");
      return i < 0
        ? null
        : { value: row.slice(0, i).trim(), label: row.slice(i + 1).trim() };
    })
    .filter(Boolean);

function HomepageVideoCoverPicker({ videoUrl, coverUrl, onCapture }) {
  const videoRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const capture = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return setError("Wait for the video preview to load, then try again.");
    try {
      setCapturing(true);
      setError("");
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
      setError("Could not capture this frame. Try a different spot in the video.");
    } finally {
      setCapturing(false);
    }
  };
  return (
    <div className="testimonial-cover-picker homepage-cover-picker">
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
        aria-label="Choose homepage video cover frame"
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
        {coverUrl ? <img className="testimonial-cover-picker__result" src={coverUrl} alt="Chosen homepage cover frame" /> : null}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

export default function PublicSiteAdmin({ section = "website" }) {
  const [tab, setTab] = useState(section === "team" ? "team" : "brand"),
    [config, setConfig] = useState(null),
    [testimonials, setTestimonials] = useState([]),
    [programs, setPrograms] = useState([]),
    [profiles, setProfiles] = useState([]),
    [coaches, setCoaches] = useState([]),
    [contacts, setContacts] = useState([]),
    [members, setMembers] = useState([]),
    [testimonial, setTestimonial] = useState(blankTestimonial),
    [profile, setProfile] = useState(blankProfile),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState(""),
    [editingProfileId, setEditingProfileId] = useState("");
  const load = async () => {
    try {
      const [c, t, p, pr, co, wm] = await Promise.all([
        fetchPublicManagementConfig(),
        fetchManagedTestimonials(),
        fetchCoachingPrograms({ limit: 200 }),
        fetchManagedProfiles(),
        fetchCoaches({ limit: 200 }),
        fetchWorkspaceMembers(),
      ]);
      setConfig(c);
      setTestimonials(t);
      setPrograms(p);
      setProfiles(pr);
      setCoaches(co);
      setMembers((wm.members || []).filter((row) => row.status === "active"));
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to load public-site settings.",
      );
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);
  // Contacts are only used by the Team tab's "Student Contact" picker — not
  // needed to render Branding, Homepage, Video, Discovery call, or Visible
  // sections at all, so this used to fetch every contact on every page load
  // regardless of which tab was open. Loaded once, only when the Team tab
  // is actually visited.
  useEffect(() => {
    if (tab !== "team" || contacts.length) return;
    fetchContacts({ limit: 200 })
      .then((ct) => setContacts(ct.contacts || ct || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const saveConfig = async () => {
    try {
      setSaving(true);
      setError("");
      const saved = await updatePublicManagementConfig(config);
      const verified = await fetchPublicManagementConfig();
      setConfig(verified);
      const requestedSurface = config.branding?.surfaceMode || "light";
      const savedSurface = verified.branding?.surfaceMode || "light";
      if (requestedSurface !== savedSurface) {
        throw new Error(
          `The server saved ${savedSurface} instead of ${requestedSurface}.`,
        );
      }
      // A URL that doesn't pass the safe-URL check (must be a real,
      // absolute https:// link) is silently dropped to an empty string on
      // save rather than rejected outright — correct behavior for the
      // server, but it must never happen without the owner being told, or
      // it looks exactly like the setting was never saved at all.
      // Tell WorkspaceThemeContext (which drives the navbar/sidebar colors
      // everywhere else in the app) to re-fetch immediately, instead of
      // leaving it showing whatever colors were live at page load.
      window.dispatchEvent(new CustomEvent("workspace-theme-updated"));
      setMessage("All branding changes saved successfully.");
      return saved;
    } catch (err) {
      setError(
        err.response?.data?.error || err.message || "Unable to save public-site settings.",
      );
    } finally {
      setSaving(false);
    }
  };
  const loadLeadPorchStarter = async () => {
    if (
      !window.confirm(
        "Replace this workspace website with the Lead Porch starter site?",
      )
    )
      return;
    try {
      setSaving(true);
      setError("");
      setConfig(await loadLeadPorchStarterSite());
      setMessage(
        "Lead Porch starter site loaded. Review and save your contact details.",
      );
    } catch (err) {
      setError(
        err.response?.data?.error ||
          "Unable to load the Lead Porch starter site.",
      );
    } finally {
      setSaving(false);
    }
  };
  const patchPublic = (key, value) =>
    setConfig((current) => ({
      ...current,
      publicSite: { ...current.publicSite, [key]: value },
    }));
  const patchVisibility = (key, value) =>
    patchPublic("sectionVisibility", {
      ...config.publicSite.sectionVisibility,
      [key]: value,
    });
  const patchModuleAccess = (key, value) =>
    setConfig((current) => ({
      ...current,
      moduleAccess: { ...current.moduleAccess, [key]: value },
    }));
  const siteName =
    config?.branding?.publicSiteName ||
    config?.workspaceName ||
    "your workspace";
  const fileData = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  const uploadSiteImage = async (file, key, label = "image") => {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp)$/.test(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      return setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
    try {
      setUploading(key);
      setError("");
      const asset = await uploadEventImage({
        file: await fileData(file),
        filename: file.name,
      });
      patchPublic(key, asset.url);
      setMessage(`${label} uploaded. Save to publish the change.`);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          `Unable to upload the ${label.toLowerCase()}.`,
      );
    } finally {
      setUploading("");
    }
  };
  const uploadHomepageVideo = async (file) => {
    if (!file) return;
    const supportedType = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ].includes(file.type);
    const supportedExtension =
      file.type === "" && /\.(mp4|webm|mov)$/i.test(file.name);
    if (
      file.size <= 0 ||
      (!supportedType && !supportedExtension) ||
      file.size > 75 * 1024 * 1024
    )
      return setError("Choose an MP4, WEBM, or MOV video up to 75 MB.");
    try {
      setUploading("introVideoUrl");
      setError("");
      const asset = await uploadHomepageVideoAsset(file);
      patchPublic("introVideoUrl", asset.url);
      setMessage("Homepage video uploaded. Save to publish the change.");
    } catch (err) {
      const uploadError = err.response?.data?.error;
      setError(
        (typeof uploadError === "string" ? uploadError : uploadError?.message) ||
          err.message ||
          "Unable to upload the homepage video.",
      );
    } finally {
      setUploading("");
    }
  };
  const captureHomepageCover = async (dataUrl) => {
    try {
      setUploading("introVideoPosterUrl");
      setError("");
      const asset = await uploadEventImage({
        file: dataUrl,
        filename: "homepage-video-cover.jpg",
      });
      patchPublic("introVideoPosterUrl", asset.url);
      setMessage("Homepage cover frame selected. Save to publish the change.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the homepage cover frame.");
      throw err;
    } finally {
      setUploading("");
    }
  };
  const uploadDiscoveryCallVideo = async (file) => {
    if (!file) return;
    const supportedType = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ].includes(file.type);
    const supportedExtension =
      file.type === "" && /\.(mp4|webm|mov)$/i.test(file.name);
    if (
      file.size <= 0 ||
      (!supportedType && !supportedExtension) ||
      file.size > 75 * 1024 * 1024
    )
      return setError("Choose an MP4, WEBM, or MOV video up to 75 MB.");
    try {
      setUploading("discoveryCallVideoUrl");
      setError("");
      const asset = await uploadDiscoveryCallVideoAsset(file);
      patchPublic("discoveryCallVideoUrl", asset.url);
      setMessage("Discovery call video uploaded. Save to publish the change.");
    } catch (err) {
      const uploadError = err.response?.data?.error;
      setError(
        (typeof uploadError === "string" ? uploadError : uploadError?.message) ||
          err.message ||
          "Unable to upload the discovery call video.",
      );
    } finally {
      setUploading("");
    }
  };
  const captureDiscoveryCallCover = async (dataUrl) => {
    try {
      setUploading("discoveryCallVideoPosterUrl");
      setError("");
      const asset = await uploadEventImage({
        file: dataUrl,
        filename: "discovery-call-video-cover.jpg",
      });
      patchPublic("discoveryCallVideoPosterUrl", asset.url);
      setMessage("Discovery call cover frame selected. Save to publish the change.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save the discovery call cover frame.");
      throw err;
    } finally {
      setUploading("");
    }
  };
  const uploadProfilePhoto = async (id, file) => {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp)$/.test(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      return setError("Choose a PNG, JPG, or WEBP profile photo up to 5 MB.");
    try {
      setUploading(`profile-${id}`);
      const asset = await uploadEventImage({
        file: await fileData(file),
        filename: file.name,
      });
      patchProfile(id, "avatarUrl", asset.url);
      setMessage(
        "Profile photo uploaded. Save the public profile to publish it.",
      );
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to upload the profile photo.",
      );
    } finally {
      setUploading("");
    }
  };
  const addTestimonial = async () => {
    try {
      const saved = await createManagedTestimonial(testimonial);
      setTestimonials((rows) => [saved, ...rows]);
      setTestimonial(blankTestimonial);
      setMessage("Testimonial saved successfully.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to create testimonial.");
    }
  };
  const decide = async (row, status, extra = {}) => {
    const saved = await updateManagedTestimonial(row._id, { status, ...extra });
    setTestimonials((rows) =>
      rows.map((item) => (item._id === saved._id ? saved : item)),
    );
    setMessage(`Testimonial ${status} successfully.`);
  };
  const saveProgram = async (program) => {
    try {
      const saved = await updateProgramPublicPresentation(
        program._id,
        program.publicPresentation || {},
      );
      setPrograms((rows) =>
        rows.map((row) => (row._id === saved._id ? saved : row)),
      );
      setMessage("Program public details saved.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save program.");
    }
  };
  const addProfile = async () => {
    try {
      const saved = await createManagedProfile(profile);
      setProfiles((rows) => [...rows, saved]);
      setProfile(blankProfile);
      setMessage(`${saved.displayName} public profile saved successfully.`);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to create profile.");
    }
  };
  const saveProfile = async (row) => {
    try {
      const saved = await updateManagedProfile(row._id, row);
      setProfiles((rows) =>
        rows.map((item) => (item._id === saved._id ? saved : item)),
      );
      setMessage(`${saved.displayName} public profile saved.`);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to save profile.");
    }
  };
  const patchProfile = (id, key, value) =>
    setProfiles((rows) =>
      rows.map((row) => (row._id === id ? { ...row, [key]: value } : row)),
    );
  const patchValue = (index, key, value) =>
    patchPublic(
      "valuePropositions",
      (config.publicSite.valuePropositions || []).map((row, i) =>
        i === index ? { ...row, [key]: value } : row,
      ),
    );
  const token = async (row) => {
    const result = await createStudentProfileEditToken(row._id);
    setMessage(
      `Student edit link (copy now): ${window.location.origin}${result.editPath}`,
    );
  };
  if (!config)
    return (
      <div className="public-admin">{error || "Loading Website & Brand…"}</div>
    );
  return (
    <div
      className="website-focused-panel public-admin"
      style={{ "--website-editor-accent": config.branding?.accentColor || "#7457ff" }}
    >
      {section === "website" ? (
        <header>
          <div>
            <p className="page-eyebrow">Website settings</p>
            <h3>Homepage &amp; branding</h3>
            <p>
              Manage the website identity, homepage content, navigation and
              visible sections.
            </p>
          </div>
          {config.workspace?.slug !== "ellie" ? (
            <Button variant="outline" onClick={loadLeadPorchStarter}>
              Load Lead Porch starter
            </Button>
          ) : null}
        </header>
      ) : (
        <header className="website-section-heading">
          <div>
            <p className="page-eyebrow">Public profiles</p>
            <h3>Team &amp; Coaches</h3>
            <p>
              Choose who appears on the website. Workspace access is managed
              separately in Team &amp; Access.
            </p>
          </div>
          <Button
            className="add-public-profile-button"
            onClick={() => {
              setProfile(blankProfile);
              setEditingProfileId("new");
            }}
          >
            Add public profile
          </Button>
        </header>
      )}
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="discovery-notice">{message}</p> : null}
      {section === "website" ? (
        <nav aria-label="Website settings sections">
          {["brand", "homepage", "video", "discoveryCall", "sections"].map((item) => (
            <button
              type="button"
              className={tab === item ? "is-active" : ""}
              key={item}
              onClick={() => setTab(item)}
            >
              {item === "brand"
                ? "Branding"
                : item === "video"
                  ? "Homepage video"
                  : item === "discoveryCall"
                    ? "Discovery call"
                    : item === "sections"
                      ? "Visible sections"
                      : "Homepage"}
            </button>
          ))}
        </nav>
      ) : null}
      {tab === "brand" ? (
        <WorkspaceBrandingEditor
          config={config}
          setConfig={setConfig}
          onSave={saveConfig}
          saving={saving}
          setError={setError}
        />
      ) : null}
      {tab === "homepage" ? (
        <section className="website-content-editor">
          <div className="website-editor-group">
            <header>
              <span>00</span>
              <div>
                <h4>Google search listing</h4>
                <p>Controls only what Google shows in search results — separate from the Hero fields below, which control what visitors see on the page itself.</p>
              </div>
            </header>
            <label className="wide">
              Google search title
              <input
                value={config.publicSite.metaTitle || ""}
                placeholder={`${config.branding.publicSiteName || "Your business"} | Multifamily Real Estate Coaching`}
                maxLength={70}
                onChange={(e) => patchPublic("metaTitle", e.target.value)}
              />
              <small>Leave blank to keep the current default shown above.</small>
            </label>
            <label className="wide">
              Google search description
              <textarea
                value={config.publicSite.metaDescription || ""}
                placeholder="Practical coaching for investors ready to move from information to focused execution."
                maxLength={160}
                onChange={(e) => patchPublic("metaDescription", e.target.value)}
              />
              <small>Leave blank to keep using the Supporting statement below.</small>
            </label>
          </div>
          <div className="website-editor-group">
            <header>
              <span>01</span>
              <div>
                <h4>Hero</h4>
                <p>The first message visitors see.</p>
              </div>
            </header>
            <label className="website-toggle">
              <input
                type="checkbox"
                checked={config.publicSite.published}
                onChange={(e) => patchPublic("published", e.target.checked)}
              />
              <span>
                <strong>Website published</strong>
                <small>Make the public homepage visible.</small>
              </span>
            </label>
            <div className="public-admin__grid">
              <label>
                Eyebrow
                <input
                  value={config.publicSite.eyebrow || ""}
                  onChange={(e) => patchPublic("eyebrow", e.target.value)}
                />
              </label>
              <label>
                Logo overline
                <input
                  value={config.publicSite.heroOverline || ""}
                  onChange={(e) => patchPublic("heroOverline", e.target.value)}
                />
              </label>
              <label className="wide">
                Headline
                <input
                  value={config.publicSite.headline || ""}
                  onChange={(e) => patchPublic("headline", e.target.value)}
                />
              </label>
              <label className="wide">
                Supporting statement
                <textarea
                  value={config.publicSite.subheadline || ""}
                  onChange={(e) => patchPublic("subheadline", e.target.value)}
                />
              </label>
              <label className="wide">
                Logo supporting line
                <input
                  value={config.publicSite.heroTagline || ""}
                  onChange={(e) => patchPublic("heroTagline", e.target.value)}
                />
              </label>
              <label>
                Application button label
                <input
                  value={config.publicSite.primaryCtaLabel || ""}
                  onChange={(e) =>
                    patchPublic("primaryCtaLabel", e.target.value)
                  }
                />
              </label>
            </div>
            <div className="homepage-media-uploads homepage-media-uploads--inline">
              <article>
                <div className="homepage-media-preview">
                  {config.publicSite.heroMediaUrl ? (
                    <img
                      src={config.publicSite.heroMediaUrl}
                      alt="Current homepage hero"
                    />
                  ) : (
                    <span>Hero image</span>
                  )}
                </div>
                <div>
                  <h4>Homepage hero image</h4>
                  <p>
                    The large building or brand image beside the opening
                    headline.
                  </p>
                  <label className="website-upload-button">
                    {uploading === "heroMediaUrl"
                      ? "Uploading…"
                      : config.publicSite.heroMediaUrl
                        ? "Replace image"
                        : "Upload image"}
                    <input
                      disabled={Boolean(uploading)}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) =>
                        uploadSiteImage(
                          event.target.files?.[0],
                          "heroMediaUrl",
                          "Homepage hero image",
                        )
                      }
                    />
                  </label>
                  <label className="alt-text-field">
                    Alt text (for screen readers)
                    <input
                      value={config.publicSite.heroMediaAlt || ""}
                      onChange={(e) =>
                        patchPublic("heroMediaAlt", e.target.value)
                      }
                      placeholder="Describe what's in this image"
                    />
                  </label>
                </div>
              </article>
              <article>
                <div className="homepage-media-preview">
                  {config.publicSite.stickyBackgroundUrl ? (
                    <img
                      src={config.publicSite.stickyBackgroundUrl}
                      alt="Current sticky background"
                    />
                  ) : (
                    <span>Background</span>
                  )}
                </div>
                <div>
                  <h4>Sticky background image</h4>
                  <p>
                    Stays fixed in place behind the page as visitors scroll
                    through the site.
                  </p>
                  <label className="website-upload-button">
                    {uploading === "stickyBackgroundUrl"
                      ? "Uploading…"
                      : config.publicSite.stickyBackgroundUrl
                        ? "Replace image"
                        : "Upload image"}
                    <input
                      disabled={Boolean(uploading)}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) =>
                        uploadSiteImage(
                          event.target.files?.[0],
                          "stickyBackgroundUrl",
                          "Sticky background image",
                        )
                      }
                    />
                  </label>
                  {config.publicSite.stickyBackgroundUrl ? (
                    <button type="button" className="website-remove-media" onClick={() => { patchPublic("stickyBackgroundUrl", ""); patchPublic("stickyBackgroundAlt", ""); setMessage("Background removed from the preview. Save the homepage to publish this change."); }}>
                      Remove background
                    </button>
                  ) : null}
                  <label className="alt-text-field">
                    Alt text (for screen readers)
                    <input
                      value={config.publicSite.stickyBackgroundAlt || ""}
                      onChange={(e) =>
                        patchPublic("stickyBackgroundAlt", e.target.value)
                      }
                      placeholder="Describe what's in this image"
                    />
                  </label>
                </div>
              </article>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>02</span>
              <div>
                <h4>Introduction &amp; About</h4>
                <p>Keep the full story on the homepage.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Introduction title
                <input
                  value={config.publicSite.introTitle || ""}
                  onChange={(e) => patchPublic("introTitle", e.target.value)}
                />
              </label>
              <label>
                About eyebrow
                <input
                  value={config.publicSite.aboutEyebrow || ""}
                  onChange={(e) => patchPublic("aboutEyebrow", e.target.value)}
                />
              </label>
              <label className="wide">
                Introduction copy
                <textarea
                  value={config.publicSite.introBody || ""}
                  onChange={(e) => patchPublic("introBody", e.target.value)}
                />
              </label>
              <label className="wide">
                About title
                <input
                  value={config.publicSite.aboutTitle || ""}
                  onChange={(e) => patchPublic("aboutTitle", e.target.value)}
                />
              </label>
              <label className="wide">
                About {siteName}
                <textarea
                  value={config.publicSite.aboutBody || ""}
                  onChange={(e) => patchPublic("aboutBody", e.target.value)}
                />
              </label>
            </div>
            <div className="homepage-media-uploads homepage-media-uploads--inline">
              <article>
                <div className="homepage-media-preview homepage-media-preview--portrait">
                  {config.publicSite.aboutImageUrl ? (
                    <img
                      src={config.publicSite.aboutImageUrl}
                      alt={`Current About ${siteName} portrait`}
                    />
                  ) : (
                    <span>Portrait</span>
                  )}
                </div>
                <div>
                  <h4>About {siteName} photo</h4>
                  <p>
                    A vertical portrait works best in the homepage founder
                    section.
                  </p>
                  <label className="website-upload-button">
                    {uploading === "aboutImageUrl"
                      ? "Uploading…"
                      : config.publicSite.aboutImageUrl
                        ? "Replace photo"
                        : "Upload photo"}
                    <input
                      disabled={Boolean(uploading)}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) =>
                        uploadSiteImage(
                          event.target.files?.[0],
                          "aboutImageUrl",
                          "About Ellie photo",
                        )
                      }
                    />
                  </label>
                </div>
              </article>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>03</span>
              <div>
                <h4>Appearance &amp; typography</h4>
                <p>
                  Choose the public theme, visitor controls, fonts, and scale.
                </p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Website theme
                <select
                  value={
                    config.branding?.surfaceMode === "light" ? "light" : "dark"
                  }
                  onChange={(e) =>
                    setConfig((current) => ({
                      ...current,
                      branding: {
                        ...current.branding,
                        surfaceMode: e.target.value,
                      },
                    }))
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="website-toggle">
                <input
                  type="checkbox"
                  checked={config.publicSite.allowThemeToggle === true}
                  onChange={(e) =>
                    patchPublic("allowThemeToggle", e.target.checked)
                  }
                />
                <span>
                  <strong>Let visitors switch themes</strong>
                  <small>
                    Show a light/dark control in the public navigation.
                  </small>
                </span>
              </label>
              <label>
                Heading style
                <select
                  value={config.publicSite.headingFont || "editorial"}
                  onChange={(e) => patchPublic("headingFont", e.target.value)}
                >
                  <option value="editorial">Editorial (Playfair Display)</option>
                  <option value="classic">Classic serif (Instrument Serif)</option>
                  <option value="modern">Modern sans serif (DM Sans)</option>
                  <option value="friendly">Friendly sans serif (Poppins)</option>
                </select>
              </label>
              <label>
                Body style
                <select
                  value={config.publicSite.bodyFont || "modern"}
                  onChange={(e) => patchPublic("bodyFont", e.target.value)}
                >
                  <option value="modern">Modern sans serif (DM Sans)</option>
                  <option value="classic">Classic serif (Instrument Serif)</option>
                  <option value="friendly">Friendly sans serif (Poppins)</option>
                </select>
              </label>
              <label>
                Base font size: {config.publicSite.baseFontSize || 16}px
                <input
                  type="range"
                  min="14"
                  max="20"
                  value={config.publicSite.baseFontSize || 16}
                  onChange={(e) =>
                    patchPublic("baseFontSize", Number(e.target.value))
                  }
                />
              </label>
              <label>
                Heading scale:{" "}
                {Math.round((config.publicSite.headingScale || 1) * 100)}%
                <input
                  type="range"
                  min="0.8"
                  max="1.2"
                  step="0.05"
                  value={config.publicSite.headingScale || 1}
                  onChange={(e) =>
                    patchPublic("headingScale", Number(e.target.value))
                  }
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>04</span>
              <div>
                <h4>Contact, social &amp; footer</h4>
                <p>Public contact and profile links.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Contact email
                <input
                  value={config.publicSite.contactEmail || ""}
                  onChange={(e) => patchPublic("contactEmail", e.target.value)}
                />
              </label>
              <label>
                Contact phone
                <input
                  value={config.publicSite.contactPhone || ""}
                  onChange={(e) => patchPublic("contactPhone", e.target.value)}
                />
              </label>
              <label className="wide">
                Footer text
                <input
                  value={config.publicSite.footerText || ""}
                  onChange={(e) => patchPublic("footerText", e.target.value)}
                />
              </label>
              <div className="wide social-profile-editor">
                <div className="social-profile-editor__heading">
                  <div>
                    <strong>Social profiles</strong>
                    <small>Keep the platform and its public URL in separate fields.</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => patchPublic("socialLinks", [...(config.publicSite.socialLinks || []), { label: "", url: "" }])}
                  >
                    + Add profile
                  </button>
                </div>
                {(config.publicSite.socialLinks || []).length ? (
                  <div className="social-profile-editor__columns" aria-hidden="true">
                    <span>Platform</span>
                    <span>Profile URL</span>
                  </div>
                ) : null}
                <div className="social-profile-editor__rows">
                  {(config.publicSite.socialLinks || []).map((link, index) => (
                    <div className="social-profile-row" key={`${index}-${link.label}`}>
                      <input
                        aria-label={`Social platform ${index + 1}`}
                        value={link.label || ""}
                        placeholder="LinkedIn"
                        onChange={(event) => patchPublic("socialLinks", (config.publicSite.socialLinks || []).map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row))}
                      />
                      <input
                        aria-label={`Social profile URL ${index + 1}`}
                        type="url"
                        value={link.url || ""}
                        placeholder="https://linkedin.com/company/yourname"
                        onChange={(event) => patchPublic("socialLinks", (config.publicSite.socialLinks || []).map((row, rowIndex) => rowIndex === index ? { ...row, url: event.target.value } : row))}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${link.label || "social profile"}`}
                        onClick={() => patchPublic("socialLinks", (config.publicSite.socialLinks || []).filter((_, rowIndex) => rowIndex !== index))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <footer className="website-editor-save">
            <Button loading={saving} onClick={saveConfig}>
              Save homepage
            </Button>
          </footer>
        </section>
      ) : null}
      {tab === "video" ? (
        <section className="homepage-media-editor">
          <p className="public-admin__help">
            Upload your video, then scrub through it to choose the cover frame. Audio never autoplays.
          </p>
          <div className="homepage-media-uploads">
            <article>
              <div className="homepage-media-preview is-video">
                {config.publicSite.introVideoPosterUrl ? (
                  <img
                    src={config.publicSite.introVideoPosterUrl}
                    alt="Homepage video poster"
                  />
                ) : (
                  <span>Video</span>
                )}
              </div>
              <div>
                <h4>Homepage video</h4>
                <p>MP4, WEBM, or MOV up to 75 MB.</p>
                <label className="website-upload-button">
                  {uploading === "introVideoUrl"
                    ? "Uploading…"
                    : config.publicSite.introVideoUrl
                      ? "Replace video"
                      : "Upload video"}
                  <input
                    disabled={Boolean(uploading)}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      uploadHomepageVideo(file);
                    }}
                  />
                </label>
              </div>
            </article>
            {config.publicSite.introVideoUrl ? (
              <article className="homepage-cover-picker-card">
                <div>
                  <h4>Choose a cover frame</h4>
                  <p>
                    Scrub through the uploaded video and select the exact frame
                    visitors see before pressing play, or upload a separate cover photo instead.
                  </p>
                  <HomepageVideoCoverPicker
                    videoUrl={config.publicSite.introVideoUrl}
                    coverUrl={config.publicSite.introVideoPosterUrl}
                    onCapture={captureHomepageCover}
                  />
                  <label className="website-upload-button website-upload-button--secondary">
                    {uploading === "introVideoPosterUrl" ? "Uploading…" : "Or upload a cover photo directly"}
                    <input
                      disabled={Boolean(uploading)}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) captureHomepageCover(await fileData(file));
                      }}
                    />
                  </label>
                </div>
              </article>
            ) : null}
          </div>
          <div className="public-admin__grid">
            <label>
              Video eyebrow
              <input
                value={config.publicSite.introVideoEyebrow || ""}
                onChange={(e) =>
                  patchPublic("introVideoEyebrow", e.target.value)
                }
              />
            </label>
            <label className="wide">
              Video title
              <input
                value={config.publicSite.introVideoTitle || ""}
                onChange={(e) => patchPublic("introVideoTitle", e.target.value)}
              />
            </label>
            <label className="wide">
              Video supporting copy
              <textarea
                value={config.publicSite.introVideoCopy || ""}
                onChange={(e) => patchPublic("introVideoCopy", e.target.value)}
              />
            </label>
            <label className="wide">
              Alt text (for screen readers)
              <input
                value={config.publicSite.introVideoAlt || ""}
                onChange={(e) => patchPublic("introVideoAlt", e.target.value)}
                placeholder="Describe what this video shows"
              />
            </label>
          </div>
          <Button loading={saving} onClick={saveConfig}>
            Save video settings
          </Button>
        </section>
      ) : null}
      {tab === "discoveryCall" ? (
        <section className="homepage-media-editor">
          <p className="public-admin__help">
            Show a discovery-call button even when no video is uploaded. Choose a coach whose Google Calendar is
            connected in Lead Porch, set the public hours below, and visitors will only see times that are open on
            that calendar. Confirmed calls appear in Lead Porch and create a Google Calendar event with a Meet link.
            Ellie connects her own Google account once in My Coaching → My Schedule; no external booking link is needed.
          </p>
          <div className="public-admin__grid">
            <label className="website-toggle">
              <input
                type="checkbox"
                checked={config.publicSite.discoveryCallEnabled === true}
                onChange={(e) => patchPublic("discoveryCallEnabled", e.target.checked)}
              />
              <span>Show the "Book a Discovery Call" button on the homepage</span>
            </label>
          </div>
          <div className="homepage-media-uploads">
            <article>
              <div className="homepage-media-preview is-video">
                {config.publicSite.discoveryCallVideoPosterUrl ? (
                  <img
                    src={config.publicSite.discoveryCallVideoPosterUrl}
                    alt="Discovery call video poster"
                  />
                ) : (
                  <span>Video</span>
                )}
              </div>
              <div>
                <h4>Intro video (optional)</h4>
                <p>MP4, WEBM, or MOV up to 75 MB. Shown on the discovery call page above the booking link.</p>
                <label className="website-upload-button">
                  {uploading === "discoveryCallVideoUrl"
                    ? "Uploading…"
                    : config.publicSite.discoveryCallVideoUrl
                      ? "Replace video"
                      : "Upload video"}
                  <input
                    disabled={Boolean(uploading)}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      uploadDiscoveryCallVideo(file);
                    }}
                  />
                </label>
              </div>
            </article>
            {config.publicSite.discoveryCallVideoUrl ? (
              <article className="homepage-cover-picker-card">
                <div>
                  <h4>Choose a cover frame</h4>
                  <p>
                    Scrub through the uploaded video and select the exact frame
                    visitors see before pressing play, or upload a separate cover photo instead.
                  </p>
                  <HomepageVideoCoverPicker
                    videoUrl={config.publicSite.discoveryCallVideoUrl}
                    coverUrl={config.publicSite.discoveryCallVideoPosterUrl}
                    onCapture={captureDiscoveryCallCover}
                  />
                  <label className="website-upload-button website-upload-button--secondary">
                    {uploading === "discoveryCallVideoPosterUrl" ? "Uploading…" : "Or upload a cover photo directly"}
                    <input
                      disabled={Boolean(uploading)}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) captureDiscoveryCallCover(await fileData(file));
                      }}
                    />
                  </label>
                </div>
              </article>
            ) : null}
          </div>
          <div className="public-admin__grid">
            <label className="wide">
              Calendar owner
              <select value={config.publicSite.discoveryCallAvailability?.coachProfileId || ""} onChange={(e) => patchPublic("discoveryCallAvailability", { ...(config.publicSite.discoveryCallAvailability || {}), coachProfileId: e.target.value || null })}>
                <option value="">Choose a connected coach</option>
                {coaches.filter((coach) => coach.status === "active").map((coach) => <option key={coach._id} value={coach._id}>{coach.displayName || coach.userId?.name}</option>)}
              </select>
            </label>
            <label>
              Appointment length
              <select value={config.publicSite.discoveryCallAvailability?.durationMinutes || 30} onChange={(e) => patchPublic("discoveryCallAvailability", { ...(config.publicSite.discoveryCallAvailability || {}), durationMinutes: Number(e.target.value) })}><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option></select>
            </label>
            <label>
              Buffer between calls
              <select value={config.publicSite.discoveryCallAvailability?.bufferMinutes ?? 15} onChange={(e) => patchPublic("discoveryCallAvailability", { ...(config.publicSite.discoveryCallAvailability || {}), bufferMinutes: Number(e.target.value) })}><option value={0}>No buffer</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select>
            </label>
            <fieldset className="wide public-admin__weekday-fieldset">
              <legend>Weekly availability</legend>
              <div className="public-admin__weekly-hours">
                {bookingDays.map(([value, label]) => {
                  const selectedDays = config.publicSite.discoveryCallAvailability?.days || [1, 2, 3, 4, 5];
                  const savedRows = config.publicSite.discoveryCallAvailability?.weeklyHours || [];
                  const row = savedRows.find((item) => item.day === value) || { day: value, enabled: selectedDays.includes(value), startTime: config.publicSite.discoveryCallAvailability?.startTime || "09:00", endTime: config.publicSite.discoveryCallAvailability?.endTime || "17:00" };
                  const updateRow = (change) => patchPublic("discoveryCallAvailability", { ...(config.publicSite.discoveryCallAvailability || {}), weeklyHours: bookingDays.map(([day]) => { const existing = savedRows.find((item) => item.day === day) || { day, enabled: selectedDays.includes(day), startTime: config.publicSite.discoveryCallAvailability?.startTime || "09:00", endTime: config.publicSite.discoveryCallAvailability?.endTime || "17:00" }; return day === value ? { ...existing, ...change } : existing; }) });
                  return <div className="public-admin__weekly-row" key={value}><label className="website-toggle"><input type="checkbox" checked={row.enabled} onChange={(event) => updateRow({ enabled: event.target.checked })} /><span>{label}</span></label><label>Start<input type="time" disabled={!row.enabled} value={row.startTime} onChange={(event) => updateRow({ startTime: event.target.value })} /></label><label>End<input type="time" disabled={!row.enabled} value={row.endTime} onChange={(event) => updateRow({ endTime: event.target.value })} /></label></div>;
                })}
              </div>
              <p className="public-admin__help">For vacations or one-off unavailable times, Ellie adds an all-day or timed “Busy” event to the connected Google Calendar. Lead Porch automatically removes those times from public availability.</p>
            </fieldset>
            <label>
              Homepage button text
              <input
                value={config.publicSite.discoveryCallButtonLabel || ""}
                onChange={(e) => patchPublic("discoveryCallButtonLabel", e.target.value)}
                placeholder="Book a Discovery Call"
              />
            </label>
            <label className="wide">
              Page heading
              <input
                value={config.publicSite.discoveryCallHeading || ""}
                onChange={(e) => patchPublic("discoveryCallHeading", e.target.value)}
                placeholder="Book a Discovery Call"
              />
            </label>
            <label className="wide">
              Page copy
              <textarea
                value={config.publicSite.discoveryCallCopy || ""}
                onChange={(e) => patchPublic("discoveryCallCopy", e.target.value)}
                placeholder="Not sure where to start? Book a free discovery call and we'll help you find the right next step."
              />
            </label>
          </div>
          <Button loading={saving} onClick={saveConfig}>
            Save discovery call settings
          </Button>
        </section>
      ) : null}
      {tab === "sections" ? (
        <section className="website-content-editor">
          <div className="website-editor-group">
            <header><span>SEO</span><div><h4>Google pages</h4><p>These crawlable pages support Google without adding items to the one-page navigation.</p></div></header>
            <div className="public-admin__page-grid">
              {/* Every one of these pages already has a real footer link
                  (Contact, social & footer section) — the "Show link on
                  homepage" toggle used to also add a second, redundant pill-
                  button link in a separate homepage section, which was
                  removed per direct feedback. FAQ is the one exception: its
                  toggle drives an actual inline FAQ content section on the
                  homepage (public-homepage-faq), not just a link, so it
                  keeps its toggle. */}
              {[['About', '/about'], ['Programs', '/coaching-programs'], ['FAQ', '/faq'], ['Resources', '/resources'], ['Testimonials', '/testimonials'], ['Contact', '/contact'], ['Discovery call', '/book-a-call']].map(([label, path]) => <article key={path}><div><strong>{label}</strong><small>{path}</small></div><a className="website-upload-button website-upload-button--secondary" href={path} target="_blank" rel="noreferrer">View</a>{path === "/faq" ? <label className="website-toggle"><input type="checkbox" checked={(config.publicSite.homepageLinks || []).includes(path)} onChange={(event) => patchPublic("homepageLinks", event.target.checked ? [...new Set([...(config.publicSite.homepageLinks || []), path])] : (config.publicSite.homepageLinks || []).filter((item) => item !== path))} /><span>Show FAQ preview on homepage</span></label> : null}</article>)}
              {programs.filter((program) => program.publicPresentation?.slug).map((program) => { const path = `/coaching-programs/${program.publicPresentation.slug}`; return <article key={program._id}><div><strong>{program.publicPresentation?.title || program.name}</strong><small>{path}</small></div><a className="website-upload-button website-upload-button--secondary" href={path} target="_blank" rel="noreferrer">View</a></article>; })}
            </div>
            <Button loading={saving} onClick={saveConfig}>Save homepage links</Button>
          </div>
          <details className="website-editor-group public-admin__page-content" open>
            <summary><strong>Edit supporting-page content</strong><span>Headings and copy for every non-program Google page</span></summary>
            <div className="public-admin__grid">
              <label>About page heading<input value={config.publicSite.seoPages?.aboutHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), aboutHeading: e.target.value })} /></label>
              <label>Programs index heading<input value={config.publicSite.seoPages?.programsHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), programsHeading: e.target.value })} /></label>
              <label>FAQ page heading<input value={config.publicSite.seoPages?.faqHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), faqHeading: e.target.value })} /></label>
              <label>Resources page heading<input value={config.publicSite.seoPages?.resourcesHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), resourcesHeading: e.target.value })} /></label>
              <label className="wide">Resources introduction<textarea value={config.publicSite.seoPages?.resourcesCopy || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), resourcesCopy: e.target.value })} /></label>
              <label>Testimonials page heading<input value={config.publicSite.seoPages?.testimonialsHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), testimonialsHeading: e.target.value })} /></label>
              <label>Contact page heading<input value={config.publicSite.seoPages?.contactHeading || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), contactHeading: e.target.value })} /></label>
              <label className="wide">Contact page introduction<textarea value={config.publicSite.seoPages?.contactCopy || ""} onChange={(e) => patchPublic("seoPages", { ...(config.publicSite.seoPages || {}), contactCopy: e.target.value })} /></label>
            </div>
            <Button loading={saving} onClick={saveConfig}>Save supporting pages</Button>
          </details>
          <div className="website-editor-group">
            <header><span>FAQ</span><div><h4>Frequently asked questions</h4><p>Edit the questions published at /faq and included in Google FAQ structured data.</p></div></header>
            {(config.publicSite.faqItems?.length ? config.publicSite.faqItems : starterFaqs).map((row, index) => <div className="public-admin__grid value-editor" key={index}><label>Question<input value={row.question || ""} onChange={(event) => { const rows = [...(config.publicSite.faqItems?.length ? config.publicSite.faqItems : starterFaqs)]; rows[index] = { ...rows[index], question: event.target.value }; patchPublic("faqItems", rows); }} /></label><label className="wide">Answer<textarea value={row.answer || ""} onChange={(event) => { const rows = [...(config.publicSite.faqItems?.length ? config.publicSite.faqItems : starterFaqs)]; rows[index] = { ...rows[index], answer: event.target.value }; patchPublic("faqItems", rows); }} /></label><button type="button" className="website-upload-button website-upload-button--secondary" onClick={() => patchPublic("faqItems", (config.publicSite.faqItems?.length ? config.publicSite.faqItems : starterFaqs).filter((_, rowIndex) => rowIndex !== index))}>Remove question</button></div>)}
            <button type="button" className="website-upload-button" onClick={() => patchPublic("faqItems", [...(config.publicSite.faqItems?.length ? config.publicSite.faqItems : starterFaqs), { question: "", answer: "" }])}>Add question</button>
            <Button loading={saving} onClick={saveConfig}>Save FAQ and page settings</Button>
          </div>
          <div className="website-editor-group">
            <header>
              <span>00</span>
              <div>
                <h4>Optional site capabilities</h4>
                <p>Turn on only the content this workspace actually offers.</p>
              </div>
            </header>
            <div className="public-admin__checks">
              <label className="website-toggle">
                <input
                  type="checkbox"
                  checked={config.moduleAccess?.coaching === true}
                  onChange={(e) =>
                    patchModuleAccess("coaching", e.target.checked)
                  }
                />
                <span>Programs, coaches, and client journey</span>
              </label>
              <label className="website-toggle">
                <input
                  type="checkbox"
                  checked={config.moduleAccess?.publicProof === true}
                  onChange={(e) =>
                    patchModuleAccess("publicProof", e.target.checked)
                  }
                />
                <span>Testimonials, results, and proof</span>
              </label>
            </div>
            <Button loading={saving} onClick={saveConfig}>
              Save site capabilities
            </Button>
          </div>
          <div className="public-admin__checks">
            {Object.entries(visibilityLabels).map(([key, label]) => (
              <label className="website-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={config.publicSite.sectionVisibility?.[key] !== false}
                  onChange={(e) => patchVisibility(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="website-editor-group">
            <header>
              <span>01</span>
              <div>
                <h4>Why choose {siteName}</h4>
                <p>Edit the three value cards shown on the homepage.</p>
              </div>
            </header>
            {(config.publicSite.valuePropositions || []).map((row, index) => (
              <div className="public-admin__grid value-editor" key={index}>
                <label>
                  Card {index + 1} title
                  <input
                    value={row.title || ""}
                    onChange={(e) => patchValue(index, "title", e.target.value)}
                  />
                </label>
                <label className="wide">
                  Description
                  <textarea
                    value={row.body || ""}
                    onChange={(e) => patchValue(index, "body", e.target.value)}
                  />
                </label>
              </div>
            ))}
          </div>
          <div className="website-editor-group">
            <header>
              <span>02</span>
              <div>
                <h4>Programs section</h4>
                <p>Programs stay on the homepage.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Eyebrow
                <input
                  value={config.publicSite.programsEyebrow || ""}
                  onChange={(e) =>
                    patchPublic("programsEyebrow", e.target.value)
                  }
                />
              </label>
              <label className="wide">
                Headline
                <input
                  value={config.publicSite.programsTitle || ""}
                  onChange={(e) => patchPublic("programsTitle", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>03</span>
              <div>
                <h4>Student journey</h4>
                <p>Edit “Your path” and every step.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Eyebrow
                <input
                  value={config.publicSite.journeyEyebrow || ""}
                  onChange={(e) =>
                    patchPublic("journeyEyebrow", e.target.value)
                  }
                />
              </label>
              <label className="wide">
                Headline
                <input
                  value={config.publicSite.journeyTitle || ""}
                  onChange={(e) => patchPublic("journeyTitle", e.target.value)}
                />
              </label>
              <label className="wide">
                Supporting copy
                <textarea
                  value={config.publicSite.journeyCopy || ""}
                  onChange={(e) => patchPublic("journeyCopy", e.target.value)}
                />
              </label>
              <label className="wide">
                Journey steps — one per line
                <textarea
                  value={lines(config.publicSite.journeySteps)}
                  onChange={(e) =>
                    patchPublic("journeySteps", list(e.target.value))
                  }
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>04</span>
              <div>
                <h4>Upcoming event</h4>
                <p>
                  The date and registration URL come from Events; these fields
                  control homepage wording.
                </p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Eyebrow
                <input
                  value={config.publicSite.eventEyebrow || ""}
                  onChange={(e) => patchPublic("eventEyebrow", e.target.value)}
                />
              </label>
              <label>
                Button label
                <input
                  value={config.publicSite.eventCtaLabel || ""}
                  onChange={(e) => patchPublic("eventCtaLabel", e.target.value)}
                />
              </label>
              <label className="wide">
                Optional title override
                <input
                  value={config.publicSite.eventTitle || ""}
                  onChange={(e) => patchPublic("eventTitle", e.target.value)}
                />
              </label>
              <label className="wide">
                Optional description override
                <textarea
                  value={config.publicSite.eventSummary || ""}
                  onChange={(e) => patchPublic("eventSummary", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>05</span>
              <div>
                <h4>Community</h4>
                <p>Explain the post-enrollment community clearly.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Community title
                <input
                  value={config.publicSite.communityTitle || ""}
                  onChange={(e) =>
                    patchPublic("communityTitle", e.target.value)
                  }
                />
              </label>
              <label className="wide">
                Community explanation
                <textarea
                  value={config.publicSite.communityBody || ""}
                  onChange={(e) => patchPublic("communityBody", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>06</span>
              <div>
                <h4>Final application call to action</h4>
                <p>The application opens as a modal on the homepage.</p>
              </div>
            </header>
            <div className="public-admin__grid">
              <label>
                Eyebrow
                <input
                  value={config.publicSite.finalCtaEyebrow || ""}
                  onChange={(e) =>
                    patchPublic("finalCtaEyebrow", e.target.value)
                  }
                />
              </label>
              <label>
                Button label
                <input
                  value={config.publicSite.finalCtaLabel || ""}
                  onChange={(e) => patchPublic("finalCtaLabel", e.target.value)}
                />
              </label>
              <label className="wide">
                Headline
                <input
                  value={config.publicSite.finalCtaTitle || ""}
                  onChange={(e) => patchPublic("finalCtaTitle", e.target.value)}
                />
              </label>
              <label className="wide">
                Supporting copy
                <textarea
                  value={config.publicSite.finalCtaCopy || ""}
                  onChange={(e) => patchPublic("finalCtaCopy", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="website-editor-group">
            <header>
              <span>07</span>
              <div>
                <h4>Proof</h4>
                <p>Only publish approved, factual metrics.</p>
              </div>
            </header>
            <label>
              Trust metrics — one per line: Value|Label
              <textarea
                value={metricText(config.publicSite.trustMetrics)}
                onChange={(e) =>
                  patchPublic("trustMetrics", metrics(e.target.value))
                }
              />
            </label>
          </div>
          <footer className="website-editor-save">
            <Button loading={saving} onClick={saveConfig}>
              Save homepage sections
            </Button>
          </footer>
        </section>
      ) : null}
      {tab === "programs" ? (
        <section className="public-admin__rows">
          <p>
            Manage program delivery and pricing in Coaching. Choose how each
            program appears on your website here.
          </p>
          <Link to="/coaching/programs">Manage programs</Link>
          {programs.map((program) => (
            <article key={program._id} id={`program-page-${program._id}`}>
              <h3>{program.name}</h3>
              {program.publicPresentation?.slug ? <a className="website-upload-button website-upload-button--secondary" href={`/coaching-programs/${program.publicPresentation.slug}`} target="_blank" rel="noreferrer">View live page</a> : null}
              <div className="public-admin__grid">
                <label>
                  Public slug
                  <input
                    value={program.publicPresentation?.slug || ""}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  slug: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Publication
                  <select
                    value={program.publicPresentation?.status || "hidden"}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  status: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  >
                    <option value="hidden">Hidden</option>
                    <option value="published">Published</option>
                  </select>
                </label>
                <label>
                  Website section
                  <select
                    value={program.publicPresentation?.section || "intensive"}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  section: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  >
                    <option value="accelerator">
                      High Performance Accelerators
                    </option>
                    <option value="intensive">Intensive Programs</option>
                  </select>
                </label>
                <label>
                  Display order
                  <input
                    type="number"
                    min="0"
                    value={program.publicPresentation?.sortOrder || 0}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  sortOrder: Number(e.target.value),
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(program.publicPresentation?.featured)}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  featured: e.target.checked,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                  Mark as Most Popular
                </label>
                <label className="wide">
                  Public title
                  <input
                    value={program.publicPresentation?.title || ""}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  title: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="wide">
                  Summary
                  <textarea
                    value={program.publicPresentation?.summary || ""}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  summary: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="wide">
                  Full page description
                  <textarea
                    value={program.publicPresentation?.description || ""}
                    onChange={(e) => setPrograms((rows) => rows.map((row) => row._id === program._id ? { ...row, publicPresentation: { ...row.publicPresentation, description: e.target.value } } : row))}
                  />
                </label>
                <label>
                  Program image URL
                  <input value={program.publicPresentation?.imageUrl || ""} onChange={(e) => setPrograms((rows) => rows.map((row) => row._id === program._id ? { ...row, publicPresentation: { ...row.publicPresentation, imageUrl: e.target.value } } : row))} />
                </label>
                <label>
                  Program image description (alt text)
                  <input value={program.publicPresentation?.imageAlt || ""} onChange={(e) => setPrograms((rows) => rows.map((row) => row._id === program._id ? { ...row, publicPresentation: { ...row.publicPresentation, imageAlt: e.target.value } } : row))} />
                </label>
                <label className="wide">
                  Who it is for
                  <textarea
                    value={program.publicPresentation?.audience || ""}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  audience: e.target.value,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="wide">
                  Highlights — one per line
                  <textarea
                    value={lines(program.publicPresentation?.highlights)}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  highlights: list(e.target.value),
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(program.publicPresentation?.priceVisible)}
                    onChange={(e) =>
                      setPrograms((rows) =>
                        rows.map((row) =>
                          row._id === program._id
                            ? {
                                ...row,
                                publicPresentation: {
                                  ...row.publicPresentation,
                                  priceVisible: e.target.checked,
                                },
                              }
                            : row,
                        ),
                      )
                    }
                  />
                  Show configured price
                </label>
              </div>
              <Button onClick={() => saveProgram(program)}>
                Save program presentation
              </Button>
            </article>
          ))}
        </section>
      ) : null}
      {tab === "testimonials" ? (
        <section>
          <div className="public-admin__grid">
            <label>
              Name
              <input
                value={testimonial.displayName}
                onChange={(e) =>
                  setTestimonial({
                    ...testimonial,
                    displayName: e.target.value,
                  })
                }
              />
            </label>
            <label>
              Headline
              <input
                value={testimonial.headline}
                onChange={(e) =>
                  setTestimonial({ ...testimonial, headline: e.target.value })
                }
              />
            </label>
            <label className="wide">
              Testimonial
              <textarea
                value={testimonial.body}
                onChange={(e) =>
                  setTestimonial({ ...testimonial, body: e.target.value })
                }
              />
            </label>
            <label>
              Video URL
              <input
                value={testimonial.videoUrl}
                onChange={(e) =>
                  setTestimonial({ ...testimonial, videoUrl: e.target.value })
                }
              />
            </label>
            <Button
              disabled={!testimonial.displayName || !testimonial.body}
              onClick={addTestimonial}
            >
              Create pending testimonial
            </Button>
          </div>
          <div className="public-admin__rows">
            {testimonials.map((row) => (
              <article key={row._id}>
                <strong>{row.displayName}</strong>
                <em>
                  {row.status}
                  {row.featured ? " · featured" : ""}
                </em>
                <p>{row.body}</p>
                <div>
                  <Button size="sm" onClick={() => decide(row, "approved")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide(row, "rejected")}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={row.status !== "approved"}
                    onClick={() =>
                      decide(row, "approved", { featured: !row.featured })
                    }
                  >
                    {row.featured ? "Unfeature" : "Feature"}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {tab === "team" ? (
        <section className="public-profile-manager">
          {editingProfileId === "new" ? (
            <div className="public-profile-editor">
              <h4>Add a public profile</h4>
              <div className="public-admin__grid">
                <label>
                  Profile type
                  <select
                    value={profile.ownerType}
                    onChange={(e) =>
                      setProfile({ ...profile, ownerType: e.target.value })
                    }
                  >
                    <option value="coach">Coach</option>
                    <option value="team">Team member</option>
                    <option value="student">Student</option>
                  </select>
                </label>
                {profile.ownerType === "coach" ? (
                  <label>
                    Coach
                    <select
                      value={profile.coachProfileId}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          coachProfileId: e.target.value,
                        })
                      }
                    >
                      <option value="">Select coach</option>
                      {coaches.map((row) => (
                        <option key={row._id} value={row._id}>
                          {row.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : profile.ownerType === "team" ? (
                  <label>
                    Workspace team member
                    <select
                      value={profile.userId}
                      onChange={(e) => {
                        const member = members.find(
                          (row) => String(row.userId) === e.target.value,
                        );
                        const displayName =
                          member?.name ||
                          [member?.firstName, member?.lastName]
                            .filter(Boolean)
                            .join(" ");
                        setProfile({
                          ...profile,
                          userId: e.target.value,
                          displayName: profile.displayName || displayName || "",
                          slug:
                            profile.slug ||
                            String(displayName || "")
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, "-")
                              .replace(/^-|-$/g, ""),
                        });
                      }}
                    >
                      <option value="">Select team member</option>
                      {members.map((row) => (
                        <option key={row.userId} value={row.userId}>
                          {row.name || row.email}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Student Contact
                    <select
                      value={profile.contactId}
                      onChange={(e) =>
                        setProfile({ ...profile, contactId: e.target.value })
                      }
                    >
                      <option value="">Select Contact</option>
                      {contacts.map((row) => (
                        <option key={row._id} value={row._id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Public URL slug
                  <input
                    value={profile.slug}
                    onChange={(e) =>
                      setProfile({ ...profile, slug: e.target.value })
                    }
                  />
                </label>
                <label>
                  Public name
                  <input
                    value={profile.displayName}
                    onChange={(e) =>
                      setProfile({ ...profile, displayName: e.target.value })
                    }
                  />
                </label>
                <label>
                  Public role or title
                  <input
                    value={profile.publicTitle}
                    placeholder="Chief Technology Operator"
                    onChange={(e) =>
                      setProfile({ ...profile, publicTitle: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="public-profile-actions">
                <Button
                  disabled={
                    !profile.slug ||
                    (profile.ownerType === "coach" &&
                      !profile.coachProfileId) ||
                    (profile.ownerType === "team" && !profile.userId) ||
                    (profile.ownerType === "student" && !profile.contactId)
                  }
                  onClick={async () => {
                    await addProfile();
                    setEditingProfileId("");
                  }}
                >
                  Add profile
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEditingProfileId("")}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <div className="public-profile-list">
            {profiles.map((row) => (
              <article key={row._id}>
                <div className="public-profile-summary">
                  {row.avatarUrl ? (
                    <img src={row.avatarUrl} alt="" />
                  ) : (
                    <span>{row.displayName?.slice(0, 1) || "?"}</span>
                  )}
                  <div>
                    <strong>{row.displayName}</strong>
                    <small>{row.publicTitle || row.ownerType}</small>
                  </div>
                  <em className={row.status === "published" ? "is-live" : ""}>
                    {row.status === "published" ? "Published" : "Draft"}
                  </em>
                  <div className="public-profile-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditingProfileId(
                          editingProfileId === row._id ? "" : row._id,
                        )
                      }
                    >
                      {editingProfileId === row._id
                        ? "Close"
                        : "Edit public profile"}
                    </Button>
                    {row.status === "published" ? (
                      <a href={`/#team`} target="_blank" rel="noreferrer">
                        View on website ↗
                      </a>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          patchProfile(row._id, "status", "published");
                          setEditingProfileId(row._id);
                        }}
                      >
                        Publish
                      </Button>
                    )}
                  </div>
                </div>
                {editingProfileId === row._id ? (
                  <div className="public-profile-editor">
                    <div className="public-admin__grid">
                      <label>
                        <input
                          type="checkbox"
                          checked={row.status === "published"}
                          onChange={(e) =>
                            patchProfile(
                              row._id,
                              "status",
                              e.target.checked ? "published" : "draft",
                            )
                          }
                        />{" "}
                        Show on website
                      </label>
                      <label>
                        Public name
                        <input
                          value={row.displayName || ""}
                          onChange={(e) =>
                            patchProfile(row._id, "displayName", e.target.value)
                          }
                        />
                      </label>
                      <label>
                        Title
                        <input
                          value={row.publicTitle || ""}
                          onChange={(e) =>
                            patchProfile(row._id, "publicTitle", e.target.value)
                          }
                        />
                      </label>
                      <div className="public-profile-photo-field">
                        <strong>Profile photo</strong>
                        <span className="public-profile-photo-control">
                          {row.avatarUrl ? (
                            <img src={row.avatarUrl} alt="" />
                          ) : (
                            <i>{row.displayName?.slice(0, 1) || "?"}</i>
                          )}
                          <span>
                            <label className="website-upload-button">
                              {uploading === `profile-${row._id}`
                                ? "Uploading…"
                                : row.avatarUrl
                                  ? "Replace photo"
                                  : "Upload photo"}
                              <input
                                disabled={Boolean(uploading)}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={(event) =>
                                  uploadProfilePhoto(
                                    row._id,
                                    event.target.files?.[0],
                                  )
                                }
                              />
                            </label>
                            {row.avatarUrl ? (
                              <button
                                type="button"
                                className="brand-remove"
                                onClick={() =>
                                  patchProfile(row._id, "avatarUrl", "")
                                }
                              >
                                Remove
                              </button>
                            ) : null}
                          </span>
                        </span>
                      </div>
                      <label>
                        Display order
                        <input
                          type="number"
                          value={row.sortOrder || 0}
                          onChange={(e) =>
                            patchProfile(
                              row._id,
                              "sortOrder",
                              Number(e.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Public slug
                        <input
                          value={row.slug || ""}
                          onChange={(e) =>
                            patchProfile(row._id, "slug", e.target.value)
                          }
                        />
                      </label>
                      <label className="wide">
                        Bio
                        <textarea
                          value={row.bio || ""}
                          onChange={(e) =>
                            patchProfile(row._id, "bio", e.target.value)
                          }
                        />
                      </label>
                      <label className="wide">
                        Specialties — one per line
                        <textarea
                          value={lines(row.specialties)}
                          onChange={(e) =>
                            patchProfile(
                              row._id,
                              "specialties",
                              list(e.target.value),
                            )
                          }
                        />
                      </label>
                    </div>
                    <div className="public-profile-actions">
                      <Button size="sm" onClick={() => saveProfile(row)}>
                        Save public profile
                      </Button>
                      {row.ownerType === "student" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => token(row)}
                        >
                          Create private edit link
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
