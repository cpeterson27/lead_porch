import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { fetchPublicSite } from "../services/api.js";
import WorkspaceThemeContext from "./WorkspaceThemeContextValue.js";
export function WorkspaceThemeProvider({ children }) {
  const { pathname } = useLocation();
  const [site, setSite] = useState(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const load = () =>
      fetchPublicSite()
        .then(setSite)
        .catch(() => setSite(null))
        .finally(() => setLoading(false));
    const timer = window.setTimeout(load, 0);
    // Branding is fetched once here and never re-fetched, so saving new
    // colors in Public Site Admin left the navbar/sidebar showing the
    // previous colors until a hard page refresh — which read as "the
    // dashboard colors don't match" even though the save worked.
    // Re-fetching on this event (dispatched right after a successful
    // save) keeps them in sync immediately.
    window.addEventListener("workspace-theme-updated", load);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("workspace-theme-updated", load);
    };
  }, []);
  useEffect(() => {
    const b = site?.branding;
    if (!b) return;
    const root = document.documentElement;
    root.style.setProperty("--workspace-primary", b.primaryColor);
    root.style.setProperty("--workspace-accent", b.accentColor);
    root.style.setProperty(
      "--workspace-background",
      b.surfaceMode === "light" ? "#f7f8f7" : "#090b0a",
    );
    root.style.setProperty(
      "--workspace-surface",
      b.surfaceMode === "light" ? "#ffffff" : "#151816",
    );
    root.style.setProperty(
      "--workspace-text",
      b.surfaceMode === "light" ? "#111512" : "#f7f8f7",
    );
    root.style.setProperty(
      "--workspace-muted",
      b.surfaceMode === "light" ? "#667069" : "#a5afa8",
    );
    root.style.setProperty(
      "--workspace-border",
      b.surfaceMode === "light" ? "#dce2de" : "#2a302c",
    );
    // Apply app (dashboard) branding variables.
    // Guard every setProperty call so we only write a value when it is a
    // non-empty string.  Without the guard, fields that haven't been
    // configured yet are `undefined`, and calling setProperty with
    // `undefined` writes the literal string "undefined" to the CSS
    // variable — which overrides the fallback values baked into the CSS.
    const app = site?.appBranding;
    const setProp = (name, value) => {
      if (value && typeof value === "string" && value.trim() !== "") {
        root.style.setProperty(name, value.trim());
      }
    };
    if (app) {
      setProp("--app-sidebar-background", app.sidebarBackgroundColor);
      setProp("--app-sidebar-text", app.sidebarTextColor);
      setProp("--app-header", app.headerColor);
      setProp("--app-primary-action", app.primaryActionColor);
      setProp("--app-accent", app.accentColor);
      setProp("--app-background", app.backgroundColor);
      // The "Primary action" picker previously only reached the one CSS
      // rule that happened to reference --app-primary-action (the mobile
      // hamburger button) — every button, badge, and pill elsewhere reads
      // the STATIC --color-brand/--accent tokens instead, so changing this
      // setting visibly did almost nothing. Overriding those core tokens
      // here (index.css defines --color-brand-hover/--color-brand-soft as
      // color-mix() derived FROM --color-brand, so they follow it too) is
      // what actually re-themes primary buttons, pills, and badges
      // app-wide from this one picker.
      setProp("--color-brand", app.primaryActionColor);
      setProp("--accent", app.accentColor || app.primaryActionColor);
    }
    const publicRoute = /^\/(?:$|about(?:\/|$)|coaching-programs(?:\/|$)|testimonials(?:\/|$)|contact(?:\/|$)|people(?:\/|$)|privacy(?:-policy)?(?:\/|$)|terms(?:\/|$)|data-deletion(?:\/|$)|apply(?:\/|$)|ref(?:\/|$)|profile\/edit(?:\/|$))/.test(pathname);
    const favicon = publicRoute ? b.faviconUrl : app?.faviconUrl || b.faviconUrl;
    const variant = (url, size) => url?.includes("res.cloudinary.com/") && url.includes("/image/upload/") ? url.replace("/image/upload/", `/image/upload/c_fill,w_${size},h_${size},f_png/`) : url;
    document.querySelectorAll("link[data-workspace-favicon]").forEach((node) => node.remove());
    if (favicon) {
      const fallbackIcon = document.querySelector("link[rel='icon']:not([data-workspace-favicon])");
      if (fallbackIcon) fallbackIcon.href = variant(favicon, 32);
      [["icon",16],["icon",32],["icon",48],["icon",192],["icon",512],["apple-touch-icon",180]].forEach(([rel,size]) => {
        const link = document.createElement("link");
        link.rel = rel;
        link.href = variant(favicon, size);
        link.sizes = `${size}x${size}`;
        link.type = "image/png";
        link.dataset.workspaceFavicon = "true";
        document.head.appendChild(link);
      });
    }
  }, [site, pathname]);
  const value = useMemo(() => ({ site, loading }), [site, loading]);
  return (
    <WorkspaceThemeContext.Provider value={value}>
      {children}
    </WorkspaceThemeContext.Provider>
  );
}
