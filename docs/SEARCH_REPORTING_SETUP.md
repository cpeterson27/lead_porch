# Search and AI visibility reporting

## Owner workflow

Open Analytics → Search & AI visibility. Counts are not combined across sources.

1. Google: expand Google connection setup. In the existing Google Cloud OAuth project, enable Search Console API, Analytics Admin API, and Analytics Data API. Register the exact callback URL displayed in the panel as an authorized redirect URI for the web OAuth client. Connect Google, grant the two read-only scopes, load properties, and select the verified site and GA4 property. No Gmail permission is reused. An external OAuth application may require Google review or test-user enrollment depending on its publishing status.
2. Bing: Settings → API Access in Bing Webmaster Tools. Enter the API key and exact verified site URL into the dashboard password field. Do not send the key in chat. Verify/connect, then click Submit sitemap.xml to Bing. Submission acceptance is not confirmation of indexing.
3. Google/Bing AI visibility: open the provider report. If a daily CSV is available, import that daily totals table and select its date/count columns. The Google metric is impressions; the Bing metric is citations. One row per date, with explicitly reported zero days. Query/page breakdowns are rejected when they contain duplicate dates. Imports are explicitly owner-supplied snapshots, never represented as automatic API measurements. Reimport replaces the snapshot and does not add counts. Period, property, file, user, timestamp and checksum are retained. The import period is independent of the search period selector. Remove import clears it.

Google reporting client falls back to the existing GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. SEARCH_GOOGLE_REDIRECT_URI overrides the default PUBLIC_BACKEND_URL + /oauth/search-reporting/callback. See backend/.env.example. Callback uses a one-use random database state, expiry, and a fresh membership check. OAuth and Bing secrets use the existing AES-GCM envelope and are never returned by the API.

## What each number means

- Google Web search: impressions, clicks, weighted click-through rate, daily data, top query/page/country/device data and average position. Finalized data only; dates use Google's Pacific Time. Top breakdowns are capped and subject to privacy filtering; they do not necessarily sum to totals. These are website appearances, not the number of all searches for a business.
- Bing: daily impressions/clicks and dated query results from the JSON REST API. Bing's aggregate includes multiple verticals including Chat; it is not an AI citation counter. Daily traffic and query data have different update schedules. Rows are filtered to the requested dates. The report displays actual returned dates rather than filling gaps with zeros.
- GA4: period sessions, active users, page/screen views, key events and top source/medium rows. Period users come from an aggregate provider query, never a sum of daily users. The property's timezone and collection settings apply. A report connection does not install a tag or turn existing dataLayer events into configured GA4 key events. The live site has a GTM container; its tags and GA4 destination still need validation in the authorized account.
- AI referrals: the existing anonymous tab-session report of identifiable AI website visits, confirmed applications, bookings, and guide requests. Attribution survives navigation; retries are deduplicated. Respecting privacy signals and missing source information means this is a measured subset, not all visitors.
- AI visibility imports: provider counts of appearances/citations on the surfaces covered by that report. They do not expose all private ChatGPT searches and cannot be treated as website visits or unique people.
- There is no supported universal API here for every brand mention across every AI product. No sampled prompts or synthetic tests are mixed into production visitor/visibility counts.

## Refresh, errors, and access

Reports refresh on viewing after their one-hour cache expires. Reload retrieves the current cached report within that hour; it does not force provider queries. Missing connections, missing selections, and unavailable data are separate states without invented zeros. Provider failures retain explicitly labeled stale data and its last retrieval time. Google, GA4 and Bing fail independently. Properties are verified against the connected provider account before saving. Provider keys/caches are workspace-scoped; only owners/admins can connect, select, submit, disconnect, or import. analytics.view is required to read. Existing authenticated middleware enforces CSRF on mutations. Disconnect clears stored credentials and provider caches.

## Crawl alert and discovery audit

On September 26, the live robots file had no crawl-delay, allowed public crawling, and referenced https://elliescoaching.com/sitemap.xml. The XML had 22 URLs and the program page returned readable initial HTML without noindex to an OAI-SearchBot user-agent request. This is a test of public access from the test client, not proof of a genuine crawler visit or indexing. The quoted Bing email named www.website.com, so confirm the affected property and alert inside Bing before changing Crawl Control. Do not maximize crawl rate blindly. No account crawl setting was modified by this release.

Allowing OAI-SearchBot makes pages eligible for discovery; it does not guarantee ChatGPT indexing, recommendations, or a specific answer. GPTBot training permission is separate and was not changed.

## Tests and reference APIs

- `node backend/test-search-reporting.js` — pure accuracy/import checks.
- `SEARCH_REPORT_TEST_DB=local node backend/test-search-reporting.js` — uses only a temporary test_search_reporting_* database on localhost:27029, mocked provider responses, real MongoDB and Express routes; verifies encryption, OAuth replay prevention, permissions, tenancy, caching, stale results, deduplication, and sitemap payload.
- Desktop/mobile Playwright fixture verification: disconnected/ready states, period and table controls, sitemap action, CSV import using the real validator, viewer controls, no overflow/runtime errors. Provider accounts were not mutated by tests.
- Existing AI-attribution and public SEO/sitemap checks were rerun.

References: https://developers.google.com/webmaster-tools/v1/searchanalytics/query ; https://developers.google.com/analytics/devguides/reporting/data/v1 ; https://learn.microsoft.com/en-us/bingwebmaster/ ; https://help.openai.com/en/articles/12627856-publishers-and-developers-faq . AI-report API automation is not claimed: no documented endpoint was verified for those distinct visibility reports during this implementation.
