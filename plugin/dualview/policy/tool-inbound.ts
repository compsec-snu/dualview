/**
 * Tool-level inbound data classification.
 *
 * Each tool has a ToolInboundSpec (or ActionToolInboundSpec) describing
 * how its result fields map to trust categories. The resolver in
 * resolve-schema.ts walks this tree and produces per-field trust
 * decisions at hook time.
 *
 * Literal markers ("TRUSTED" / "UNTRUSTED") are terminal — no category,
 * no role. Structured markers always carry `category → role → keyField?`
 * in that order.
 *
 * Adding a new tool: add an entry to TOOL_INBOUND_SPEC below.
 * Adding a new trust category: see policy/trust-category.ts.
 */

import type {
  SchemaNode,
  ActionToolInboundSpec,
  ToolSpec,
} from "./schema-types.js";

export const TOOL_INBOUND_SPEC: Record<string, ToolSpec> = {
  // ── Local filesystem / system ─────────────────────────────────────────
  // `read` returns trusted text at the built-in schema level. Full mode handles
  // DIR-untrusted files out-of-band via the worktree path-rewrite hook +
  // syncPolicyDirPathsToWorktree: the trusted view already contains a symbol
  // token, so the read result carries the symbol verbatim. Dual-only mode has a
  // hook-time override in index.ts that classifies read results by DIR because
  // those filesystem layers are disabled.
  read: {
    paramsKeys: { file_path: { category: "DIR", role: "key" } },
    schema: "TRUSTED",
  },
  write:          { schema: "TRUSTED" },
  edit:           { schema: "TRUSTED" },
  memory_search:  { schema: "TRUSTED" },
  memory_get:     { schema: "TRUSTED" },
  session_status: { schema: "TRUSTED" },
  canvas:         { schema: "TRUSTED" },
  nodes:          { schema: "TRUSTED" },
  cron:           { schema: "TRUSTED" },
  tts:            { schema: "TRUSTED" },

  // ── External network ──────────────────────────────────────────────────
  // For web_fetch we key title/text off params.url rather than the
  // echoed body field so summarizeToolTrust (which runs without the
  // parsed body) can answer correctly. Redirect-aware trust (finalUrl)
  // is a follow-up — see TODO in the issue #174 discussion.
  web_fetch: {
    paramsKeys: { url: { category: "URL", role: "key" } },
    schema: {
      url:             { category: "URL", role: "key" },
      finalUrl:        { category: "URL", role: "key" },
      status:          "TRUSTED",
      contentType:     "TRUSTED",
      extractMode:     "TRUSTED",
      extractor:       "TRUSTED",
      fetchedAt:       "TRUSTED",
      tookMs:          "TRUSTED",
      truncated:       "TRUSTED",
      length:          "TRUSTED",
      rawLength:       "TRUSTED",
      wrappedLength:   "TRUSTED",
      externalContent: "TRUSTED",
      title:           { category: "URL", role: "data", keyField: "params.url" },
      text:            { category: "URL", role: "data", keyField: "params.url" },
      warning:         "TRUSTED",
    } satisfies SchemaNode,
  },

  // Per-item URL trust is expressed directly in the schema — the
  // resolver walks __items and resolves keyField "url" against each
  // item. No special-case needed in the plugin hook.
  web_search: {
    schema: {
      query:           "TRUSTED",
      provider:        "TRUSTED",
      count:           "TRUSTED",
      tookMs:          "TRUSTED",
      externalContent: "TRUSTED",
      results: {
        __items: {
          url:         { category: "URL", role: "key" },
          published:   "TRUSTED",
          siteName:    "TRUSTED",
          title:       { category: "URL", role: "data", keyField: "url" },
          description: { category: "URL", role: "data", keyField: "url" },
        },
      },
    } satisfies SchemaNode,
  },

  // ── Exec / image ──────────────────────────────────────────────────────
  // Exec is plaintext UNTRUSTED by default (may read attacker-controlled
  // data via the shell). Symbolic exec mode is handled separately in
  // index.ts.
  //
  // Full mode may refine this baseline with verified per-command schemas in
  // index.ts. Dual-only keeps the mode-by-call contract only:
  // `env.RESTRICTED=1` is TRUSTED, unrestricted exec stays UNTRUSTED.
  exec: { schema: "UNTRUSTED" },

  // `process` manages long-running exec sessions (list/poll/log/write/
  // send-keys/submit/paste/kill/clear/remove). Result shape depends on
  // params.action: read-style actions (`poll`, `log`) return shell
  // stdout/stderr from an attacker-reachable session — same threat model
  // as `exec`, so UNTRUSTED. Write/lifecycle actions return only
  // tool-generated metadata ("Wrote N bytes…", "Killed session…") and
  // are TRUSTED. `list` returns registry metadata (sessionIds, statuses,
  // commands the agent itself authored) and is TRUSTED; the command-echo
  // concern for resolved-symbol content is shared with exec's own output
  // path and out of scope here. Unknown actions fall through to
  // defaultSchema = UNTRUSTED (fail-closed).
  process: {
    actionField: "action",
    schemas: {
      list:        "TRUSTED",
      poll:        "UNTRUSTED",
      log:         "UNTRUSTED",
      write:       "TRUSTED",
      "send-keys": "TRUSTED",
      submit:      "TRUSTED",
      paste:       "TRUSTED",
      kill:        "TRUSTED",
      clear:       "TRUSTED",
      remove:      "TRUSTED",
    },
    defaultSchema: "UNTRUSTED",
  } satisfies ActionToolInboundSpec,

  // Image vision analysis: body is free-form text, trust decided by the
  // source URL category.
  image: {
    paramsKeys: { image: { category: "URL", role: "key" } },
    schema: { category: "URL", role: "data", keyField: "params.image" },
  },

  // ── Sessions ──────────────────────────────────────────────────────────
  sessions_send: {
    paramsKeys: { sessionKey: { category: "CHANNEL", role: "key" } },
    schema: {
      runId:      "TRUSTED",
      status:     "TRUSTED",
      sessionKey: "TRUSTED",
      delivery:   "TRUSTED",
      reply:      { category: "CHANNEL", role: "data", keyField: "params.sessionKey" },
    } satisfies SchemaNode,
  },

  sessions_history: {
    paramsKeys: { sessionKey: { category: "CHANNEL", role: "key" } },
    schema: {
      sessionKey:       "TRUSTED",
      truncated:        "TRUSTED",
      droppedMessages:  "TRUSTED",
      contentTruncated: "TRUSTED",
      contentRedacted:  "TRUSTED",
      bytes:            "TRUSTED",
      messages: {
        __items: {
          role:      "TRUSTED",
          timestamp: "TRUSTED",
          content: {
            __items: {
              type: "TRUSTED",
              text: { category: "CHANNEL", role: "data", keyField: "params.sessionKey" },
            },
          },
        },
      },
    } satisfies SchemaNode,
  },

  sessions_spawn: { schema: "TRUSTED" },
  sessions_list:  { schema: "TRUSTED" },
  subagents:      { schema: "TRUSTED" },

  // message tool: result shape depends on params.action. Read-style
  // actions pull data from a channel (CHANNEL_DATA). Write/meta actions
  // return trusted metadata.
  message: {
    paramsKeys: {
      channel: { category: "CHANNEL", role: "key" },
      target:  { category: "CHANNEL", role: "key" },
    },
    actionField: "action",
    schemas: {
      read:            { category: "CHANNEL", role: "data", keyField: "params.channel" },
      search:          { category: "CHANNEL", role: "data", keyField: "params.channel" },
      "thread-list":   { category: "CHANNEL", role: "data", keyField: "params.channel" },
      "list-pins":     { category: "CHANNEL", role: "data", keyField: "params.channel" },
      "download-file": { category: "CHANNEL", role: "data", keyField: "params.channel" },
      send:   "TRUSTED",
      delete: "TRUSTED",
      react:  "TRUSTED",
      pin:    "TRUSTED",
      unpin:  "TRUSTED",
      edit:   "TRUSTED",
      reply:  "TRUSTED",
    },
    defaultSchema: "TRUSTED",
  } satisfies ActionToolInboundSpec,

  // ── Claude Code — local containers ────────────────────────────────────
  claude_code_run:    { schema: "TRUSTED" },
  claude_code_status: { schema: "TRUSTED" },
  claude_code_browse: { schema: "TRUSTED" },
  claude_code_list:   { schema: "TRUSTED" },
  claude_code_stop:   { schema: "TRUSTED" },
  claude_code_assign: { schema: "TRUSTED" },
  claude_code_delete: { schema: "TRUSTED" },

  // ── DualView internal tools ───────────────────────────────────────────────
  inspect_symbol: { schema: "TRUSTED" },
  policy_list:    { schema: "TRUSTED" },
  policy_add:     { schema: "TRUSTED" },
  policy_del:     { schema: "TRUSTED" },
};

/** Narrow by tool name. Returns undefined for unclassified tools. */
export function getToolInboundSpec(toolName: string): ToolSpec | undefined {
  return TOOL_INBOUND_SPEC[toolName];
}
