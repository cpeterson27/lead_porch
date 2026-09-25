import { useState } from "react";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { PublicLayout } from "./PublicSite.jsx";
import { optInLeadMagnet } from "../services/api.js";

// Placeholder title/description/CTA — there's no real guide/PDF to describe
// yet. Swap these three strings for the real thing once you know what it
// is; the capture-to-delivery pipeline behind this page is fully real.
const TITLE = "Get our free guide";
const DESCRIPTION = "Enter your email below and we'll send it straight to your inbox.";

export default function LeadMagnet() {
  const { site } = useWorkspaceTheme();
  const workspaceName = site?.branding?.publicSiteName || site?.workspace?.name || "us";
  const [form, setForm] = useState({ firstName: "", email: "" });
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setStatus("submitting");
    setError("");
    try {
      await optInLeadMagnet(form);
      setStatus("done");
    } catch (err) {
      setError(err.response?.data?.error || "Something went wrong. Please try again.");
      setStatus("idle");
    }
  };

  return (
    <PublicLayout>
      <main id="main-content" className="public-inner">
        <p className="public-kicker">Free resource from {workspaceName}</p>
        <h1>{TITLE}</h1>
        <p>{DESCRIPTION}</p>
        {status === "done" ? (
          <p>Check your email — it's on its way.</p>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: "12px", maxWidth: "420px", marginTop: "24px" }}>
            <label>
              First name
              <input required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
            </label>
            <label>
              Email
              <input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Sending…" : "Send it to me"}</button>
          </form>
        )}
      </main>
    </PublicLayout>
  );
}
