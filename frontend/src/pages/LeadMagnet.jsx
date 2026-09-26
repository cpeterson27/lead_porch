import { getSiteAttribution } from "../utils/siteAttribution.js";
import { useState } from "react";
import { FiArrowRight, FiBookOpen, FiCheck, FiMail } from "react-icons/fi";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { PublicLayout } from "./PublicSite.jsx";
import { optInLeadMagnet } from "../services/api.js";
import "./LeadMagnet.css";

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
      await optInLeadMagnet({ ...form, siteAttribution: getSiteAttribution() });
      setStatus("done");
    } catch (err) {
      setError(err.response?.data?.error || "Something went wrong. Please try again.");
      setStatus("idle");
    }
  };

  return (
    <PublicLayout>
      <main id="main-content" className="lead-magnet-page">
        <section className="lead-magnet-shell">
          <div className="lead-magnet-copy">
            <p className="public-kicker">A free resource from {workspaceName}</p>
            <h1>Get the free guide.</h1>
            <p className="lead-magnet-intro">A practical resource designed to help you turn what you know into a clear next step—without adding more noise to your inbox.</p>
            <ul className="lead-magnet-benefits" aria-label="What is included">
              <li><FiCheck aria-hidden="true" /><span>Focused guidance you can put into action</span></li>
              <li><FiCheck aria-hidden="true" /><span>A simple framework to organize your next steps</span></li>
              <li><FiCheck aria-hidden="true" /><span>Delivered directly to your email</span></li>
            </ul>
            <div className="lead-magnet-note"><FiBookOpen aria-hidden="true" /><span>Free to download. Read it at your own pace.</span></div>
          </div>
          <div className="lead-magnet-card">
            {status === "done" ? (
              <div className="lead-magnet-success" role="status">
                <span><FiMail aria-hidden="true" /></span>
                <p className="public-kicker">Check your inbox</p>
                <h2>Your guide is on its way.</h2>
                <p>We sent it to <strong>{form.email}</strong>. If it is not there in a few minutes, check your spam or promotions folder.</p>
              </div>
            ) : (
              <>
                <p className="public-kicker">Send me the guide</p>
                <h2>Where should we send it?</h2>
                <p className="lead-magnet-card__intro">Enter your details below and we’ll email you the resource.</p>
                <form className="lead-magnet-form" onSubmit={submit}>
                  <label>First name<input required autoComplete="given-name" value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} placeholder="Your first name" /></label>
                  <label>Email address<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
                  {error ? <p className="form-error" role="alert">{error}</p> : null}
                  <button type="submit" disabled={status === "submitting"}><span>{status === "submitting" ? "Sending…" : "Email me the guide"}</span><FiArrowRight aria-hidden="true" /></button>
                  <small>By submitting, you agree to receive this resource and related emails. You can unsubscribe at any time.</small>
                </form>
              </>
            )}
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}
