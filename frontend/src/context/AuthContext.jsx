import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../services/api";
import AuthContext from "./AuthContextValue.js";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadWorkspaces = useCallback(() => api.get("/auth/workspaces").then(({ data }) => { setWorkspaces(data.workspaces || []); return data.workspaces || []; }), []);

  useEffect(() => {
    api.get("/auth/session")
      .then(({ data }) => {
        sessionStorage.setItem("ellie-csrf-token", data.csrfToken);
        setSession(data);
        loadWorkspaces().catch(() => setWorkspaces([]));
      })
      .catch(() => {
        sessionStorage.removeItem("ellie-csrf-token");
        sessionStorage.removeItem("ellie-session-token");
        setSession(null);
        setWorkspaces([]);
      })
      .finally(() => setLoading(false));
  }, [loadWorkspaces]);

  const value = useMemo(() => ({
    session,
    loading,
    async login(email, password, workspaceId = "") {
      const { data } = await api.post("/auth/login", { email, password, ...(workspaceId ? { workspaceId } : {}) });
      // Password was right, but this account has 2FA on — no session yet,
      // the caller needs to show a code-entry step and call
      // verifyTwoFactor() next. Nothing here treats this as being signed in.
      if (data.requiresTwoFactor) return data;
      const { sessionToken, ...sessionData } = data;
      sessionStorage.setItem("ellie-csrf-token", sessionData.csrfToken);
      sessionStorage.setItem("ellie-session-token", sessionToken);
      setSession(sessionData);
      await loadWorkspaces();
      return sessionData;
    },
    async verifyTwoFactor(challengeId, code, rememberDevice = false) {
      const { data } = await api.post("/auth/login/verify-2fa", { challengeId, code, rememberDevice });
      const { sessionToken, ...sessionData } = data;
      sessionStorage.setItem("ellie-csrf-token", sessionData.csrfToken);
      sessionStorage.setItem("ellie-session-token", sessionToken);
      setSession(sessionData);
      await loadWorkspaces();
      return sessionData;
    },
    workspaces,
    async refreshWorkspaces() { return loadWorkspaces(); },
    async switchWorkspace(workspaceId) {
      const { data } = await api.post("/auth/switch-workspace", { workspaceId });
      const { sessionToken, ...sessionData } = data;
      sessionStorage.setItem("ellie-csrf-token", sessionData.csrfToken);
      sessionStorage.setItem("ellie-session-token", sessionToken);
      setSession(sessionData);
      await loadWorkspaces();
      return sessionData;
    },
    async logout() {
      try {
        await api.post("/auth/logout");
      } finally {
        sessionStorage.removeItem("ellie-csrf-token");
        sessionStorage.removeItem("ellie-session-token");
        setSession(null);
        setWorkspaces([]);
      }
    },
    updateSessionUser(user) { setSession((current) => current ? { ...current, user: { ...current.user, ...user } } : current); },
  }), [loadWorkspaces, loading, session, workspaces]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
