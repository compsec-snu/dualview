/**
 * Per-command inbound classification for the `exec` tool.
 *
 * Refines the blanket `TOOL_INBOUND_SPEC.exec.schema = "UNTRUSTED"` baseline
 * for skills whose stdout is a well-known JSON shape. When the canonical
 * ExecCommandId matches an entry here, DualView walks the parsed stdout with
 * a per-field SchemaNode instead of blanket-symbolizing the whole output.
 * If the id is unknown OR stdout fails to parse as JSON, the existing
 * baseline kicks in (blanket symbolize) — fail-closed by construction: no
 * code path can leak raw exec stdout into the agent context.
 *
 * Phase 1 scope
 * -------------
 * Only ship entries whose per-field trust map is **derived from observed
 * skill source**, never guessed. The library currently holds one verified
 * skill; adding more is a pattern of: (1) read the skill source, (2) list
 * every stdout field with its rationale, (3) add a single object-literal
 * entry here.
 *
 * Adding a new skill
 * ------------------
 *   EXEC_RESULT_TRUST_ENTRIES["my-skill.mjs"] = {
 *     aliases: ["my-skill-fork.mjs"],  // optional — fork/rename compat
 *     schema: { safeField: "TRUSTED", userContent: "UNTRUSTED" },
 *   };
 *
 * The primary key is the canonical ExecCommandId (typically the script
 * basename — e.g. "reddit-readonly.mjs"). Aliases resolve to the same
 * spec via the reverse index built at module load; collisions throw.
 *
 * Scope: concrete exec only. Symbolic exec (RESTRICTED=1) is handled by
 * the existing `exec_sym` promotion path; `classifyExecOutput` returns null
 * for that case and is invisible to that flow.
 */

import type { SchemaNode } from "./schema-types.js";
import { isSymbolicExec, normalizeExecCommand } from "./exec-identifier.js";
import type { CommandEntryConfig } from "./load-policy.js";

export interface ExecOutputSpec {
  /**
   * Alternative canonical ids that resolve to this spec. Use for skill
   * renames, forks, or alternate packaging (e.g. `.mjs` vs `.js`) so one
   * schema covers every filename the agent may end up invoking. Aliases
   * must not collide with any other entry's primary key or aliases -- the
   * reverse-index builder throws on collision at module load.
   */
  aliases?: readonly string[];

  /**
   * Per-field schema applied to parsed JSON stdout via applyInboundSchema.
   * Literal "TRUSTED" leaves pass through raw; "UNTRUSTED" leaves and any
   * string fields not listed in the schema are symbolized (the walker is
   * deny-by-default for unlisted string fields). Nested objects and
   * `__items` arrays are supported; SchemaNode also accepts
   * category/role/keyField markers for phases that want URL/CHANNEL-style
   * keyed classification on exec output fields.
   *
   * Mutually exclusive with `subcommands`. If `subcommands` is set, this
   * field is ignored (the matched subcommand's schema is used instead).
   */
  schema?: SchemaNode;

  /**
   * Treat error outputs as TRUSTED: non-zero exit code (OpenClaw appends
   * "(Command exited with code N)") and JSON responses with an `error`
   * envelope. The agent needs to read these to fix the command.
   */
  trustErrors?: boolean;

  /**
   * Treat non-JSON plain text output as TRUSTED (e.g. --help, usage text).
   * The agent needs to read these to learn CLI usage.
   */
  trustHelp?: boolean;

  /**
   * Per-subcommand dispatch for multi-modal CLIs (e.g. gws, git).
   *
   * Keys are space-joined arg prefixes matched against the script-relative
   * args from `normalizeExecCommand`. Lookup tries the longest matching
   * prefix first, so "gmail users messages get" wins over "gmail" when
   * both are present.
   *
   * After matching a prefix, the remaining args are validated:
   * - Shell operators (`&&`, `||`, `|`, `;`) reject the match entirely
   * - Only flags listed in `allowedFlags` are accepted; unknown flags
   *   or bare positional args reject the match
   *
   * If no subcommand matches or validation fails, falls through to the
   * baseline full-wrap UNTRUSTED.
   */
  subcommands?: Record<string, ExecSubcommandSpec>;
}

export interface ExecSubcommandSpec extends ExecOutputSpec {
  /**
   * Flags allowed after the subcommand prefix. Any flag not in this set
   * causes the match to be rejected. Flag values (the token after a flag)
   * are always allowed regardless.
   *
   * Example: ["--format", "--params", "--max", "--query"]
   */
  allowedFlags?: readonly string[];
}

// ─── Per-skill schemas ──────────────────────────────────────────────────────

/**
 * Schema for a normalised Reddit post as emitted by `reddit-readonly.mjs`.
 * Field names + rationale are pinned to the `normalisePost` function in
 * the upstream skill source (clawhub.ai/buksan1950/reddit-readonly, file
 * `scripts/reddit-readonly.mjs`). When that skill changes shape, update
 * this schema alongside.
 *
 * Trust rationale per field:
 *   id, fullname         — Reddit-issued token (`abc123`, `t3_abc123`)
 *   subreddit            — Reddit-enforced charset
 *   author               — Reddit username (alphanumeric + `-_`, 3-20 chars)
 *   score, num_comments  — integers
 *   created_utc          — integer epoch
 *   created_iso          — script-constructed ISO string
 *   permalink            — script-constructed from Reddit's path component
 *   is_self, over_18     — booleans
 *
 *   title                — **author-written** post title (injection surface)
 *   url                  — arbitrary external URL the author linked to
 *                          (attacker-chosen destination; can itself carry
 *                           prompt payloads inside querystrings/fragments)
 *   flair                — author- or mod-settable short tag (freeform)
 *   selftext_snippet     — author-written post body
 */
const REDDIT_POST_ITEM: SchemaNode = {
  id:               "TRUSTED",
  fullname:         "TRUSTED",
  subreddit:        "TRUSTED",
  author:           "TRUSTED",
  score:            "TRUSTED",
  num_comments:     "TRUSTED",
  created_utc:      "TRUSTED",
  created_iso:      "TRUSTED",
  permalink:        "TRUSTED",
  is_self:          "TRUSTED",
  over_18:          "TRUSTED",
  title:            "UNTRUSTED",
  url:              "UNTRUSTED",
  flair:            "UNTRUSTED",
  selftext_snippet: "UNTRUSTED",
  // `cmdFind` enriches posts with these two before returning. Listed here
  // so the union post-item schema covers both the plain and find-extended
  // shapes in a single walk.
  reason:           { __items: "TRUSTED" }, // script-generated ["query:foo", ...]
  match_score:      "TRUSTED",
};

/**
 * Union schema for comment-shaped items across `cmdComments`, `cmdThread`,
 * and `cmdRecentComments`. The first two emit `normaliseComment` items
 * (tree-flattened with depth/parent_fullname); the third emits inline
 * items that additionally carry link_* fields. Listing every possible key
 * here is safe — the walker only visits keys present on each actual value.
 */
const REDDIT_COMMENT_ITEM: SchemaNode = {
  id:              "TRUSTED",
  fullname:        "TRUSTED",
  author:          "TRUSTED",
  score:           "TRUSTED",
  created_utc:     "TRUSTED",
  created_iso:     "TRUSTED",
  depth:           "TRUSTED",
  parent_fullname: "TRUSTED",
  permalink:       "TRUSTED",
  subreddit:       "TRUSTED", // recent-comments only
  link_id:         "TRUSTED", // recent-comments only
  link_permalink:  "TRUSTED", // recent-comments only
  link_title:      "UNTRUSTED", // author-written post title (recent-comments)
  body_snippet:    "UNTRUSTED", // author-written comment body
};

/**
 * Union schema for `data.*` across every reddit-readonly subcommand.
 * Each field is populated by a subset of subcommands; deny-by-default in
 * the walker handles any field we didn't list.
 */
const REDDIT_DATA: SchemaNode = {
  // Metadata shared across subcommands
  subreddit: "TRUSTED",
  sort:      "TRUSTED",
  time:      "TRUSTED",
  limit:     "TRUSTED",
  after:     "TRUSTED", // Reddit listing cursor (`t3_abc123`)
  before:    "TRUSTED",

  // cmdSearch
  scope: "TRUSTED",
  query: "TRUSTED", // agent-supplied literal, not remote content

  // cmdComments / cmdThread
  post_id:              "TRUSTED",
  max_depth:            "TRUSTED",
  include_deleted:      "TRUSTED",
  max_chars:            "TRUSTED",
  more_count_estimate:  "TRUSTED",

  // Array payloads — subcommand-dependent
  posts:    { __items: REDDIT_POST_ITEM },
  comments: { __items: REDDIT_COMMENT_ITEM },

  // cmdThread
  post: REDDIT_POST_ITEM,

  // cmdFind
  criteria: {
    subreddits:        { __items: "TRUSTED" },
    query:             "TRUSTED",
    include:           { __items: "TRUSTED" },
    exclude:           { __items: "TRUSTED" },
    minScore:          "TRUSTED",
    maxAgeHours:       "TRUSTED",
    perSubredditLimit: "TRUSTED",
    maxResults:        "TRUSTED",
    rank:              "TRUSTED",
  },
  meta: {
    // fetched_per_subreddit is a dynamic {subreddit: count} dict — all
    // values are integers so the walker's non-string passthrough at
    // applyInboundSchema() line ~467 leaves them untouched. Listed as
    // an empty object so the walker doesn't recurse into literals.
    fetched_per_subreddit: {},
    candidates: "TRUSTED",
    returned:   "TRUSTED",
  },
  results: { __items: REDDIT_POST_ITEM },
};

/**
 * Top-level envelope for every reddit-readonly.mjs invocation.
 * Source: `ok()` / error path at script top (lines 79, 9-34 of SKILL.md).
 *
 * Success:  { ok: true,  data: { ... } }
 * Failure:  { ok: false, error: { message, details } }
 *
 * `error.message` and `error.details` are script-generated strings, but
 * the error path can wrap upstream fetch failures whose body text is
 * technically remote. Conservative: mark both UNTRUSTED.
 */
const REDDIT_READONLY_SCHEMA: SchemaNode = {
  ok:   "TRUSTED",
  data: REDDIT_DATA,
  error: {
    message: "UNTRUSTED",
    details: "UNTRUSTED",
  },
};

// ─── gws (Google Workspace CLI) schemas ─────────────────────────────────────
// Verified against: real `gws` CLI output (v0.x, 2026-04-06).
// gws is multi-modal: each subcommand returns a different JSON shape.
// Per-subcommand dispatch matches on the longest arg prefix.

/**
 * `gws gmail +triage` -- unread inbox summary.
 *
 * Trust rationale:
 *   query, resultSizeEstimate  -- agent-supplied / Gmail metadata
 *   messages[].id              -- Gmail-generated message ID
 *   messages[].date            -- SMTP Date header (RFC 2822, set by sending MTA)
 *   messages[].from            -- UNTRUSTED: display name is sender-controlled
 *                                 (e.g. "Your Bank" <phish@evil.com>)
 *   messages[].subject         -- UNTRUSTED: sender-written, primary injection vector
 */
const GWS_GMAIL_TRIAGE_SCHEMA: SchemaNode = {
  query:              "TRUSTED",
  resultSizeEstimate: "TRUSTED",
  messages: { __items: {
    id:      "TRUSTED",
    date:    "TRUSTED",
    from:    "UNTRUSTED",
    subject: "UNTRUSTED",
  }},
};

/**
 * `gws gmail users messages list` -- message ID listing.
 * All fields are Gmail-generated IDs and pagination metadata.
 */
const GWS_GMAIL_LIST_SCHEMA: SchemaNode = {
  messages: { __items: {
    id:       "TRUSTED",
    threadId: "TRUSTED",
  }},
  nextPageToken:      "TRUSTED",
  resultSizeEstimate: "TRUSTED",
};

/**
 * `gws gmail users messages get` -- single message content.
 *
 * Trust rationale:
 *   id, threadId, historyId, internalDate, labelIds, sizeEstimate -- Gmail metadata
 *   snippet      -- UNTRUSTED: extracted from email body, sender-written
 *   payload      -- UNTRUSTED: contains headers (Subject, From display name)
 *                   and body parts. We can't do per-header-name dispatch in
 *                   the current SchemaNode model, so conservatively mark the
 *                   entire payload as UNTRUSTED.
 */
const GWS_GMAIL_MESSAGE_GET_SCHEMA: SchemaNode = {
  id:           "TRUSTED",
  threadId:     "TRUSTED",
  historyId:    "TRUSTED",
  internalDate: "TRUSTED",
  labelIds:     { __items: "TRUSTED" },
  sizeEstimate: "TRUSTED",
  snippet:      "UNTRUSTED",
  payload:      "UNTRUSTED",
};

/**
 * `gws calendar +agenda` -- upcoming events.
 *
 * Trust rationale:
 *   count, timeMin, timeMax       -- query metadata
 *   events[].calendar             -- calendar name, set by calendar owner
 *   events[].start, events[].end  -- ISO 8601 timestamps, structurally constrained
 *   events[].summary              -- UNTRUSTED: on shared calendars, other users
 *                                    can create events with arbitrary titles
 *   events[].location             -- UNTRUSTED: freeform text, attacker-settable
 *                                    on shared calendars
 */
const GWS_CALENDAR_AGENDA_SCHEMA: SchemaNode = {
  count:   "TRUSTED",
  timeMin: "TRUSTED",
  timeMax: "TRUSTED",
  events: { __items: {
    calendar: "TRUSTED",
    start:    "TRUSTED",
    end:      "TRUSTED",
    summary:  "UNTRUSTED",
    location: "UNTRUSTED",
  }},
};

/**
 * `gws drive files list` -- file listing.
 *
 * Trust rationale:
 *   files[].id, mimeType, modifiedTime, size -- Drive-generated metadata
 *   files[].name          -- UNTRUSTED: on shared drives, collaborators can
 *                            set file names to arbitrary strings
 *   files[].owners[].displayName -- UNTRUSTED: Google account display name,
 *                                   user-settable
 *   files[].owners[].emailAddress -- TRUSTED: Google-enforced email
 *   incompleteSearch, kind, nextPageToken -- Drive metadata
 */
const GWS_DRIVE_LIST_SCHEMA: SchemaNode = {
  files: { __items: {
    id:           "TRUSTED",
    kind:         "TRUSTED",
    mimeType:     "TRUSTED",
    modifiedTime: "TRUSTED",
    size:         "TRUSTED",
    name:         "UNTRUSTED",
    owners: { __items: {
      displayName:  "UNTRUSTED",
      emailAddress: "TRUSTED",
      kind:         "TRUSTED",
      me:           "TRUSTED",
      permissionId: "TRUSTED",
    }},
  }},
  incompleteSearch: "TRUSTED",
  kind:             "TRUSTED",
  nextPageToken:    "TRUSTED",
};

// ─── Library ────────────────────────────────────────────────────────────────

/**
 * Primary library: canonical ExecCommandId -> ExecOutputSpec.
 *
 * Each entry is keyed by the canonical script basename and MUST be derived
 * from the real skill source or observed CLI output. Follow-up issues track
 * verification work for additional skills (arxiv, git, pdflatex, ...) --
 * they stay at the UNTRUSTED exec baseline until their shapes are pinned.
 */
export const EXEC_RESULT_TRUST_ENTRIES: Record<string, ExecOutputSpec> = {
  // ClawHub reddit-readonly skill -- JSON-emitting read-only Reddit browser.
  // Verified against:
  //   ~/workspace/skills/reddit-readonly/scripts/reddit-readonly.mjs
  //   (normalisePost, normaliseComment, cmd* handlers, ok() envelope)
  "reddit-readonly.mjs": {
    schema: REDDIT_READONLY_SCHEMA,
  },

  // Google Workspace CLI -- multi-modal, per-subcommand dispatch.
  // Verified against: real gws CLI output (2026-04-06).
  "gws": {
    trustErrors: true,
    trustHelp: true,
    subcommands: {
      "gmail +triage": {
        schema: GWS_GMAIL_TRIAGE_SCHEMA,
        allowedFlags: ["--format", "--max", "--query", "--labels", "--dry-run", "--sanitize"],
      },
      "gmail users messages list": {
        schema: GWS_GMAIL_LIST_SCHEMA,
        allowedFlags: ["--format", "--params", "--dry-run", "--page-all", "--page-limit", "--page-delay", "--sanitize"],
      },
      "gmail users messages get": {
        schema: GWS_GMAIL_MESSAGE_GET_SCHEMA,
        allowedFlags: ["--format", "--params", "--dry-run", "-o", "--output", "--sanitize"],
      },
      "calendar +agenda": {
        schema: GWS_CALENDAR_AGENDA_SCHEMA,
        allowedFlags: ["--format", "--today", "--tomorrow", "--week", "--days", "--calendar", "--timezone", "--dry-run", "--sanitize"],
      },
      "drive files list": {
        schema: GWS_DRIVE_LIST_SCHEMA,
        allowedFlags: ["--format", "--params", "--dry-run", "--page-all", "--page-limit", "--page-delay", "--sanitize"],
      },
    },
  },
};

/**
 * Build a reverse index: canonical id AND every alias map to the owning spec.
 * Throws on collision so the library can't silently have two entries for the
 * same id.
 */
function buildIndex(entries: Record<string, ExecOutputSpec>): Record<string, ExecOutputSpec> {
  const idx: Record<string, ExecOutputSpec> = {};
  for (const [canonical, spec] of Object.entries(entries)) {
    if (canonical in idx) {
      throw new Error(`[exec-inbound] duplicate canonical id: ${canonical}`);
    }
    idx[canonical] = spec;
    for (const alias of spec.aliases ?? []) {
      if (alias in idx) {
        throw new Error(
          `[exec-inbound] alias collision: ${alias} (from ${canonical}) already indexed`,
        );
      }
      idx[alias] = spec;
    }
  }
  return idx;
}

let EXEC_RESULT_TRUST_INDEX = buildIndex(EXEC_RESULT_TRUST_ENTRIES);

/** @internal Reverse index — exported for tests only. */
export function _execResultTrustIndexForTests(): Readonly<Record<string, ExecOutputSpec>> {
  return EXEC_RESULT_TRUST_INDEX;
}

// ─── YAML override merge ────────────────────────────────────────────────────

interface MergeLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Walk a SchemaNode and collect all leaf trust values.
 */
function collectLeafTrust(node: SchemaNode): Set<string> {
  const result = new Set<string>();
  if (node === "TRUSTED" || node === "UNTRUSTED") {
    result.add(node);
    return result;
  }
  if (typeof node === "object" && node !== null) {
    if ("__items" in node) {
      for (const v of collectLeafTrust((node as { __items: SchemaNode }).__items)) result.add(v);
    } else if (!("role" in node)) {
      for (const v of Object.values(node as Record<string, SchemaNode>)) {
        for (const t of collectLeafTrust(v)) result.add(t);
      }
    }
  }
  return result;
}

/**
 * Collect leaf trust values as a flat map: dotted path -> "TRUSTED" | "UNTRUSTED".
 */
function collectLeafPaths(node: SchemaNode, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (node === "TRUSTED" || node === "UNTRUSTED") {
    result.set(prefix || "_root", node);
    return result;
  }
  if (typeof node === "object" && node !== null) {
    if ("__items" in node) {
      for (const [k, v] of collectLeafPaths((node as { __items: SchemaNode }).__items, prefix + "[]")) {
        result.set(k, v);
      }
    } else if (!("role" in node)) {
      for (const [key, val] of Object.entries(node as Record<string, SchemaNode>)) {
        for (const [k, v] of collectLeafPaths(val, prefix ? `${prefix}.${key}` : key)) {
          result.set(k, v);
        }
      }
    }
  }
  return result;
}

/**
 * Check if an override schema is more permissive than the existing one.
 * Returns true if the override marks any field TRUSTED that was UNTRUSTED
 * in the original.
 */
function isMorePermissive(
  original: SchemaNode | undefined,
  override: SchemaNode,
): boolean {
  if (!original) return false;
  const origPaths = collectLeafPaths(original);
  const overPaths = collectLeafPaths(override);
  for (const [path, trust] of overPaths) {
    if (trust === "TRUSTED" && origPaths.get(path) === "UNTRUSTED") return true;
  }
  return false;
}

/**
 * Merge YAML command overrides into the static exec spec library.
 * Operator YAML wins over static entries. Logs audit warnings when
 * overrides loosen trust (mark UNTRUSTED fields as TRUSTED).
 *
 * Called from createPolicyEngine after YAML parsing.
 */
export function mergeCommandOverrides(
  overrides: CommandEntryConfig[],
  log: MergeLogger,
): void {
  for (const entry of overrides) {
    if (!entry.id) {
      log.warn(`[DualView] policy: skipping command override with empty id`);
      continue;
    }
    if (entry.id === "*") {
      log.warn(
        `[DualView] policy: wildcard command entry "*" registered — ` +
        `trustErrors=${entry.trustErrors ?? false}, trustHelp=${entry.trustHelp ?? false} ` +
        `apply to every exec command not otherwise classified. ` +
        `schema/subcommands on the wildcard are ignored.`,
      );
    }
    const existing = EXEC_RESULT_TRUST_ENTRIES[entry.id];

    // Check permissiveness before overriding
    if (existing && entry.schema) {
      if (isMorePermissive(existing.schema, entry.schema as SchemaNode)) {
        log.warn(
          `[DualView] policy: command override for "${entry.id}" is more permissive than built-in ` +
          `(marks UNTRUSTED fields as TRUSTED)`,
        );
      }
    }

    const spec: ExecOutputSpec = {
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(entry.schema ? { schema: entry.schema as SchemaNode } : {}),
      ...(entry.trustErrors !== undefined ? { trustErrors: entry.trustErrors } : {}),
      ...(entry.trustHelp !== undefined ? { trustHelp: entry.trustHelp } : {}),
    };

    if (entry.subcommands) {
      const subs: Record<string, ExecSubcommandSpec> = {};
      for (const [prefix, sub] of Object.entries(entry.subcommands)) {
        subs[prefix] = {
          schema: sub.schema as SchemaNode,
          ...(sub.allowedFlags ? { allowedFlags: sub.allowedFlags } : {}),
          ...(sub.trustErrors !== undefined ? { trustErrors: sub.trustErrors } : {}),
          ...(sub.trustHelp !== undefined ? { trustHelp: sub.trustHelp } : {}),
        };
      }
      spec.subcommands = subs;
    }

    EXEC_RESULT_TRUST_ENTRIES[entry.id] = spec;
    log.info(`[DualView] policy: command override registered for "${entry.id}"`);
  }

  EXEC_RESULT_TRUST_INDEX = buildIndex(EXEC_RESULT_TRUST_ENTRIES);
}

/**
 * Reset the exec spec library to its original static entries.
 * @internal Used by tests to restore state between runs.
 */
export function _resetExecSpecsForTests(
  original: Record<string, ExecOutputSpec>,
): void {
  for (const key of Object.keys(EXEC_RESULT_TRUST_ENTRIES)) {
    delete EXEC_RESULT_TRUST_ENTRIES[key];
  }
  Object.assign(EXEC_RESULT_TRUST_ENTRIES, original);
  EXEC_RESULT_TRUST_INDEX = buildIndex(EXEC_RESULT_TRUST_ENTRIES);
}

export interface ExecClassifyResult {
  /** Matched spec with schema, or null if no match. */
  spec: ExecOutputSpec | null;
  /**
   * When non-null, the command matched a known entry but was rejected
   * (e.g. shell operators present). The caller should return this as a
   * TRUSTED error message instead of running the command's output through
   * the normal classification path.
   */
  rejection: string | null;
  /** When true, non-zero exit code outputs should be treated as TRUSTED. */
  trustErrors: boolean;
  trustHelp: boolean;
}

/**
 * Classify an exec invocation by its command string.
 *
 * Returns `{ spec, rejection }`:
 * - `spec` is the matching ExecOutputSpec when all conditions are met.
 * - `rejection` is a TRUSTED error string when a known command was
 *   rejected (shell operators, unknown flags). The caller should use
 *   this as the tool result and classify it as TRUSTED.
 * - Both null: no match, fall through to blanket UNTRUSTED.
 */
export function classifyExecOutput(
  command: string | undefined,
  params: Record<string, unknown> | undefined,
): ExecClassifyResult {
  const none: ExecClassifyResult = { spec: null, rejection: null, trustErrors: false, trustHelp: false };
  if (typeof command !== "string") return none;
  if (isSymbolicExec(params)) return none;
  const normalized = normalizeExecCommand(command);
  // When normalization can't identify a script/binary (inline code like
  // `bash -c ...` / `node -e ...`), structured classification is impossible,
  // but the wildcard fallback may still promote exit-code output to TRUSTED.
  // Pass empty args so trustHelp cannot falsely fire — we can't inspect
  // flags of code the agent inlined.
  if (!normalized) return applyWildcard([]);
  // "*" is reserved for the wildcard fallback — never match it as a
  // canonical id even if a command somehow normalizes to "*".
  const spec = normalized.id === "*" ? null : (EXEC_RESULT_TRUST_INDEX[normalized.id] ?? null);
  if (!spec) return applyWildcard(normalized.args);
  const te = spec.trustErrors ?? false;
  // trustHelp: if the command has --help or -h in args, output is help text
  const th = (spec.trustHelp ?? false) && normalized.args.some(a => a === "--help" || a === "-h");
  if (!spec.subcommands) {
    const w = applyWildcard(normalized.args);
    return { spec, rejection: null, trustErrors: te || w.trustErrors, trustHelp: th || w.trustHelp };
  }
  const result = resolveSubcommand(spec.subcommands, normalized.args);
  const w = applyWildcard(normalized.args);
  return {
    ...result,
    trustErrors: result.trustErrors || te || w.trustErrors,
    trustHelp: result.trustHelp || th || w.trustHelp,
  };
}

/**
 * Wildcard "*" entry fallback. When a "*" entry is registered (typically via
 * operator policy YAML), its `trustErrors`/`trustHelp` flags apply to every
 * exec command — including those not otherwise classified. `schema` and
 * `subcommands` on a wildcard entry are ignored: a single structured shape
 * cannot be asserted across arbitrary commands, so only the error/help-text
 * trust promotions carry over.
 *
 * Returns a result with spec: null so the caller still treats output as
 * blanket UNTRUSTED except for the exit-code and --help promotions driven
 * by trustErrors/trustHelp downstream in index.ts.
 */
function applyWildcard(args: string[]): ExecClassifyResult {
  const wildcard = EXEC_RESULT_TRUST_INDEX["*"];
  if (!wildcard) return { spec: null, rejection: null, trustErrors: false, trustHelp: false };
  return {
    spec: null,
    rejection: null,
    trustErrors: wildcard.trustErrors ?? false,
    trustHelp: (wildcard.trustHelp ?? false) && args.some(a => a === "--help" || a === "-h"),
  };
}

/** Shell operators that indicate command chaining -- reject the match. */
const SHELL_OPERATORS = new Set(["&&", "||", "|", ";"]);

/** Check if a token contains a shell operator (e.g. "list;" has trailing ;). */
function containsShellOperator(token: string): boolean {
  if (SHELL_OPERATORS.has(token)) return true;
  if (token.endsWith(";")) return true;
  // Pipe/and/or embedded in a token (e.g. "list&&echo")
  if (token.includes("&&") || token.includes("||") || token.includes("|")) return true;
  return false;
}

/**
 * Longest-prefix match against a subcommands map with strict validation.
 *
 * 1. Try longest prefix first (most specific match wins).
 * 2. If matched, check for shell operators -- return rejection message.
 * 3. Validate remaining args against allowedFlags.
 *
 * Returns { spec, rejection } -- see ExecClassifyResult.
 */
function resolveSubcommand(
  subcommands: Record<string, ExecSubcommandSpec>,
  args: string[],
): ExecClassifyResult {
  const none: ExecClassifyResult = { spec: null, rejection: null, trustErrors: false, trustHelp: false };

  // Try longest prefix first.
  for (let len = args.length; len > 0; len--) {
    const prefix = args.slice(0, len).join(" ");
    const match = subcommands[prefix];
    if (!match) continue;

    // Matched a known subcommand. Now validate strictly.

    // Shell operators in args: reject with trusted error.
    for (const token of args) {
      if (containsShellOperator(token)) {
        return {
          spec: null,
          rejection: `[DualView] Shell operators (&&, ||, |, ;) are not allowed in classified exec commands. Run each command separately.`,
          trustErrors: false,
          trustHelp: false,
        };
      }
    }

    // Validate remaining args against allowedFlags.
    const rest = args.slice(len);
    if (match.allowedFlags && !validateFlags(rest, match.allowedFlags)) continue;

    return { spec: match, rejection: null, trustErrors: match.trustErrors ?? false, trustHelp: match.trustHelp ?? false };
  }
  return none;
}

/**
 * Validate that remaining args after a subcommand prefix contain only
 * allowed flags and their values.
 *
 * Walks the args left-to-right:
 * - A token starting with `-` must be in allowedFlags, otherwise reject.
 * - The token immediately after a flag is treated as its value (skip).
 * - A bare positional arg (not starting with `-`, not a flag value) rejects.
 */
function validateFlags(
  rest: string[],
  allowedFlags: readonly string[],
): boolean {
  const allowed = new Set(allowedFlags);
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (token.startsWith("-")) {
      // Split combined --flag=value
      const flagName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (!allowed.has(flagName)) return false;
      // If no =, next token is the value (skip it)
      if (!token.includes("=") && i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
        i += 2;
      } else {
        i += 1;
      }
    } else {
      // Bare positional arg after subcommand -- reject
      return false;
    }
  }
  return true;
}

/**
 * Look up the canonical id for a command without returning the spec.
 * Useful for audit logging in the integration layer so we can tag events
 * with the matched identifier even when classification decides to fall
 * through. Returns the id produced by `normalizeExecCommand` (which is
 * the alias the user typed, not the canonical key — intentional so
 * operators can see which alias path triggered).
 */
export function execCommandId(
  command: string | undefined,
  params: Record<string, unknown> | undefined,
): string | null {
  if (typeof command !== "string") return null;
  if (isSymbolicExec(params)) return null;
  const normalized = normalizeExecCommand(command);
  return normalized?.id ?? null;
}
