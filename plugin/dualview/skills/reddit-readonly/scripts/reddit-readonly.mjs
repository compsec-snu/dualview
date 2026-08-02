#!/usr/bin/env node
/**
 * reddit-readonly — fetch posts from public Reddit JSON API.
 *
 * Usage:
 *   node reddit-readonly.mjs posts <subreddit> [--sort <sort>] [--time <time>] [--limit <n>]
 *
 * Output: JSON { ok, data, error } envelope on stdout.
 */

const args = process.argv.slice(2);
const command = args[0];
const subreddit = args[1];

if (!command || !subreddit) {
  console.log(JSON.stringify({
    ok: false,
    error: { message: "Usage: reddit-readonly.mjs <command> <subreddit> [options]", details: "" },
  }));
  process.exit(0);
}

function parseFlag(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const sort = parseFlag("--sort", "hot");
const time = parseFlag("--time", "week");
const limit = parseInt(parseFlag("--limit", "25"), 10);

async function fetchPosts() {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}/.json?t=${time}&limit=${limit}&raw_json=1`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "reddit-readonly/1.0 (skill)" },
  });
  if (!resp.ok) {
    return {
      ok: false,
      error: { message: `Reddit API error: ${resp.status}`, details: await resp.text() },
    };
  }
  const listing = await resp.json();
  const children = listing?.data?.children ?? [];
  const posts = children.map((c) => {
    const d = c.data;
    return {
      id: d.id,
      fullname: d.name,
      subreddit: d.subreddit,
      title: d.title,
      author: d.author,
      score: d.score,
      num_comments: d.num_comments,
      created_utc: d.created_utc,
      created_iso: new Date(d.created_utc * 1000).toISOString(),
      permalink: `https://www.reddit.com${d.permalink}`,
      url: d.url,
      is_self: d.is_self,
      over_18: d.over_18,
      flair: d.link_flair_text ?? null,
      selftext_snippet: (d.selftext || "").slice(0, 300),
    };
  });
  return {
    ok: true,
    data: {
      subreddit,
      sort,
      time,
      limit,
      after: listing.data?.after ?? null,
      before: listing.data?.before ?? null,
      posts,
    },
  };
}

try {
  const result = await fetchPosts();
  console.log(JSON.stringify(result));
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    error: { message: err.message, details: String(err) },
  }));
}
