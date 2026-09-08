import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const selectors = { home: ".public-hero", about: ".public-intro", programs: ".public-section--programs", team: ".team-section", results: "#results", contact: ".public-final" };
export default function PublicHomepageAnchors() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== "/") return;
    for (const [id, selector] of Object.entries(selectors)) { const element = document.querySelector(selector); if (element && !element.id) element.id = id; }
    const id = location.hash.slice(1); if (!id || !selectors[id]) return;
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 0);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.hash]);
  return null;
}
