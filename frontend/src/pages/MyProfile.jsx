import { useEffect, useState } from "react";
import Button from "../components/Button.jsx";
import UserAvatar from "../components/UserAvatar.jsx";
import useAuth from "../context/useAuth.js";
import { fetchMyProfile, saveMyProfile, removeMyAvatar, uploadMyAvatar, startTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor } from "../services/api.js";
import "./MyProfile.css";

function TwoFactorSection({ profile, onChanged }) {
  const [step, setStep] = useState("idle"); // idle | awaiting-code | disabling
  const [phone, setPhone] = useState(profile.phone || "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enabled = Boolean(profile.twoFactor?.enabled);
  // Plain divs, not <form> — this renders inside the page's own outer
  // <form> (the profile-details save form), and browsers don't allow
  // nested forms. Enter-to-submit is wired by hand instead.
  const sendCode = async () => {
    if (!phone || busy) return;
    setBusy(true); setError("");
    try { await startTwoFactorSetup(phone); setStep("awaiting-code"); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to send a code."); }
    finally { setBusy(false); }
  };
  const confirmCode = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true); setError("");
    try { await confirmTwoFactorSetup(code); setStep("idle"); setCode(""); onChanged(); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to verify that code."); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!password || busy) return;
    setBusy(true); setError("");
    try { await disableTwoFactor(password); setStep("idle"); setPassword(""); onChanged(); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to turn this off."); }
    finally { setBusy(false); }
  };
  const onEnter = (handler) => (event) => { if (event.key === "Enter") { event.preventDefault(); handler(); } };
  return <>
    <h3>Two-factor sign-in (text message)</h3>
    <p>{enabled ? "Turned on — a text code is required every time you sign in." : "Turned off."}</p>
    {error ? <p className="form-error">{error}</p> : null}
    {enabled ? (
      step === "disabling" ? (
        <div className="two-factor-inline">
          <label>Confirm your password to turn this off<input type="password" required value={password} onKeyDown={onEnter(disable)} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="two-factor-actions"><Button type="button" variant="danger" disabled={busy || !password} onClick={disable}>{busy ? "Turning off…" : "Turn off"}</Button><Button type="button" variant="outline" onClick={() => { setStep("idle"); setError(""); }}>Cancel</Button></div>
        </div>
      ) : <Button type="button" variant="outline" onClick={() => setStep("disabling")}>Turn off</Button>
    ) : step === "awaiting-code" ? (
      <div className="two-factor-inline">
        <label>Enter the code we texted you<input type="text" inputMode="numeric" maxLength={6} required value={code} onKeyDown={onEnter(confirmCode)} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
        <div className="two-factor-actions"><Button type="button" disabled={busy || code.length !== 6} onClick={confirmCode}>{busy ? "Verifying…" : "Confirm"}</Button><Button type="button" variant="outline" onClick={() => { setStep("idle"); setError(""); }}>Cancel</Button></div>
      </div>
    ) : (
      <div className="two-factor-inline">
        <label>Phone number<input type="tel" required value={phone} onKeyDown={onEnter(sendCode)} onChange={(event) => setPhone(event.target.value)} placeholder="+1 555 555 5555" /></label>
        <Button type="button" disabled={busy || !phone} onClick={sendCode}>{busy ? "Sending…" : "Turn on"}</Button>
      </div>
    )}
  </>;
}

const groups = [
  ["Personal information", [["firstName", "First name"], ["lastName", "Last name"], ["name", "Display name"], ["location", "Location"], ["timezone", "Timezone"]]],
  ["Professional information", [["jobTitle", "Job title"], ["company", "Company / organization"], ["bio", "About you", "textarea"]]],
  ["Contact & online presence", [["phone", "Phone", "tel"], ["website", "Website", "url"], ["linkedin", "LinkedIn URL", "url"], ["facebook", "Facebook URL", "url"], ["instagram", "Instagram URL", "url"], ["x", "X / Twitter URL", "url"]]],
];
const networks = ["linkedin", "facebook", "instagram", "x"];
const editable = (profile) => ({ ...Object.fromEntries(groups.flatMap(([, fields]) => fields).filter(([key]) => !networks.includes(key)).map(([key]) => [key, profile[key] || ""])), socialProfiles: { ...profile.socialProfiles } });
export default function MyProfile() {
  const { session, updateSessionUser } = useAuth();
  const [profile, setProfile] = useState(null), [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
  const [photo, setPhoto] = useState(null), [removePhoto, setRemovePhoto] = useState(false);
  const reload = () => fetchMyProfile().then(({ user }) => setProfile(user)).catch(() => {});
  useEffect(() => {
    let active = true;
    fetchMyProfile().then(({ user }) => { if (active) setProfile(user); }).catch(() => { if (active) setNotice({ error: true, text: "Unable to load your profile. Please reload to try again." }); });
    return () => { active = false; };
  }, []);
  const begin = () => { setDraft(editable(profile)); setEditing(true); setNotice(null); };
  const cancel = () => { setEditing(false); setDraft(null); setPhoto(null); setRemovePhoto(false); setNotice(null); };
  const choosePhoto = async (file) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024) return setNotice({ error: true, text: "Choose a JPG, PNG, WEBP, or GIF image, 5 MB or smaller." });
    try {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      setPhoto(dataUrl); setRemovePhoto(false); setNotice(null);
    } catch { setNotice({ error: true, text: "Unable to read that image." }); }
  };
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    let saved = false;
    try {
      const result = await saveMyProfile(draft);
      setProfile(result.user); updateSessionUser(result.user); saved = true;
      if (photo || removePhoto) {
        const avatar = photo ? await uploadMyAvatar(photo) : await removeMyAvatar();
        setProfile({ ...result.user, avatarUrl: avatar.user.avatarUrl }); updateSessionUser(avatar.user);
      }
      cancel(); setNotice({ text: "Your profile has been saved." });
    } catch (error) { setNotice({ error: true, text: (saved ? "Profile details saved, but the photo was not updated. Try saving again. " : "") + (error.response?.data?.error || "Unable to save your profile.") }); }
    finally { setBusy(false); }
  };
  const value = (key) => networks.includes(key) ? (editing ? draft : profile)?.socialProfiles?.[key] || "" : (editing ? draft : profile)?.[key] || "";
  const change = (key, text) => setDraft((current) => networks.includes(key) ? { ...current, socialProfiles: { ...current.socialProfiles, [key]: text } } : { ...current, [key]: text });
  const roles = (session?.roles || [session?.role]).filter(Boolean);
  return <main className="my-profile-page">
    <header className="profile-page-heading"><p className="page-eyebrow">YOUR GROWTH OPERATOR ACCOUNT</p><h1>My Profile</h1><p>One profile. Every role. Show the person behind the work.</p></header>
    {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "form-error" : "profile-success"}>{notice.text}</p>}
    {!profile ? !notice?.error && <p role="status">Loading your profile…</p> : <form onSubmit={save}>
      <section className="profile-hero" aria-label="Profile overview">
        <div className="profile-photo"><UserAvatar user={{ ...profile, avatarUrl: removePhoto ? "" : photo || profile.avatarUrl }} size="lg" />
          {editing && <div className="profile-photo-controls"><label className="my-profile-upload">Choose photo<input disabled={busy} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => choosePhoto(event.target.files?.[0])}/></label>{(profile.avatarUrl || photo) && <Button type="button" variant="outline" disabled={busy} onClick={() => { setPhoto(null); setRemovePhoto(true); }}>Remove photo</Button>}<small>Up to 5 MB. Changes apply when you save.</small></div>}
        </div>
        <div className="profile-intro"><span className="profile-label">YOUR PROFILE</span><h2>{profile.name}</h2><p>{[profile.jobTitle, profile.company].filter(Boolean).join(" · ") || "Add a little about what you do."}</p><div className="profile-badges"><span>{session?.workspace?.name}</span>{roles.map((role) => <span key={role}>{role.replaceAll("_", " ")}</span>)}</div></div>
        {!editing && <Button type="button" onClick={begin}>Edit Profile</Button>}
      </section>
      <div className="profile-columns"><div className="profile-details">{groups.map(([title, fields]) => <section className="profile-card" key={title}><h2>{title}</h2><div className="profile-field-grid">{fields.map(([key, label, type = "text"]) => <div className={key === "bio" ? "profile-field wide" : "profile-field"} key={key}>{editing ? <label>{label}{type === "textarea" ? <textarea disabled={busy} value={value(key)} maxLength={3000} rows={5} onChange={(event) => change(key, event.target.value)} /> : <input disabled={busy} type={type} value={value(key)} required={key === "name"} placeholder={key === "timezone" ? "America/Los_Angeles" : undefined} maxLength={type === "url" ? 2000 : key === "name" ? 120 : undefined} onChange={(event) => change(key, event.target.value)} />}</label> : <><h3>{label}</h3><p>{value(key) || <span className="profile-empty">Not added yet</span>}</p></>}</div>)}</div></section>)}</div>
        <aside className="profile-card profile-account"><h2>Account information</h2><h3>Sign-in email</h3><p>{profile.email}</p><small>Your sign-in identity is protected and cannot be changed here.</small><h3>Workspace</h3><p>{session?.workspace?.name}</p><h3>Workspace access</h3><p>{roles.join(", ")}</p><small>Permissions are managed by your workspace administrator. Editing a job title does not change access.</small>{profile.createdAt && <><h3>Account created</h3><p>{new Date(profile.createdAt).toLocaleDateString()}</p></>}<hr/><TwoFactorSection profile={profile} onChanged={reload} /><hr/><p>Your photo and professional details are shared across your Lead Porch roles, including your Ambassador experience.</p></aside>
      </div>
      {editing && <footer className="profile-save-bar"><span>Changes are not saved until you choose Save.</span><Button type="button" variant="outline" disabled={busy} onClick={cancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</Button></footer>}
    </form>}
  </main>;
}
