/**
 * Trust categories: named dimensions (URL, CHANNEL, DIR) that classify
 * a key value as TRUSTED or UNTRUSTED via a per-category list and
 * default mode.
 *
 * Each category runs in one of two modes:
 *   - "allowlist"  → default UNTRUSTED; keys matching `list` are TRUSTED
 *   - "blocklist"  → default TRUSTED;   keys matching `list` are UNTRUSTED
 *
 * Category-specific matching logic (URL hostname/path, channel
 * "platform:id" patterns with wildcards, filesystem path prefixes)
 * lives here so adding a new category is a one-file change.
 *
 * Adding a new category:
 *   1. implement createXTrustCategory({ mode, list, basePath? }) below,
 *      returning a TrustCategory.
 *   2. wire it into createPolicyEngine() in policy-engine.ts.
 *   3. write tool schemas that reference its id via
 *      { category: "X", role: "key" | "data", ... }.
 */

import { isAbsolute, resolve, sep } from "node:path";

export type Trust = "TRUSTED" | "UNTRUSTED";
export type ListMode = "allowlist" | "blocklist";

/** Public interface: a classifier from key value → Trust. */
export interface TrustCategory {
  id: string;
  mode: ListMode;
  /** Number of entries in the list (for logging). */
  listSize: number;
  /** Classify a raw key value. Null/undefined/empty keys take the
   * category's default (= the inverse of its list mode's hit). */
  classify(key: string | null | undefined): Trust;
}

function defaultTrust(mode: ListMode): Trust {
  return mode === "allowlist" ? "UNTRUSTED" : "TRUSTED";
}
function hitTrust(mode: ListMode): Trust {
  return mode === "allowlist" ? "TRUSTED" : "UNTRUSTED";
}

// ─── URL category ────────────────────────────────────────────────────────
//
// Key format: absolute URL. List entries are hostname/path patterns:
//   "example.com"           — exact hostname, any path
//   "*.example.com"         — wildcard subdomain
//   "api.github.com/repos"  — hostname + path prefix
// Matching is case-insensitive on hostname.

interface ParsedUrlPattern {
  wildcardSuffix?: string;  // ".example.com"
  hostname: string;
  pathPrefix: string;
}

function parseUrlPattern(pattern: string): ParsedUrlPattern {
  const norm = pattern.toLowerCase();
  if (norm.startsWith("*.")) {
    return { wildcardSuffix: norm.slice(1), hostname: "", pathPrefix: "/" };
  }
  const slash = norm.indexOf("/");
  if (slash === -1) return { hostname: norm, pathPrefix: "/" };
  return { hostname: norm.slice(0, slash), pathPrefix: norm.slice(slash) };
}

function urlMatches(url: string, patterns: ParsedUrlPattern[]): boolean {
  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return false;
  }
  for (const p of patterns) {
    if (p.wildcardSuffix) {
      if (hostname.endsWith(p.wildcardSuffix) || hostname === p.wildcardSuffix.slice(1)) {
        return true;
      }
      continue;
    }
    if (hostname !== p.hostname) continue;
    if (pathname.startsWith(p.pathPrefix)) return true;
  }
  return false;
}

export function createUrlTrustCategory(opts: { mode: ListMode; list: string[] }): TrustCategory {
  const patterns = opts.list.map(parseUrlPattern);
  const def = defaultTrust(opts.mode);
  const hit = hitTrust(opts.mode);
  return {
    id: "URL",
    mode: opts.mode,
    listSize: opts.list.length,
    classify(key) {
      if (!key) return def;
      return urlMatches(key, patterns) ? hit : def;
    },
  };
}

// ─── Channel category ────────────────────────────────────────────────────
//
// Key format: a channel identifier, with or without the "platform:" prefix
// (e.g. "discord:123456", "agent:bot:telegram:some-chat", or just
// "123456"). List entries:
//   "discord:123456"  — exact (substring) match on the id portion
//   "telegram:*"      — wildcard: any key containing "telegram:"
// Matching is case-insensitive.

interface ChannelMatcher {
  exactIds: string[];          // ["123456", ...]
  platformWildcards: string[]; // ["telegram", ...]
}

function buildChannelMatcher(list: string[]): ChannelMatcher {
  const exactIds: string[] = [];
  const platformWildcards: string[] = [];
  for (const pattern of list) {
    const colon = pattern.indexOf(":");
    if (colon > 0 && pattern.slice(colon + 1) === "*") {
      platformWildcards.push(pattern.slice(0, colon).toLowerCase());
    } else if (colon > 0) {
      exactIds.push(pattern.slice(colon + 1).toLowerCase());
    } else {
      exactIds.push(pattern.toLowerCase());
    }
  }
  return { exactIds, platformWildcards };
}

function channelMatches(key: string, m: ChannelMatcher): boolean {
  const lower = key.toLowerCase();
  if (m.platformWildcards.some((p) => lower.includes(p + ":"))) return true;
  if (m.exactIds.some((id) => lower.includes(id))) return true;
  return false;
}

export function createChannelTrustCategory(opts: { mode: ListMode; list: string[] }): TrustCategory {
  const matcher = buildChannelMatcher(opts.list);
  const def = defaultTrust(opts.mode);
  const hit = hitTrust(opts.mode);
  return {
    id: "CHANNEL",
    mode: opts.mode,
    listSize: opts.list.length,
    classify(key) {
      if (!key) return def;
      return channelMatches(key, matcher) ? hit : def;
    },
  };
}

// ─── Dir category ────────────────────────────────────────────────────────
//
// Key format: an absolute or relative filesystem path. List entries are
// directory or file paths; entries ending in `/*` are treated as directory
// containment shorthand. A key matches if its resolved absolute path equals a
// listed entry (exact file match) or lies inside a listed directory
// (containment match). POSIX-sensitive.

function stripTrailingDirWildcard(dir: string): string {
  if (dir.endsWith("/*") || dir.endsWith("\\*")) return dir.slice(0, -2);
  return dir;
}

function normalizeDir(dir: string, basePath: string): string {
  const pattern = stripTrailingDirWildcard(dir);
  const abs = isAbsolute(pattern) ? pattern : resolve(basePath, pattern);
  return abs.endsWith(sep) ? abs.slice(0, -sep.length) : abs;
}

export function createDirTrustCategory(opts: {
  mode: ListMode;
  list: string[];
  basePath?: string;
}): TrustCategory {
  // Normalize list entries once at creation against the supplied basePath
  // (or cwd at init time) so relative entries from a YAML policy resolve
  // against the policy file directory.
  const base = opts.basePath ?? process.cwd();
  const dirs = opts.list
    .filter((d) => typeof d === "string" && d.length > 0)
    .map((d) => normalizeDir(d, base));
  const def = defaultTrust(opts.mode);
  const hit = hitTrust(opts.mode);
  return {
    id: "DIR",
    mode: opts.mode,
    listSize: opts.list.length,
    classify(key) {
      if (!key) return def;
      // Relative `key` values arrive at eval time from tool params (e.g.
      // the LLM passes `inbox/email_01.txt` to `read`). They must be
      // resolved against the current cwd, NOT the captured `base`:
      // OpenClaw `process.chdir`s into the agent workspace before firing
      // tool hooks (see pi-embedded-runner/run/attempt.ts), so the current
      // cwd is the root the `read` tool itself resolves against.
      const abs = isAbsolute(key) ? key : resolve(process.cwd(), key);
      for (const dir of dirs) {
        if (abs === dir) return hit;
        if (abs.startsWith(dir + sep)) return hit;
      }
      return def;
    },
  };
}
