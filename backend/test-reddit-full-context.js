// Regression coverage for the Reddit quality fix: multiple focused searches instead of one
// broad keyword-joined query, and full post context (title + selftext) instead of a truncated
// RSS excerpt.
const assert = require("node:assert/strict");
const sources = require("./services/intentSourceService");

function run() {
  // Multiple focused searches: a monitor with many keywords must be split into several small
  // chunks, not one giant OR-joined query.
  const bigMonitor = { keywords: ["landlord", "rental property owner", "duplex investor", "triplex", "fourplex", "Airbnb investor", "scale my portfolio", "underwriting multifamily"], locations: [] };
  const chunks = sources.redditQueryChunks(bigMonitor);
  assert.ok(chunks.length > 1, "many keywords must produce multiple focused queries, not one broad query");
  assert.ok(chunks.every((chunk) => chunk.split(" OR ").length <= 2), "each focused query must stay small and specific");

  // A single-keyword monitor still produces exactly one query (matches prior single-query behavior).
  const smallMonitor = { keywords: ["underwriting help"], locations: [] };
  assert.deepEqual(sources.redditQueryChunks(smallMonitor), ['"underwriting help"']);

  // Full post context: fetchRedditSearchJson must use the post's selftext, not just its title,
  // and must expose subreddit/comment-count evidence for downstream quality filtering.
  const originalGet = require("axios").get;
  require("axios").get = async () => ({
    data: {
      data: {
        children: [{
          data: {
            id: "abc123",
            permalink: "/r/realestateinvesting/comments/abc123/need_help_underwriting_my_first_deal/",
            title: "Need help underwriting my first deal",
            selftext: "I'm looking at a 12-unit apartment building and I'm overwhelmed by the underwriting. Cap rate looks like 6.2% but I'm not sure how to model debt service. Has anyone worked with a multifamily coach who could help me get this right before I submit an LOI?",
            author: "throwaway_investor",
            created_utc: Math.floor(Date.now() / 1000),
            subreddit: "realestateinvesting",
            num_comments: 14,
            over_18: false,
            is_self: true,
            score: 22,
          },
        }],
      },
    },
  });
  return sources.fetchRedditSearchJson("https://www.reddit.com/search.json?q=test", "reddit_rss", "Public Reddit search (full post context)", 10)
    .then((results) => {
      assert.equal(results.length, 1);
      const [signal] = results;
      assert.equal(signal.sourceUrl, "https://www.reddit.com/r/realestateinvesting/comments/abc123/need_help_underwriting_my_first_deal");
      assert.match(signal.excerpt, /overwhelmed by the underwriting/, "excerpt must include the full post body, not just the title");
      assert.match(signal.excerpt, /submit an LOI/, "excerpt must retain the full permitted post context");
      assert.equal(signal.authorName, "u/throwaway_investor");
      assert.equal(signal.raw.subreddit, "realestateinvesting");
      assert.equal(signal.raw.numComments, 14);
    })
    .finally(() => { require("axios").get = originalGet; });
}

run()
  .then(() => console.log("Reddit quality fix: multi-query chunking and full post-context retrieval both passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
