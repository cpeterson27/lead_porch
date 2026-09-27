import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import useAuth from "../context/useAuth.js";
import api from "../services/api.js";
import { requestPasswordReset, resendTwoFactorCode } from "../services/api.js";
import "./Login.css";

export default function Login() {
  const { login, verifyTwoFactor, session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [workspaceOptions, setWorkspaceOptions] = useState([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [branding, setBranding] = useState(null);
  // Set once the password step comes back asking for a text code — from
  // then on the form shows the code field instead of email/password.
  const [twoFactor, setTwoFactor] = useState(null);
  const [code, setCode] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [resendState, setResendState] = useState("idle"); // idle | sending | sent
  // "forgot" swaps the whole panel to an email-only reset request form.
  const [forgot, setForgot] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    // Same domain the public site already brands itself from — this just
    // reads it for the login page too. Silently falls back to the default
    // Lead Porch look on leadporch.co itself or any unmatched host.
    api.get("/auth/login-branding").then(({ data }) => { if (data?.branded) setBranding(data); }).catch(() => {});
  }, []);

  if (session)
    return <Navigate to={location.state?.from || "/dashboard"} replace />;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await login(email, password, workspaceId);
      if (result?.requiresTwoFactor) {
        setTwoFactor(result);
        return;
      }
      navigate(location.state?.from || "/dashboard", { replace: true });
    } catch (requestError) {
      if (
        requestError.response?.data?.code === "WORKSPACE_SELECTION_REQUIRED"
      ) {
        const options = requestError.response.data.workspaces || [];
        setWorkspaceOptions(options);
        setWorkspaceId(options[0]?.id || "");
        setError("Choose the workspace you want to open, then sign in again.");
        return;
      }
      setError(requestError.response?.data?.error || "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await verifyTwoFactor(twoFactor.challengeId, code, rememberDevice);
      navigate(location.state?.from || "/dashboard", { replace: true });
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Unable to verify that code.");
    } finally {
      setSubmitting(false);
    }
  };

  const resendCode = async () => {
    if (resendState === "sending") return;
    setError("");
    setResendState("sending");
    try {
      await resendTwoFactorCode(twoFactor.challengeId);
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 15000);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Unable to resend that code.");
      setResendState("idle");
    }
  };

  const submitForgot = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await requestPasswordReset(resetEmail);
      setResetSent(true);
    } catch {
      // The endpoint always answers the same way either way, so this only
      // fires for a real network problem — never "that email doesn't exist."
      setResetSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  const brandName = branding?.workspaceName || "Lead Porch";
  const brandColor = branding?.primaryColor || "";
  const brandMark = branding?.logoUrl ? (
    <img className="login-brand login-brand--logo" src={branding.logoUrl} alt={`${brandName} logo`} />
  ) : (
    <a className="login-brand" href="/" aria-label={`${brandName} home`}>{brandName[0]}</a>
  );

  if (forgot) {
    return (
      <main className="login-page" style={brandColor ? { "--login-accent": brandColor } : undefined}>
        <section className="login-panel">
          {brandMark}
          <p className="login-eyebrow">{brandName}</p>
          <h1>Reset your password</h1>
          {resetSent ? (
            <>
              <p className="login-intro">
                If an account exists for {resetEmail}, we've sent a link to reset the password. It works once and expires in an hour.
              </p>
              <button type="button" className="login-link-button" onClick={() => { setForgot(false); setResetSent(false); setResetEmail(""); }}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <p className="login-intro">Enter your email and we'll send you a link to reset it.</p>
              <form onSubmit={submitForgot}>
                <label>
                  Email address
                  <input type="email" autoComplete="email" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} required autoFocus />
                </label>
                <button type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send reset link"}</button>
              </form>
              <small>
                <button type="button" className="login-link-button" onClick={() => { setForgot(false); setError(""); }}>
                  Back to sign in
                </button>
              </small>
            </>
          )}
        </section>
      </main>
    );
  }

  if (twoFactor) {
    return (
      <main className="login-page" style={brandColor ? { "--login-accent": brandColor } : undefined}>
        <section className="login-panel">
          {brandMark}
          <p className="login-eyebrow">{brandName}</p>
          <h1>Enter your code</h1>
          <p className="login-intro">
            We texted a 6-digit code to the number ending in {twoFactor.phoneLastFour}.
          </p>
          <form onSubmit={submitCode}>
            <label>
              Verification code
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                required
                autoFocus
              />
            </label>
            <label className="login-checkbox-row">
              <input type="checkbox" checked={rememberDevice} onChange={(event) => setRememberDevice(event.target.checked)} />
              Remember this device for 30 days
            </label>
            {error ? (
              <p className="login-error" role="alert">{error}</p>
            ) : null}
            <button type="submit" disabled={submitting || code.length !== 6}>
              {submitting ? "Verifying…" : "Verify and sign in"}
            </button>
          </form>
          <small className="login-footer-row">
            <button type="button" className="login-link-button" onClick={resendCode} disabled={resendState === "sending"}>
              {resendState === "sent" ? "Code resent" : resendState === "sending" ? "Sending…" : "Resend code"}
            </button>
            <button type="button" className="login-link-button" onClick={() => { setTwoFactor(null); setCode(""); setError(""); }}>
              Back to sign in
            </button>
          </small>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page" style={brandColor ? { "--login-accent": brandColor } : undefined}>
      <section className="login-panel">
        {brandMark}
        <p className="login-eyebrow">{brandName}</p>
        <h1>Welcome back</h1>
        <p className="login-intro">Sign in to your private growth workspace.</p>
        <form onSubmit={submit}>
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {workspaceOptions.length > 1 ? (
            <label>
              Workspace
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                required
              >
                {workspaceOptions.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <small className="login-footer-row">
          <button type="button" className="login-link-button" onClick={() => { setForgot(true); setError(""); }}>
            Forgot password?
          </button>
        </small>
      </section>
    </main>
  );
}
