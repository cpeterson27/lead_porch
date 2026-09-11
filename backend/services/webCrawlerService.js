/**
 * A minimal, compliance-first crawler for the Public Web Discovery engine
 * (services/publicWebDiscoveryEngineService.js): fetches ONLY a citation
 * URL a grounded search already returned as public evidence — this never
 * originates its own search, it only reads a page the provider already
 * pointed to, to extract more structured detail than a search snippet
 * carries.
 *
 * Compliance, in order, before any GET is issued:
 *   1. Facebook and LinkedIn are NEVER fetched, full stop — every page on
 *      either platform that could plausibly hold a "public" group/profile
 *      is, in practice, gated behind a login wall for an unauthenticated
 *      request, and reliably telling "genuinely public" apart from
 *      "login wall that happens to render some content" from the response
 *      alone is not something this can do safely. Their citation URLs
 *      still appear as evidence links (from the search engine's own
 *      snippet) — they are just never fetched further.
 *   2. robots.txt for the URL's origin is fetched and parsed (a minimal,
 *      dependency-free parser — User-agent groups, Allow/Disallow prefix
 *      matching, longest-match-wins). An explicit 404 for robots.txt means
 *      "no file — allowed"; any other failure (timeout, 5xx, DNS) is
 *      treated as "cannot verify — do not fetch" rather than assuming
 *      permission.
 *   3. A per-hostname minimum interval between requests (DISCOVERY_CRAWL_
 *      MIN_INTERVAL_MS, default 3000ms) — enforced in-process; note this
 *      is per-server-instance, not a distributed rate limit.
 *   4. The response itself: a 401/403, or a redirect/body matching common
 *      login-wall markers, is reported as skipped rather than treated as
 *      real page content.
 *
 * No live HTTP call is ever made from this module's own test file — every
 * test injects a fake `httpGet`.
 */
const axios = require("axios");

const USER_AGENT = "LeadPorchDiscoveryBot/1.0 (+public web discovery for review-only lead research; respects robots.txt; contact via the workspace operator)";
const MIN_INTERVAL_MS = Number(process.env.DISCOVERY_CRAWL_MIN_INTERVAL_MS) || 3000;
const FETCH_TIMEOUT_MS = Number(process.env.DISCOVERY_CRAWL_TIMEOUT_MS) || 10000;
const MAX_TEXT_LENGTH = 6000;

// Never fetched, regardless of robots.txt — see module header.
const NEVER_CRAWL_HOSTS = ["facebook.com", "m.facebook.com", "web.facebook.com", "linkedin.com", "www.linkedin.com"];

const lastFetchAtByHost = new Map();

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function isNeverCrawlHost(hostname) {
  const bare = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return NEVER_CRAWL_HOSTS.some((denied) => bare === denied || bare.endsWith(`.${denied}`));
}

/**
 * Minimal robots.txt parser: groups by User-agent, collects Allow/Disallow
 * rules for the matching group ("*" if no product-specific group exists),
 * and resolves a path via longest-prefix-match (an Allow rule wins a tie
 * against a Disallow rule of the same length, per the de facto standard).
 * Deliberately simple — no wildcard (`*`/`$`) rule support beyond plain
 * prefixes, which covers the overwhelming majority of real robots.txt
 * files; an unsupported wildcard rule is just not applied to path
 * matching (fails open on that ONE rule, not on the file as a whole).
 */
function parseRobotsTxt(text, productToken = "leadporchdiscoverybot") {
  const lines = String(text || "").split(/\r?\n/);
  const groups = new Map(); // agent (lowercase) -> { allow: [], disallow: [] }
  let currentAgents = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) { currentAgents = currentAgents.length ? currentAgents : currentAgents; continue; }
    const [rawField, ...rest] = line.split(":");
    const field = String(rawField || "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      const agent = value.toLowerCase();
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
      currentAgents = [agent];
      continue;
    }
    if (!currentAgents.length) continue;
    if (field === "disallow" && value) for (const agent of currentAgents) groups.get(agent).disallow.push(value);
    if (field === "allow" && value) for (const agent of currentAgents) groups.get(agent).allow.push(value);
  }
  const group = groups.get(productToken) || groups.get("*") || { allow: [], disallow: [] };
  return {
    isAllowed(pathname) {
      const path = pathname || "/";
      let best = { length: -1, allowed: true };
      for (const rule of group.disallow) {
        if (rule === "") continue; // an empty Disallow means "allow everything"
        if (path.startsWith(rule) && rule.length > best.length) best = { length: rule.length, allowed: false };
      }
      for (const rule of group.allow) {
        if (path.startsWith(rule) && rule.length >= best.length) best = { length: rule.length, allowed: true };
      }
      return best.allowed;
    },
  };
}

async function fetchRobotsTxt(origin, dependencies = {}) {
  const httpGet = dependencies.httpGet || ((url, options) => axios.get(url, options));
  try {
    const response = await httpGet(`${origin}/robots.txt`, { timeout: FETCH_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT }, validateStatus: () => true });
    if (response.status === 404) return { checked: true, matcher: parseRobotsTxt("") }; // no file = allowed
    if (response.status >= 200 && response.status < 300) return { checked: true, matcher: parseRobotsTxt(response.data) };
    return { checked: false, matcher: null }; // ambiguous (5xx, etc.) — fail closed
  } catch {
    return { checked: false, matcher: null }; // network error — fail closed, never assume allowed
  }
}

async function waitForRateLimit(hostname) {
  const last = lastFetchAtByHost.get(hostname) || 0;
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastFetchAtByHost.set(hostname, Date.now());
}

const LOGIN_WALL_PATTERNS = [/log ?in to (continue|see|view)/i, /sign in to (continue|see|view)/i, /you must (log|sign) in/i, /create an account to (continue|see|view)/i];

function looksLikeLoginWall(status, text) {
  if (status === 401 || status === 403) return true;
  const sample = String(text || "").slice(0, 4000);
  return LOGIN_WALL_PATTERNS.some((pattern) => pattern.test(sample));
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Evaluates whether a URL may be crawled at all, without fetching the page
 * body — used so a caller can report WHY a citation was skipped
 * (denylisted platform vs. robots.txt vs. unverifiable) even when it never
 * issues the GET.
 */
async function evaluateCrawlability(url, dependencies = {}) {
  const hostname = hostOf(url);
  if (!hostname) return { allowed: false, reason: "invalid_url" };
  if (isNeverCrawlHost(hostname)) return { allowed: false, reason: "platform_never_crawled" };
  let origin;
  try { origin = new URL(url).origin; } catch { return { allowed: false, reason: "invalid_url" }; }
  const robots = await fetchRobotsTxt(origin, dependencies);
  if (!robots.checked) return { allowed: false, reason: "robots_txt_unverifiable" };
  const pathname = (() => { try { return new URL(url).pathname; } catch { return "/"; } })();
  if (!robots.matcher.isAllowed(pathname)) return { allowed: false, reason: "robots_txt_disallowed" };
  return { allowed: true, reason: "" };
}

/**
 * Fetches one page's text content, respecting the full compliance chain
 * above. Never throws for an expected "can't/won't crawl this" outcome —
 * those come back as `{ skippedReason }` so a caller can tally them for
 * the run's per-source report rather than treating them as unexpected
 * errors.
 */
async function fetchPage(url, dependencies = {}) {
  const httpGet = dependencies.httpGet || ((u, options) => axios.get(u, options));
  const crawlability = await evaluateCrawlability(url, dependencies);
  if (!crawlability.allowed) return { ok: false, skippedReason: crawlability.reason, textExcerpt: "", finalUrl: url, status: null };

  const hostname = hostOf(url);
  await waitForRateLimit(hostname);
  try {
    const response = await httpGet(url, { timeout: FETCH_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT }, maxRedirects: 5, validateStatus: () => true });
    const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
    const bodyText = typeof response.data === "string" ? response.data : "";
    if (looksLikeLoginWall(response.status, bodyText)) return { ok: false, skippedReason: "login_wall", textExcerpt: "", finalUrl, status: response.status };
    if (response.status < 200 || response.status >= 300) return { ok: false, skippedReason: `http_${response.status}`, textExcerpt: "", finalUrl, status: response.status };
    return { ok: true, skippedReason: "", textExcerpt: stripHtmlToText(bodyText), finalUrl, status: response.status };
  } catch (error) {
    return { ok: false, skippedReason: "fetch_error", error: error.message, textExcerpt: "", finalUrl: url, status: null };
  }
}

module.exports = { USER_AGENT, MIN_INTERVAL_MS, isNeverCrawlHost, parseRobotsTxt, fetchRobotsTxt, evaluateCrawlability, fetchPage, looksLikeLoginWall, stripHtmlToText, hostOf };
