/**
 * Tool-level outbound data flow spec (default/baseline).
 *
 * Controls whether $_DUALVIEW_SYM_* symbols in agent outbound data
 * are resolved to raw values before the tool executes.
 */

export type InputFieldPolicy = "resolve" | "not_resolve" | "no_symbols_expected";

/**
 * Tool-level resolve policy.
 * true  = resolve (destination is human-view: external network, human-facing interface)
 * false or absent = not resolve (destination is Agent File System: symbolized context)
 *
 * Can be overridden via cfg.toolInputResolve in openclaw.json.
 */
export const TOOL_INPUT_RESOLVE: Record<string, boolean> = {
  // External network
  web_fetch:    true,
  web_search:   true,

  // Exec (default mode) -- unrestricted, needs raw values for commands
  // RESTRICTED=1 handled separately by shouldRunWithSymbols()
  exec:         true,

  // Process session control -- writes/paste/send-keys feed raw bytes into
  // a live shell session (same destination as exec), so symbols must be
  // resolved to their raw values before they reach the PTY.
  process:      true,

  // Image -- may fetch external URL
  image:        true,

  // Outbound to user
  message:      true,
  tts:          true,
};

/**
 * Per-field input symbolization policy.
 * Determines how each field in tool input params is handled
 * when $_DUALVIEW_SYM_ symbols are present.
 */
export const TOOL_INPUT_FIELD_POLICY: Record<string, Record<string, InputFieldPolicy>> = {
  // Filesystem tools -- symbolized execution
  // Keep both OpenClaw-native names (`path`, `oldText`, `newText`) and
  // legacy aliases (`file_path`, `old_string`, `new_string`) so any
  // policy consumer that does direct field lookup stays consistent.
  read:           { file_path: "not_resolve", path: "not_resolve" },
  write:          { file_path: "not_resolve", path: "not_resolve", content: "not_resolve" },
  edit:           {
    file_path: "not_resolve",
    path: "not_resolve",
    old_string: "not_resolve",
    oldText: "not_resolve",
    new_string: "not_resolve",
    newText: "not_resolve",
  },

  // External network -- resolve for HTTP requests
  web_fetch:      { url: "resolve", extractMode: "resolve", maxChars: "resolve" },
  web_search:     { query: "resolve" },

  // Exec -- default exec resolves symbols; RESTRICTED=1 keeps them symbolic.
  exec:           { command: "resolve", workdir: "resolve" },

  // Process -- all content fields that land on a live shell's stdin get
  // resolved (destination is human-view: the PTY/subprocess). Control
  // fields (action/sessionId/offset/limit/timeout/eof/bracketed) are
  // expected to never carry symbols; they're included here as "resolve"
  // for fail-safety if the agent ever constructs them from tainted data.
  process:        {
    action:      "resolve",
    sessionId:   "resolve",
    data:        "resolve",
    keys:        "resolve",
    hex:         "resolve",
    literal:     "resolve",
    text:        "resolve",
    bracketed:   "resolve",
    eof:         "resolve",
    offset:      "resolve",
    limit:       "resolve",
    timeout:     "resolve",
  },

  // Image -- resolve for external URL
  image:          { image: "resolve" },

  // Outbound to user -- resolve so user sees raw values
  message:        { message: "resolve", channel: "resolve", target: "resolve", caption: "resolve" },
  tts:            { text: "resolve" },

  // Sessions -- mixed per-field
  sessions_send:  { sessionKey: "resolve", message: "not_resolve" },
  sessions_spawn: { task: "not_resolve", label: "not_resolve", agentId: "resolve", cwd: "not_resolve" },

  // Local tools -- symbolized execution
  memory_search:  { query: "not_resolve" },
  memory_get:     { file: "not_resolve" },
  inspect_symbol: { symbols: "not_resolve", prompt: "not_resolve" },
  policy_list:    {},
  policy_add:     {
    policyKind: "not_resolve",
    category: "not_resolve",
    list: "not_resolve",
    entry: "not_resolve",
    persist: "not_resolve",
    confirmedByUser: "not_resolve",
  },
  policy_del:     {
    policyKind: "not_resolve",
    category: "not_resolve",
    list: "not_resolve",
    entry: "not_resolve",
    persist: "not_resolve",
    confirmedByUser: "not_resolve",
  },
  cron:           { job: "not_resolve", patch: "not_resolve", text: "not_resolve" },
  subagents:      { message: "not_resolve" },
};
