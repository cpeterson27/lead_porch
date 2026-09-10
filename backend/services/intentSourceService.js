const axios = require("axios");
const crypto = require("node:crypto");
const { fetchPublicPage, plainText, safeUrl } = require("./publicWebsiteResearchService");

const USER_AGENT = "GrowthOperatorResearchBot/1.0 (+https://ellie-ai-backend.onrender.com/gpt-actions/privacy; support@elliescoaching.com)";
const REQUEST_TIMEOUT = 20000;
const REDDIT_CACHE_MS = Math.max(5 * 60000, Number(process.env.REDDIT_PUBLIC_CACHE_MS) || 15 * 60000);
const REDDIT_MIN_REQUEST_GAP_MS = Math.max(1000, Number(process.env.REDDIT_PUBLIC_REQUEST_GAP_MS) || 3000);
const REDDIT_DEFAULT_BACKOFF_MS = Math.max(5 * 60000, Number(process.env.REDDIT_PUBLIC_BACKOFF_MS) || 30 * 60000);
const redditCache = new Map();
const redditInFlight = new Map();
let redditLastRequestAt = 0;
let redditCooldownUntil = 0;

const clean = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decodeEntities = (value) => String(value || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
const hashId = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

function isBiggerPocketsForumTopicUrl(value) {
  try {
    const parsed = new URL(value);
    return /(^|\.)biggerpockets\.com$/i.test(parsed.hostname) && /\/forums\/\d+\/topics\/\d+/i.test(parsed.pathname);
  } catch (_error) { return false; }
}

function canonicalSourceUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    parsed.hash = "";
    if (isBiggerPocketsForumTopicUrl(parsed.toString())) return `https://www.biggerpockets.com${parsed.pathname.replace(/\/$/, "")}`;
    [...parsed.searchParams.keys()].forEach((key) => {
      if (/^utm_/i.test(key) || /^(?:fbclid|gclid|msclkid)$/i.test(key)) parsed.searchParams.delete(key);
    });
    return parsed.toString().replace(/\/$/, "");
  } catch (_error) { return String(value || "").trim(); }
}

function indexedPostDate(value) {
  const match = String(value || "").match(/\b(?:posted|published)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} 00:00:00 UTC`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function queryFor(monitor) {
  const keywords = (monitor.keywords || []).map(clean).filter(Boolean);
  const locations = (monitor.locations || []).map(clean).filter(Boolean);
  return [...keywords, ...locations].join(" ") || clean(monitor.query);
}

function termsFor(monitor, max = 6) {
  const terms = (monitor.keywords || []).map(clean).filter(Boolean);
  return (terms.length ? terms : [clean(monitor.query)]).slice(0, max);
}

function booleanQueryFor(monitor, max = 6) {
  return termsFor(monitor, max).map((term) => /\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term).join(" OR ");
}

function isCommunityPartnerMonitor(monitor) {
  if (monitor.monitorType) return monitor.monitorType === "community_partner";
  return /community leaders?|organizers?|group admins?|group owners?|meetup hosts?|association (?:directors?|presidents?)|podcast hosts?|newsletter publishers?/i.test(`${monitor.query || ""} ${(monitor.keywords || []).join(" ")}`);
}

function isInvestorProfileMonitor(monitor) {
  return monitor.monitorType === "investor_profile";
}

function normalizeSignal(source, item = {}) {
  const sourceUrl = canonicalSourceUrl(item.sourceUrl);
  if (!sourceUrl) return null;
  const explicitIndexedDate = isBiggerPocketsForumTopicUrl(sourceUrl) ? indexedPostDate(`${item.title || ""} ${item.excerpt || ""}`) : null;
  const publishedAt = explicitIndexedDate || (item.publishedAt && !Number.isNaN(new Date(item.publishedAt).valueOf()) ? new Date(item.publishedAt) : null);
  return {
    source,
    sourceId: isBiggerPocketsForumTopicUrl(sourceUrl) ? sourceUrl : String(item.sourceId || hashId(sourceUrl)).trim(),
    sourceUrl,
    title: decodeEntities(clean(item.title)).slice(0, 1000),
    excerpt: decodeEntities(clean(item.excerpt)).slice(0, 6000),
    authorName: decodeEntities(clean(decodeEntities(item.authorName))).replace(/^submitted by\s+/i, "").replace(/^u\//i, "u/"),
    authorUrl: String(item.authorUrl || "").trim(),
    organizationName: decodeEntities(clean(item.organizationName)),
    organizationDomain: String(item.organizationDomain || "").trim().toLowerCase(),
    publishedAt,
    evidence: [{ label: item.evidenceLabel || source.replaceAll("_", " "), url: sourceUrl, observedAt: new Date() }],
    raw: item.raw || {},
  };
}

function explicitOrganizerCandidates(text) {
  const names = [...String(text || "").matchAll(/\b(?:organized|hosted|led) by\s+([A-Z][\p{L}.'’ -]+?)(?=[,.|;]|\s+(?:and|for|with)\b|$)|\b(?:organizer|host)\s*:\s*([A-Z][\p{L}.'’ -]+?)(?=[,.|;]|$)/giu)]
    .map((match) => clean(match[1] || match[2])).filter((name) => name.split(/\s+/).length >= 2 && name.length <= 100 && !/meetup|community|group|team/i.test(name));
  return [...new Set(names)];
}

function extractXmlItems(xml) {
  const blocks = String(xml || "").match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const tag = (block, names) => {
    for (const name of names) {
      const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"));
      if (match?.[1]) return match[1];
    }
    return "";
  };
  return blocks.map((block) => {
    const href = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || tag(block, ["link"]);
    return {
      id: tag(block, ["guid", "id"]) || href,
      link: decodeEntities(href),
      title: tag(block, ["title"]),
      description: tag(block, ["description", "summary", "content"]),
      author: tag(block, ["author", "dc:creator", "name"]),
      publishedAt: tag(block, ["pubDate", "published", "updated"]),
    };
  });
}

async function fetchJson(url, params = {}) {
  try {
    return await axios.get(url, { params, timeout: REQUEST_TIMEOUT, maxContentLength: 8 * 1024 * 1024, headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  } catch (error) {
    if (error.response?.status !== 429) throw error;
    await new Promise((resolve) => setTimeout(resolve, 6500));
    return axios.get(url, { params, timeout: REQUEST_TIMEOUT, maxContentLength: 8 * 1024 * 1024, headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  }
}

async function searchGdelt(monitor, limit) {
  const response = await fetchJson("https://api.gdeltproject.org/api/v2/doc/doc", {
    query: booleanQueryFor(monitor), mode: "artlist", maxrecords: Math.min(250, limit), format: "json", sort: "datedesc",
  });
  return (response.data?.articles || []).map((article) => normalizeSignal("gdelt", {
    sourceId: article.url,
    sourceUrl: article.url,
    title: article.title,
    excerpt: [article.domain, article.sourcecountry, article.language].filter(Boolean).join(" · "),
    organizationDomain: article.domain,
    publishedAt: article.seendate,
    evidenceLabel: "GDELT indexed public news",
    raw: { domain: article.domain, sourcecountry: article.sourcecountry, language: article.language },
  })).filter(Boolean);
}

async function searchBluesky(monitor, limit) {
  const requests = termsFor(monitor, 4).map((term) => fetchJson("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts", { q: term, limit: Math.min(25, limit), sort: "latest" }));
  const responses = await Promise.all(requests);
  const posts = responses.flatMap((response) => response.data?.posts || []);
  return [...new Map(posts.map((post) => [post.uri || post.cid, post])).values()].slice(0, limit).map((post) => {
    const handle = post.author?.handle || "";
    const recordKey = String(post.uri || "").split("/").pop();
    return normalizeSignal("bluesky", {
      sourceId: post.uri || post.cid,
      sourceUrl: handle && recordKey ? `https://bsky.app/profile/${handle}/post/${recordKey}` : `https://bsky.app/profile/${handle}`,
      title: post.record?.text,
      excerpt: post.record?.text,
      authorName: post.author?.displayName || handle,
      authorUrl: handle ? `https://bsky.app/profile/${handle}` : "",
      publishedAt: post.record?.createdAt || post.indexedAt,
      evidenceLabel: "Public Bluesky post",
      raw: { handle, replyCount: post.replyCount, repostCount: post.repostCount, likeCount: post.likeCount },
    });
  }).filter(Boolean);
}

async function searchHackerNews(monitor, limit) {
  const responses = await Promise.all(termsFor(monitor, 5).map((term) => fetchJson("https://hn.algolia.com/api/v1/search_by_date", { query: term, tags: "story,comment", hitsPerPage: Math.min(30, limit) })));
  const hits = responses.flatMap((response) => response.data?.hits || []);
  return [...new Map(hits.map((hit) => [hit.objectID, hit])).values()].slice(0, limit).map((hit) => normalizeSignal("hacker_news", {
    sourceId: hit.objectID,
    sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: hit.title || hit.story_title || hit.comment_text,
    excerpt: hit.comment_text || hit.story_text || hit.title,
    authorName: hit.author,
    authorUrl: hit.author ? `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}` : "",
    publishedAt: hit.created_at,
    evidenceLabel: "Public Hacker News discussion",
    raw: { points: hit.points, numComments: hit.num_comments, storyUrl: hit.url || hit.story_url },
  })).filter(Boolean);
}

async function searchStackExchange(monitor, limit) {
  const responses = await Promise.all(termsFor(monitor, 5).map((term) => fetchJson("https://api.stackexchange.com/2.3/search/advanced", {
    order: "desc", sort: "creation", q: term, site: "workplace", pagesize: Math.min(30, limit), filter: "withbody",
  })));
  const items = responses.flatMap((response) => response.data?.items || []);
  return [...new Map(items.map((item) => [item.question_id, item])).values()].slice(0, limit).map((item) => normalizeSignal("stack_exchange", {
    sourceId: item.question_id,
    sourceUrl: item.link,
    title: item.title,
    excerpt: item.body,
    authorName: item.owner?.display_name,
    authorUrl: item.owner?.link,
    publishedAt: item.creation_date ? item.creation_date * 1000 : null,
    evidenceLabel: "Public Stack Exchange question",
    raw: { score: item.score, answerCount: item.answer_count, tags: item.tags },
  })).filter(Boolean);
}

async function fetchFeed(url, source, label, limit) {
  await safeUrl(url);
  const response = await axios.get(url, { timeout: REQUEST_TIMEOUT, responseType: "text", maxContentLength: 5 * 1024 * 1024, headers: { Accept: "application/rss+xml, application/atom+xml, text/xml", "User-Agent": USER_AGENT } });
  return extractXmlItems(response.data).slice(0, limit).map((item) => normalizeSignal(source, {
    sourceId: item.id || item.link,
    sourceUrl: item.link,
    title: item.title,
    excerpt: item.description,
    authorName: item.author,
    publishedAt: item.publishedAt,
    evidenceLabel: label,
  })).filter(Boolean);
}

// Multiple focused searches instead of one giant keyword-joined query. Each
// chunk is small enough that Reddit's search actually returns relevant,
// on-topic results rather than a noisy union of 20+ unrelated terms.
function redditQueryChunks(monitor) {
  const quoted = (term) => /\s/.test(term) ? `"${term}"` : term;
  const categoryGroups = (monitor.intentCategories || []).map((category) => (category.phrases || []).map(clean).filter(Boolean)).filter((group) => group.length);
  if (categoryGroups.length) return categoryGroups.slice(0, 6).map((group) => group.slice(0, 3).map(quoted).join(" OR "));
  const keywords = (monitor.keywords || []).map(clean).filter(Boolean);
  if (!keywords.length) return [booleanQueryFor(monitor)].filter(Boolean);
  const chunkSize = 2;
  const chunks = [];
  for (let i = 0; i < keywords.length; i += chunkSize) chunks.push(keywords.slice(i, i + chunkSize).map(quoted).join(" OR "));
  return chunks.slice(0, 6);
}

// Full post context (title + selftext, not a truncated RSS snippet) via
// Reddit's public, unauthenticated search.json endpoint — same access level
// as the RSS feed, just structurally complete.
async function fetchRedditSearchJson(url, source, label, limit) {
  await safeUrl(url);
  const response = await axios.get(url, { timeout: REQUEST_TIMEOUT, maxContentLength: 5 * 1024 * 1024, headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  const children = response.data?.data?.children || [];
  return children.slice(0, limit).map((child) => {
    const post = child.data || {};
    const permalink = post.permalink ? `https://www.reddit.com${post.permalink}` : post.url;
    const fullText = [post.title, post.selftext].filter(Boolean).join("\n\n");
    return normalizeSignal(source, {
      sourceId: post.id || post.name || permalink,
      sourceUrl: permalink,
      title: post.title,
      excerpt: fullText || post.title,
      authorName: post.author && post.author !== "[deleted]" ? `u/${post.author}` : "",
      authorUrl: post.author && post.author !== "[deleted]" ? `https://www.reddit.com/user/${post.author}` : "",
      publishedAt: post.created_utc ? post.created_utc * 1000 : null,
      evidenceLabel: label,
      raw: { subreddit: post.subreddit, numComments: post.num_comments, over18: post.over_18, isSelf: post.is_self, score: post.score, linkFlairText: post.link_flair_text },
    });
  }).filter(Boolean);
}

async function searchRedditRss(monitor, limit, operations = { fetchFeed: fetchRedditSearchJson }) {
  const chunks = redditQueryChunks(monitor);
  const key = chunks.join("|").toLowerCase();
  const cached = redditCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.signals.slice(0, limit);
  if (redditCooldownUntil > Date.now()) {
    const error = new Error(`Reddit public RSS is waiting for retry after ${new Date(redditCooldownUntil).toISOString()}`);
    error.response = { status: 429, headers: { "retry-after": Math.ceil((redditCooldownUntil - Date.now()) / 1000) } };
    error.retryAt = new Date(redditCooldownUntil);
    throw error;
  }
  if (redditInFlight.has(key)) return (await redditInFlight.get(key)).slice(0, limit);
  const request = (async () => {
    const collected = [];
    for (const chunkQuery of chunks) {
      if (redditCooldownUntil > Date.now()) break;
      const waitMs = Math.max(0, REDDIT_MIN_REQUEST_GAP_MS - (Date.now() - redditLastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      redditLastRequestAt = Date.now();
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(chunkQuery)}&sort=new&t=month&limit=${Math.min(25, limit)}`;
      try {
        const signals = await operations.fetchFeed(url, "reddit_rss", "Public Reddit search (full post context)", limit);
        collected.push(...signals);
      } catch (error) {
        if (error.response?.status === 429) {
          const retrySeconds = Number(error.response?.headers?.["retry-after"] || 0);
          redditCooldownUntil = Date.now() + Math.max(REDDIT_DEFAULT_BACKOFF_MS, retrySeconds * 1000);
          error.retryAt = new Date(redditCooldownUntil);
        }
        if (!collected.length && chunkQuery === chunks[0]) throw error;
        break;
      }
    }
    const unique = [...new Map(collected.map((signal) => [signal.sourceUrl || signal.sourceId, signal])).values()];
    redditCache.set(key, { expiresAt: Date.now() + REDDIT_CACHE_MS, signals: unique });
    return unique;
  })();
  redditInFlight.set(key, request);
  try { return (await request).slice(0, limit); }
  finally { redditInFlight.delete(key); }
}

function resetRedditPublicState() { redditCache.clear(); redditInFlight.clear(); redditLastRequestAt = 0; redditCooldownUntil = 0; }

function bingQueriesFor(monitor) {
  const baseQuery = booleanQueryFor(monitor);
  return isInvestorProfileMonitor(monitor) ? [
    { type: "investor_profile", query: `(\"accredited investor\" OR \"limited partner\" OR \"LP investor\" OR \"passive investor\" OR \"multifamily investor\") (physician OR orthodontist OR founder OR \"managing partner\" OR \"software architect\" OR VP OR director)` },
    { type: "professional_profile", query: `(inurl:bio OR inurl:team OR inurl:leadership OR inurl:about) (\"passive investor\" OR \"real estate investor\" OR multifamily) (founder OR physician OR dentist OR executive OR director)` },
    { type: "community", query: `(site:meetup.com OR site:eventbrite.com OR site:biggerpockets.com) (\"passive income\" OR \"multifamily investing\" OR syndication OR \"accredited investor\") (${baseQuery})` },
    { type: "monitor", query: baseQuery },
  ] : [
    { type: "biggerpockets_forum", query: `site:biggerpockets.com/forums inurl:topics (multifamily OR \"multi-family\" OR apartments) (coaching OR coach OR mentor OR mentoring OR mentorship OR \"mentoring program\" OR course OR training OR overwhelmed OR \"need help\" OR \"worth it\")` },
    { type: "social", query: `(site:facebook.com/groups OR site:linkedin.com/groups OR site:x.com OR site:twitter.com OR site:instagram.com OR site:threads.net) (${baseQuery})` },
    { type: "community", query: `(site:youtube.com OR site:meetup.com OR site:eventbrite.com) (${baseQuery})` },
    { type: "forums", query: `(site:discord.com OR site:discord.gg OR inurl:forum OR "real estate investors association" OR "local REIA") (${baseQuery})` },
    { type: "monitor", query: baseQuery },
  ];
}

function roundRobinSignals(groups, limit) {
  const output = []; let index = 0;
  while (output.length < limit && groups.some((group) => index < group.length)) {
    for (const group of groups) if (group[index] && output.length < limit) output.push(group[index]);
    index += 1;
  }
  return output;
}

async function searchBingWeb(monitor, limit, operations = { fetchFeed }) {
  const queries = bingQueriesFor(monitor);
  const responses = await Promise.allSettled(queries.map(({ query, type }) => {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
    return operations.fetchFeed(url, "bing_web", type === "biggerpockets_forum" ? "BiggerPockets forum via Bing" : "Bing public web and community result", limit)
      .then((signals) => signals.map((signal) => ({ ...signal, raw: { ...(signal.raw || {}), bingQueryType: type, indexedSourceLabel: isBiggerPocketsForumTopicUrl(signal.sourceUrl) ? "BiggerPockets forum via Bing" : "Bing public web" } })));
  }));
  const successful = responses.filter((response) => response.status === "fulfilled");
  if (!successful.length) throw responses[0]?.reason || new Error("Bing returned no usable search responses.");
  const signals = [...new Map(roundRobinSignals(successful.map((response) => response.value), limit).map((signal) => [canonicalSourceUrl(signal.sourceUrl), signal])).values()];
  return signals.map((signal) => {
    try { return { ...signal, organizationDomain: new URL(signal.sourceUrl).hostname.replace(/^www\./, "") }; }
    catch (_error) { return signal; }
  });
}

async function searchIndexedSocialGroups(monitor, platform, limit) {
  const config = platform === "linkedin"
    ? { host: "linkedin.com", path: "groups", source: "linkedin_public", label: "Bing-indexed public LinkedIn group" }
    : { host: "facebook.com", path: "groups", source: "facebook_public", label: "Bing-indexed public Facebook group" };
  const terms = booleanQueryFor(monitor);
  const queries = [
    `site:${config.host} inurl:${config.path} (${terms})`,
    `site:www.${config.host} inurl:${config.path} (${terms})`,
    `site:${config.host} "group" (${terms})`,
  ];
  const responses = await Promise.allSettled(queries.map((query) => fetchFeed(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
    config.source,
    config.label,
    limit,
  )));
  const successful = responses.filter((response) => response.status === "fulfilled");
  if (!successful.length) throw responses[0]?.reason || new Error(`Bing returned no usable ${platform} search responses.`);
  const results = successful.flatMap((response) => response.value);
  return [...new Map(results.filter((signal) => {
    try {
      const parsed = new URL(signal.sourceUrl);
      const hostMatches = parsed.hostname.toLowerCase() === config.host || parsed.hostname.toLowerCase().endsWith(`.${config.host}`);
      return hostMatches && (parsed.pathname.toLowerCase().includes(`/${config.path}`) || /\bgroup\b/i.test(`${signal.title} ${signal.excerpt}`));
    } catch (_error) { return false; }
  }).map((signal) => [signal.sourceUrl, signal])).values()].slice(0, limit);
}

const searchLinkedInPublic = (monitor, limit) => searchIndexedSocialGroups(monitor, "linkedin", limit);
const searchFacebookPublic = (monitor, limit) => searchIndexedSocialGroups(monitor, "facebook", limit);

async function searchBingNews(monitor, limit) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(booleanQueryFor(monitor))}&format=rss`;
  const signals = await fetchFeed(url, "bing_news", "Bing public news result feed", limit);
  return signals.map((signal) => {
    try { return { ...signal, organizationDomain: new URL(signal.sourceUrl).hostname.replace(/^www\./, "") }; }
    catch (_error) { return signal; }
  });
}

async function searchMeetupPublic(monitor, limit) {
  const directoryUrls = [
    "https://www.meetup.com/topics/real-estate-investing/us/",
    "https://www.meetup.com/topics/real-estate-investors/us/",
    "https://www.meetup.com/topics/apartment-owners/us/",
    "https://www.meetup.com/topics/real-estate-networking/us/",
  ];
  const reserved = new Set(["about", "apps", "blog", "cities", "find", "home", "login", "lp", "meetup-pro", "register", "sitemap", "start", "topics"]);
  const directories = await Promise.allSettled(directoryUrls.map((url) => fetchPublicPage(url)));
  const groupLinks = directories.flatMap((result) => result.status === "fulfilled" && !result.value.blocked ? publicPageLinks(result.value.html, result.value.url) : []).filter((link) => {
    const parts = new URL(link.url).pathname.split("/").filter(Boolean);
    return parts.length === 1 && !reserved.has(parts[0].toLowerCase());
  });
  const targets = [...new Map(groupLinks.map((link) => [link.url.split("?")[0], { ...link, url: link.url.split("?")[0] }])).values()].slice(0, Math.min(40, Math.max(limit, 20)));
  const pages = await Promise.allSettled(targets.map((target) => fetchPublicPage(target.url)));
  return pages.flatMap((result, index) => {
    if (result.status !== "fulfilled" || result.value.blocked) return [];
    const html = result.value.html;
    const title = htmlMeta(html, "og:title").replace(/\s*\|\s*Meetup\s*$/i, "") || targets[index].label;
    const excerpt = htmlMeta(html, "og:description") || htmlMeta(html, "description");
    if (!/real estate|multifamily|apartment|landlord|property invest|REIA/i.test(`${title} ${excerpt}`)) return [];
    const memberCount = Number(html.match(/"memberships(?:\([^)]*\))?":\{"__typename":"MembershipConnection","totalCount":(\d+)/)?.[1] || 0);
    const recentActivity = /"status":"UPCOMING"|"dateTime":"2026-/i.test(html);
    const organizerCandidates = explicitOrganizerCandidates(excerpt);
    return [normalizeSignal("meetup_public", {
      sourceId: result.value.url, sourceUrl: result.value.url, title, excerpt,
      authorName: organizerCandidates.length === 1 ? organizerCandidates[0] : "",
      authorUrl: organizerCandidates.length === 1 ? result.value.url : "",
      organizationName: title, organizationDomain: "meetup.com", evidenceLabel: "Public Meetup real-estate group",
      raw: { discoveryMethod: "public_meetup_topic_directory", memberCount, recentActivity, organizerCandidates },
    })].filter(Boolean);
  }).slice(0, limit);
}

async function searchGoogleWeb(monitor, limit) {
  const key = String(process.env.GOOGLE_SEARCH_API_KEY || "").trim();
  const cx = String(process.env.GOOGLE_SEARCH_ENGINE_ID || "").trim();
  if (!key || !cx) throw new Error("Google Programmable Search is not configured.");
  const baseQuery = booleanQueryFor(monitor);
  const queries = [
    { query: baseQuery, label: "Google public web result" },
    {
      query: `(site:facebook.com/groups OR site:linkedin.com/groups OR site:x.com OR site:twitter.com OR site:instagram.com OR site:threads.net) (${baseQuery})`,
      label: "Google-indexed public social community result",
      searchType: "public_social",
    },
    {
      query: `(site:youtube.com OR site:biggerpockets.com OR site:meetup.com OR site:eventbrite.com) (${baseQuery})`,
      label: "Google-indexed public video, real-estate, or event community result",
      searchType: "public_events_and_forums",
    },
    {
      query: `(site:discord.com OR site:discord.gg OR inurl:forum OR "real estate investors association" OR "local REIA") (${baseQuery})`,
      label: "Google-indexed public forum, Discord, or local REIA result",
      searchType: "public_forums_and_reia",
    },
  ];
  const responses = await Promise.allSettled(queries.map(({ query }) => axios.get("https://customsearch.googleapis.com/customsearch/v1", {
    params: { key, cx, q: query, num: Math.min(10, limit) },
    timeout: REQUEST_TIMEOUT,
    maxContentLength: 4 * 1024 * 1024,
  })));
  const successful = responses.filter((response) => response.status === "fulfilled");
  if (!successful.length) throw responses[0]?.reason || new Error("Google returned no usable search responses.");
  const results = responses.flatMap((response, index) => response.status === "fulfilled"
    ? (response.value.data?.items || []).map((item) => ({ item, label: queries[index].label }))
    : []);
  return [...new Map(results.map(({ item, label }) => [item.link, normalizeSignal("google_web", {
    sourceId: item.cacheId || item.link,
    sourceUrl: item.link,
    title: item.title,
    excerpt: item.snippet,
    organizationDomain: item.displayLink,
    evidenceLabel: label,
    raw: { googleSearchType: queries.find((query) => query.label === label)?.searchType || "open_web" },
  })])).values()].filter(Boolean).slice(0, limit);
}

function xmlValue(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeEntities(clean(String(xml || "").match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1] || ""));
}

function xmlBlocks(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(xml || "").matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi"))].map((match) => match[1]);
}

function parseSecFormD(xml, filing = {}) {
  const issuer = xmlValue(xml, "entityName");
  const issuerAddress = xmlBlocks(xml, "issuerAddress")[0] || "";
  const industry = xmlValue(xml, "industryGroupType");
  const fundType = xmlValue(xml, "investmentFundType");
  const totalOfferingAmount = xmlValue(xml, "totalOfferingAmount");
  const totalAmountSold = xmlValue(xml, "totalAmountSold");
  const filingUrl = filing.sourceUrl || "";
  const filedAt = filing.publishedAt || null;
  return xmlBlocks(xml, "relatedPersonInfo").flatMap((block, index) => {
    const nameBlock = xmlBlocks(block, "relatedPersonName")[0] || "";
    const firstName = xmlValue(nameBlock, "firstName");
    const middleName = xmlValue(nameBlock, "middleName");
    const lastName = xmlValue(nameBlock, "lastName");
    if (!firstName || /^n\/?a$/i.test(firstName) || /\b(?:llc|l\.l\.c\.|lp|l\.p\.|inc\.?|corp\.?|company|fund|partners?)\b/i.test(lastName)) return [];
    const name = [firstName, middleName, lastName].filter((part) => part && !/^n\/?a$/i.test(part)).join(" ").trim();
    if (!name || !/\s/.test(name)) return [];
    const addressBlock = xmlBlocks(block, "relatedPersonAddress")[0] || "";
    const relationships = xmlBlocks(block, "relationship").map((value) => clean(value)).filter(Boolean);
    const clarification = xmlValue(block, "relationshipClarification");
    const city = xmlValue(addressBlock, "city") || xmlValue(issuerAddress, "city");
    const state = xmlValue(addressBlock, "stateOrCountry") || xmlValue(issuerAddress, "stateOrCountry");
    const postalCode = xmlValue(addressBlock, "zipCode") || xmlValue(issuerAddress, "zipCode");
    const role = [...relationships, clarification].filter(Boolean).join(" · ") || "Related person";
    const offering = [industry, fundType, totalOfferingAmount && `Offering: ${totalOfferingAmount}`, totalAmountSold && `Sold: ${totalAmountSold}`].filter(Boolean).join(" · ");
    return [normalizeSignal("sec_form_d", {
      sourceId: `${filing.sourceId || hashId(filingUrl)}:${index}:${name}`,
      sourceUrl: filingUrl,
      title: `${name} — ${role} at ${issuer || "Form D issuer"}`,
      excerpt: [offering, [city, state, postalCode].filter(Boolean).join(", "), "Named in the filing's Related Persons section."].filter(Boolean).join(" · "),
      authorName: name,
      organizationName: issuer,
      publishedAt: filedAt,
      evidenceLabel: "SEC Form D related person",
      raw: { filingType: filing.filingType || "D", role, city, state, postalCode, industry, fundType, totalOfferingAmount, totalAmountSold },
    })].filter(Boolean);
  });
}

async function searchSecFormD(monitor, limit) {
  const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&company=&dateb=&owner=include&start=0&count=100&output=atom";
  const filings = (await fetchFeed(url, "sec_form_d", "SEC EDGAR Form D filing", 100))
    .filter((filing) => /^D(?:\/A)?\s+-/i.test(filing.title))
    .map((filing) => ({ ...filing, filingType: filing.title.match(/^(D(?:\/A)?)/i)?.[1] || "D" }))
    .slice(0, Math.min(40, Math.max(limit, 10)));
  const people = [];
  for (let offset = 0; offset < filings.length && people.length < limit; offset += 5) {
    const batch = filings.slice(offset, offset + 5);
    const responses = await Promise.allSettled(batch.map(async (filing) => {
      const parsed = new URL(filing.sourceUrl);
      const path = parsed.pathname.replace(/\/[^/]+-index\.htm$/i, "/primary_doc.xml");
      const response = await axios.get(`https://www.sec.gov${path}`, { timeout: REQUEST_TIMEOUT, responseType: "text", maxContentLength: 1024 * 1024, headers: { Accept: "application/xml,text/xml", "User-Agent": USER_AGENT } });
      return parseSecFormD(response.data, filing);
    }));
    people.push(...responses.flatMap((response) => response.status === "fulfilled" ? response.value : []));
    if (offset + 5 < filings.length && people.length < limit) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const relevant = people.filter((signal) => /real estate|commercial|multifamily|apartment|property|pooled investment fund|private equity fund|venture capital fund|hedge fund|investment fund/i.test(`${signal.organizationName} ${signal.excerpt}`));
  return (relevant.length ? relevant : people).slice(0, limit);
}

const DISCUSSION_PATH = /\/(?:topics?|threads?|discussions?|posts?)\//i;
const COMMUNITY_PATH = /\/(?:forums?|community|groups?)(?:\/|$)/i;

function htmlMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  return decodeEntities(patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "");
}

function publicPageLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  return [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => {
    try {
      const url = new URL(decodeEntities(match[1]), base);
      if (!/^https?:$/.test(url.protocol) || url.hostname !== base.hostname) return null;
      url.hash = "";
      return { url: url.toString(), label: decodeEntities(clean(match[2])) };
    } catch (_error) { return null; }
  }).filter(Boolean);
}

function relevanceScore(link, monitor) {
  const text = `${link.label} ${link.url}`.toLowerCase();
  const needles = termsFor(monitor, 12).flatMap((term) => term.toLowerCase().split(/\s+/)).filter((term) => term.length > 3);
  return needles.reduce((score, term) => score + (text.includes(term) ? 2 : 0), 0) + (DISCUSSION_PATH.test(link.url) ? 20 : 0);
}

function structuredDiscussion(html) {
  for (const match of String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) { queue.push(...item); continue; }
        const main = item.mainEntity && typeof item.mainEntity === "object" ? item.mainEntity : item;
        const types = [main["@type"], item["@type"]].flat().filter(Boolean);
        if (types.some((type) => ["DiscussionForumPosting", "Question", "QAPage"].includes(type)) && (main.articleBody || main.text || main.headline || main.name)) {
          return {
            title: main.headline || main.name || "",
            excerpt: main.articleBody || main.text || "",
            authorName: main.author?.name || item.author?.name || "",
            authorUrl: main.author?.url || item.author?.url || "",
            publishedAt: main.datePublished || main.dateCreated || item.datePublished || "",
          };
        }
        for (const value of Object.values(item)) if (value && typeof value === "object") queue.push(value);
      }
    } catch (_error) {}
  }
  return null;
}

async function crawlConfiguredSite(startUrl, monitor, limit) {
  const configuredUrl = new URL(startUrl);
  const socialPlatform = /(^|\.)linkedin\.com$/i.test(configuredUrl.hostname)
    ? "linkedin"
    : /(^|\.)facebook\.com$/i.test(configuredUrl.hostname)
      ? "facebook"
      : "";
  if (socialPlatform) {
    const slug = decodeURIComponent(configuredUrl.pathname.split("/").filter(Boolean).pop() || socialPlatform)
      .replace(/[-_]+/g, " ")
      .trim();
    const source = `${socialPlatform}_public`;
    const platformLabel = socialPlatform === "linkedin" ? "LinkedIn" : "Facebook";
    const seed = normalizeSignal("configured_community", {
      sourceId: configuredUrl.toString(),
      sourceUrl: configuredUrl.toString(),
      title: slug || `${platformLabel} public community`,
      excerpt: `User-added ${platformLabel} public group or page. Public indexed details are used; login-only posts are not accessed.`,
      organizationName: slug || `${platformLabel} community`,
      organizationDomain: configuredUrl.hostname.replace(/^www\./, ""),
      evidenceLabel: `User-added public ${platformLabel} community URL`,
      raw: { seedUrl: startUrl, accessMode: "public_web_index" },
    });
    const indexed = await searchIndexedSocialGroups(monitor, socialPlatform, limit).catch(() => []);
    return [seed, ...indexed.map((signal) => ({ ...signal, source }))].filter(Boolean).slice(0, limit);
  }
  let first;
  try { first = await fetchPublicPage(startUrl); }
  catch (error) {
    if (/not an HTML page/i.test(error.message || "")) return fetchFeed(startUrl, "configured_feed", "User-added public feed", limit);
    throw error;
  }
  if (first.blocked) throw new Error("The site blocks public crawling in robots.txt.");
  if (/^\s*<\?xml|<rss\b|<feed\b/i.test(first.html)) return extractXmlItems(first.html).slice(0, limit).map((item) => normalizeSignal("configured_feed", {
    sourceId: item.id || item.link, sourceUrl: item.link, title: item.title, excerpt: item.description,
    authorName: item.author, publishedAt: item.publishedAt, evidenceLabel: "User-added public feed",
  })).filter(Boolean);

  const links = publicPageLinks(first.html, first.url);
  let discussions = links.filter((link) => DISCUSSION_PATH.test(new URL(link.url).pathname));
  if (!discussions.length) {
    const hubs = [...new Map(links.filter((link) => COMMUNITY_PATH.test(new URL(link.url).pathname)).sort((a, b) => relevanceScore(b, monitor) - relevanceScore(a, monitor)).map((link) => [link.url, link])).values()].slice(0, 6);
    const hubPages = await Promise.allSettled(hubs.map((hub) => fetchPublicPage(hub.url)));
    discussions = hubPages.flatMap((result) => result.status === "fulfilled" && !result.value.blocked ? publicPageLinks(result.value.html, result.value.url) : []).filter((link) => DISCUSSION_PATH.test(new URL(link.url).pathname));
  }
  const targets = [...new Map(discussions.sort((a, b) => relevanceScore(b, monitor) - relevanceScore(a, monitor)).map((link) => [link.url, link])).values()].slice(0, Math.min(limit, 20));
  const pages = await Promise.allSettled(targets.map((target) => fetchPublicPage(target.url)));
  const host = new URL(first.url).hostname.replace(/^www\./, "");
  const signals = pages.flatMap((result, index) => {
    const target = targets[index];
    if (result.status !== "fulfilled" || result.value.blocked) return [];
    const html = result.value.html;
    const discussion = structuredDiscussion(html);
    const title = discussion?.title || htmlMeta(html, "og:title") || decodeEntities(clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])) || target.label;
    const excerpt = discussion?.excerpt || htmlMeta(html, "og:description") || htmlMeta(html, "description") || plainText(html).slice(0, 6000);
    return [normalizeSignal("configured_site", {
      sourceId: result.value.url, sourceUrl: result.value.url, title, excerpt,
      authorName: discussion?.authorName || htmlMeta(html, "author"), authorUrl: discussion?.authorUrl || "",
      organizationDomain: host, publishedAt: discussion?.publishedAt || htmlMeta(html, "article:published_time") || htmlMeta(html, "datePublished"),
      evidenceLabel: "User-added public community page", raw: { seedUrl: startUrl },
    })].filter(Boolean);
  });
  if (isCommunityPartnerMonitor(monitor)) {
    const title = htmlMeta(first.html, "og:title") || decodeEntities(clean(first.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])) || host;
    const excerpt = htmlMeta(first.html, "og:description") || htmlMeta(first.html, "description") || `Public community supplied by the user: ${host}`;
    signals.unshift(normalizeSignal("configured_community", {
      sourceId: first.url, sourceUrl: first.url, title, excerpt, organizationName: title,
      organizationDomain: host, evidenceLabel: "User-added public community homepage", raw: { seedUrl: startUrl },
    }));
  }
  return [...new Map(signals.filter(Boolean).map((signal) => [signal.sourceUrl, signal])).values()].slice(0, limit);
}

async function searchConfiguredFeeds(monitor, limit) {
  // BiggerPockets does not expose a dedicated feed consumed by this engine,
  // and its forum pages may require access controls. Preserve stored URLs but
  // do not crawl them directly; Bing remains the supported public index path.
  const urls = (monitor.feedUrls || []).filter(Boolean).filter((url) => {
    try { return !/(^|\.)biggerpockets\.com$/i.test(new URL(url).hostname); }
    catch (_error) { return false; }
  }).slice(0, 30);
  if (!urls.length) return [];
  const groups = [];
  for (let index = 0; index < urls.length; index += 3) {
    groups.push(...await Promise.allSettled(urls.slice(index, index + 3).map((url) => crawlConfiguredSite(url, monitor, limit))));
  }
  const signals = groups.flatMap((group) => group.status === "fulfilled" ? group.value : []);
  if (!signals.length && groups.some((group) => group.status === "rejected")) throw groups.find((group) => group.status === "rejected").reason;
  return [...new Map(signals.map((signal) => [signal.sourceUrl, signal])).values()].slice(0, limit * Math.max(1, urls.length));
}

async function searchCommunityDirectories(monitor, limit) {
  const directories = [
    "https://nationalreia.org/find-a-reia/",
    "https://reiclub.com/real-estate-clubs/",
    "https://dscrdirect.net/meetups",
  ];
  const results = await Promise.allSettled(directories.map((url) => crawlConfiguredSite(url, monitor, Math.min(10, limit))));
  return [...new Map(results.flatMap((result) => result.status === "fulfilled" ? result.value : []).map((signal) => [signal.sourceUrl, { ...signal, source: "community_directory" }])).values()].slice(0, limit);
}

function unwrapDuckDuckGoUrl(rawUrl) {
  try {
    const url = new URL(decodeEntities(rawUrl), "https://html.duckduckgo.com");
    return url.searchParams.get("uddg") || url.toString();
  } catch (_error) { return ""; }
}

async function searchDuckDuckGo(monitor, limit) {
  const response = await axios.get("https://html.duckduckgo.com/html/", {
    params: { q: booleanQueryFor(monitor) }, timeout: REQUEST_TIMEOUT, responseType: "text", maxContentLength: 4 * 1024 * 1024,
    headers: { Accept: "text/html", "User-Agent": USER_AGENT },
  });
  if (response.status !== 200 || /anomaly-modal|challenge-form|bots use duckduckgo/i.test(String(response.data || ""))) throw new Error("DuckDuckGo returned an automated-access challenge.");
  const matches = [...String(response.data || "").matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.slice(0, limit).map((match) => {
    const sourceUrl = unwrapDuckDuckGoUrl(match[1]);
    let domain = "";
    try { domain = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch (_error) {}
    return normalizeSignal("duckduckgo", { sourceId: sourceUrl, sourceUrl, title: match[2], organizationDomain: domain, evidenceLabel: "DuckDuckGo public search result" });
  }).filter(Boolean);
}

const ADAPTERS = {
  google_web: searchGoogleWeb,
  bing_web: searchBingWeb,
  bing_news: searchBingNews,
  linkedin_public: searchLinkedInPublic,
  facebook_public: searchFacebookPublic,
  meetup_public: searchMeetupPublic,
  community_directories: searchCommunityDirectories,
  gdelt: searchGdelt,
  sec_form_d: searchSecFormD,
  bluesky: searchBluesky,
  hacker_news: searchHackerNews,
  stack_exchange: searchStackExchange,
  reddit_rss: searchRedditRss,
  duckduckgo: searchDuckDuckGo,
};

async function collectMonitorSignals(monitor) {
  const limit = Math.min(100, Math.max(5, Number(monitor.maxResultsPerSource) || 25));
  const selected = monitor.sources?.length ? [...monitor.sources] : isCommunityPartnerMonitor(monitor) ? ["linkedin_public", "facebook_public", "meetup_public", "community_directories", "bing_web"] : ["bing_web", "reddit_rss"];
  if (!isCommunityPartnerMonitor(monitor)) {
    for (const source of ["linkedin_public", "facebook_public", "meetup_public", "community_directories"]) {
      const index = selected.indexOf(source); if (index >= 0) selected.splice(index, 1);
    }
  }
  if (monitor.monitorType === "buyer_intent") {
    const index = selected.indexOf("sec_form_d"); if (index >= 0) selected.splice(index, 1);
  }
  if (isCommunityPartnerMonitor(monitor) && !selected.includes("meetup_public")) selected.push("meetup_public");
  if (isCommunityPartnerMonitor(monitor) && !selected.includes("community_directories")) selected.push("community_directories");
  if (isCommunityPartnerMonitor(monitor) && !selected.includes("linkedin_public")) selected.push("linkedin_public");
  if (isCommunityPartnerMonitor(monitor) && !selected.includes("facebook_public")) selected.push("facebook_public");
  const work = selected.filter((source) => ADAPTERS[source]).map(async (source) => ({ source, signals: await ADAPTERS[source](monitor, limit) }));
  if ((monitor.feedUrls || []).length) work.push(searchConfiguredFeeds(monitor, limit).then((signals) => ({ source: "feeds", signals })));
  const settled = await Promise.allSettled(work);
  const sourceOrder = [...selected.filter((source) => ADAPTERS[source]), ...((monitor.feedUrls || []).length ? ["feeds"] : [])];
  const failures = settled.map((item, index) => ({ item, source: sourceOrder[index] || "feeds" })).filter(({ item }) => item.status === "rejected");
  return {
    groups: settled.filter((item) => item.status === "fulfilled").map((item) => item.value),
    errors: failures.map(({ item, source }) => `${source}: ${item.reason?.response?.status || item.reason?.message || "source failed"}`),
    failures: failures.map(({ item, source }) => {
      const status = item.reason?.response?.status;
      const providerMessage = item.reason?.response?.data?.error?.message || item.reason?.response?.data?.message;
      const message = String(providerMessage || item.reason?.message || status || "Source failed");
      return { source, message, state: status === 429 ? "rate_limited" : status === 401 || status === 403 || /challenge|blocked|forbidden|403/i.test(message) ? "blocked" : "failed", retryAt: item.reason?.retryAt || null };
    }),
  };
}

module.exports = { bingQueriesFor, booleanQueryFor, canonicalSourceUrl, collectMonitorSignals, crawlConfiguredSite, explicitOrganizerCandidates, extractXmlItems, fetchRedditSearchJson, indexedPostDate, isBiggerPocketsForumTopicUrl, isCommunityPartnerMonitor, isInvestorProfileMonitor, normalizeSignal, parseSecFormD, queryFor, redditQueryChunks, roundRobinSignals, searchBingWeb, searchConfiguredFeeds, searchMeetupPublic, searchRedditRss, resetRedditPublicState, termsFor };
