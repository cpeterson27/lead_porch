import { lazy } from "react";

// A lazy-loaded route chunk's filename hash is baked into the JS already
// running in the browser. Every deploy replaces the server's dist folder
// with entirely new hashed filenames, so an already-open tab that then
// navigates into a route it hasn't loaded yet tries to fetch a chunk that
// no longer exists on the server — a blank screen with no visible error,
// previously only fixed by the user noticing and hitting refresh by hand.
// This reloads the page automatically the first time a chunk fails to
// load in this session, picking up the current build instead. A second
// failure right after a reload is a real error, not a stale-deploy
// mismatch, so it's left to surface normally rather than reload forever.
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    const key = "lp-chunk-retry";
    try {
      const module = await importFn();
      sessionStorage.removeItem(key);
      return module;
    } catch (error) {
      const alreadyRetried = sessionStorage.getItem(key) === "1";
      if (!alreadyRetried) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
        // Never resolves — the reload replaces this page before React ever
        // needs this promise to settle.
        return new Promise(() => {});
      }
      sessionStorage.removeItem(key);
      throw error;
    }
  });
}
