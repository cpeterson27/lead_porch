import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "../services/api.js";
import "./Login.css";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      navigate("/login", { replace: true, state: { passwordReset: true } });
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Unable to reset your password.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <main className="login-page">
        <section className="login-panel">
          <p className="login-eyebrow">Lead Porch</p>
          <h1>Invalid link</h1>
          <p className="login-intro">This password reset link is missing its token. Request a new one from the sign-in page.</p>
          <Link to="/login">Back to sign in</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <p className="login-eyebrow">Lead Porch</p>
        <h1>Choose a new password</h1>
        <p className="login-intro">This link works once and expires an hour after it was sent.</p>
        <form onSubmit={submit}>
          <label>
            New password
            <input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
          </label>
          <label>
            Confirm new password
            <input type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
          </label>
          <small>Use at least 12 characters.</small>
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save new password"}</button>
        </form>
      </section>
    </main>
  );
}
