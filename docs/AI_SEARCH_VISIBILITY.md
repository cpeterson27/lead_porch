# AI search discovery and referral reporting

Implemented September 25, 2026.

## Where the owner can watch results

Open **Analytics → AI search traffic** (`/analytics#ai-search-traffic`). The report has 7-, 30-, and 90-day windows and refreshes every minute while visible. It shows identifiable AI visits, page views, submitted applications, booked discovery calls, guide requests, landing pages, and recent conversions. It uses the existing `analytics.view` permission and workspace isolation.

Traffic is identified from a recognized `utm_source` or referring hostname for ChatGPT, Perplexity, Claude, Gemini, Copilot, or Grok. An explicit campaign source takes precedence over a referrer. Ordinary Google/Bing traffic is not labeled as AI. This is referral measurement, not a report of AI mentions, impressions, rankings, or unique people.

Attribution stays with a browser session across navigation and forms, expiring after 30 minutes of inactivity. A new explicit campaign starts a new session. Session storage has a memory fallback. Global Privacy Control and Do Not Track stop tracking. Anonymous event records contain source evidence, public paths, and timestamps; no email, name, IP address, full referrer URL, or query string. Records expire after 90 days. Submitted business records retain their source under the existing business-record retention policy.

Conversions are written by the server after accepted applications, bookings, and guide requests. Public callers cannot submit a conversion event. Workspace + event ID prevents repeated event delivery from increasing counts. Basic bot filtering and a bounded request limiter protect the public collection endpoint. Source tags and referrers are observational, not verified endorsements by AI providers.

## Technical discovery work

The initial HTML now includes readable published content for the homepage, about page, program listing, all published program detail pages, configured FAQs, resources, sitemap, contact, discovery call, and featured testimonials. People and crawlers receive the same response; JavaScript enhances it into the normal interactive site. Only public projected fields are rendered, with HTML escaping. Private routes and unpublished program content are not included.

Course structured data now includes the referenced organization, and organization logos come from branding instead of a page hero image. The existing XML sitemap contains the site's public canonical URLs. The existing robots policy permits public crawling without adding a special AI-only page or changing AI training preferences.

## Owner follow-through

1. If Bing Webmaster Tools is not already configured, add/verify `https://elliescoaching.com` and submit `https://elliescoaching.com/sitemap.xml`. Google Search Console already has that sitemap; keep its existing submission.
2. In Coaching → Programs, review the seven published programs. At audit time, all seven had descriptions, but dedicated audience, curriculum, and outcome fields were empty. Add accurate prerequisites, who each is for, what is covered, and the expected educational outcomes. The detail pages now display saved curriculum and outcome lists.
3. Approve original, permission-based student case studies and concrete examples of Ellie's experience. Do not add invented results or guaranteed investment returns. Keep public business profiles consistent with the website's business name and contact details.

The technical changes enable discovery and measurement; AI providers decide which pages to cite or recommend. Historical anonymous traffic cannot be reconstructed by this new report.

## Verification

- `node backend/test-ai-traffic.js` — classification, spoofed domain rejection, source precedence, URL redaction, escaped public HTML, private/unpublished content exclusions.
- With a dedicated temporary MongoDB server at port 27029: `AI_TRAFFIC_TEST_MONGO_URI=mongodb://127.0.0.1:27029 node backend/test-ai-traffic.js` — real ingestion, concurrent deduplication, aggregate totals, date windows, tenant isolation, and retention indexes. The test refuses any other database address and creates/drops only its own uniquely named test database.
- `node frontend/test-site-attribution.js` — navigation persistence, session expiry, privacy signals, blocked storage.
- Isolated browser verification exercises public referral → navigation → successful form → real MongoDB → authenticated report, plus desktop/mobile layouts, refresh/date controls, and program/FAQ rendering with JavaScript disabled.

Official references used: [OpenAI crawler guidance](https://developers.openai.com/api/docs/bots), [Perplexity crawler guidance](https://docs.perplexity.ai/docs/resources/perplexity-crawlers), [Google AI search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).
