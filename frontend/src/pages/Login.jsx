import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import useAuth from "../context/useAuth.js";
import api from "../services/api.js";
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
      await verifyTwoFactor(twoFactor.challengeId, code);
      navigate(location.state?.from || "/dashboard", { replace: true });
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Unable to verify that code.");
    } finally {
      setSubmitting(false);
    }
  };

  const brandName = branding?.workspaceName || "Lead Porch";
  const brandColor = branding?.primaryColor || "";

  if (twoFactor) {
    return (
      <main className="login-page" style={brandColor ? { "--login-accent": brandColor } : undefined}>
        <section className="login-panel">
          {branding?.logoUrl ? (
            <img className="login-brand login-brand--logo" src={branding.logoUrl} alt={`${brandName} logo`} />
          ) : (
            <a className="login-brand" href="/" aria-label={`${brandName} home`}>{brandName[0]}</a>
          )}
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
            {error ? (
              <p className="login-error" role="alert">{error}</p>
            ) : null}
            <button type="submit" disabled={submitting || code.length !== 6}>
              {submitting ? "Verifying…" : "Verify and sign in"}
            </button>
          </form>
          <small>
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
        {branding?.logoUrl ? (
          <img className="login-brand login-brand--logo" src={branding.logoUrl} alt={`${brandName} logo`} />
        ) : (
          <a className="login-brand" href="/" aria-label={`${brandName} home`}>{brandName[0]}</a>
        )}
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
        <small>
          New customers start from the Lead Porch website. Team members join an
          existing workspace by invitation.
        </small>
      </section>
    </main>
  );
}
