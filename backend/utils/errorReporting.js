const Sentry = require("@sentry/node");

// Checklist section 11 ("error logging"). Rather than hand-editing every
// console.error(...) call across every runner/service in this codebase
// (there are dozens), this patches console.error itself once, at process
// start, so every existing error-reporting call site — the established
// convention everywhere in this app — also reports to Sentry for free.
// No-op entirely when SENTRY_DSN isn't set, so local dev is unaffected.
function initErrorReporting() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || "production", tracesSampleRate: 0.1 });
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    const error = args.find((arg) => arg instanceof Error);
    if (error) Sentry.captureException(error);
    originalError(...args);
  };
}

module.exports = { initErrorReporting, Sentry };
