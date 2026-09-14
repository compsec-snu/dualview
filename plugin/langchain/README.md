# ADFI DualView for LangChain

Proof-of-concept that DualView dataflow and filesystem protections can be
embedded as LangChain JS middleware without replacing LangChain's agent loop.

Architecture, capability status, and prioritized feature work:
[LangChain Integration](../../docs/design/langchain-dualview.md).

## Scope

- Runtime:
  - LangChain owns the agent loop, message history, model, and tool dispatch.
  - DualView middleware wraps model and tool calls.
  - Canonical DualView modules own policy, symbols, filesystem views,
    restricted execution, audit, and provenance.
- Bundled tools:
  - `read_file`
  - `write_file`
  - `edit_file`
  - `bash`
  - `inspect_symbol`
  - `policy_list`
  - `policy_add`
  - `policy_del`
- File reads and writes use the Agent File System under
  `~/.dualview/workspaces/<workspace-id>/agentview`.
- Successful file writes and restricted shell calls create the existing paired
  `[DUALVIEW-TRUSTED]` and `[DUALVIEW-UNTRUSTED]` commits. Unrestricted shell
  text writes are immediately symbolized into the Agent File System. Binary
  writes remain exact in the Human File System and appear as opaque symbols in
  the Agent File System.
- `exec`/`bash` with `env.RESTRICTED=1` keeps symbols unresolved, runs against
  the Agent File System with network access denied, audits as `exec_sym`, and
  returns trusted output.
- Human edits are reconciled before each supported tool call.
- Channel trust, webhook handling, and prompt-level taint propagation are not
  included.

## Usage

Install this prototype's dependencies:

```bash
npm install --prefix plugin/dualview
npm install --prefix plugin/langchain
```

```typescript
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { createDualViewIntegration } from "./plugin/langchain/index.js";

const dualView = createDualViewIntegration({
  workspacePath: "/absolute/path/to/workspace",
});
const agent = createAgent({
  model,
  middleware: [dualView.middleware],
});

try {
  const result = await agent.invoke({ messages });
  const finalMessage = result.messages.at(-1);
  if (!(finalMessage instanceof AIMessage)) {
    throw new Error("LangChain agent did not return an AI message");
  }
  const response = dualView.resolveFinalResponse(finalMessage);
} finally {
  dualView.closeSession();
}
```

This is the extensibility boundary: the application supplies the normal
LangChain agent, model, messages, and tools. DualView supplies middleware and
explicit final-response/session lifecycle handling.

`createDualViewMiddleware()` remains available when the application does not
need final-response resolution or explicit session cleanup.

Set `includeTools: false` to use existing tools. Map their names with
`toolOperations`:

```typescript
createDualViewMiddleware({
  workspacePath,
  includeTools: false,
  toolOperations: {
    load_source: "read",
    save_source: "write",
    terminal: "bash",
  },
});
```

The middleware also applies the shared Data Trust Policy to all tool names:

- Adds DualView symbol guidance to model requests.
- Resolves symbols for outbound tools configured by the shared policy.
- Symbolizes untrusted tool results before LangChain stores their
  `ToolMessage`.
- Emits framework-neutral audit records through `onAudit`.

Use `policyPath` for a shared YAML policy, `sessionKey` for symbol ownership,
and `symbolDbPath` for persistent symbols.

File tools must accept `path`, `file_path`, or `filepath`. Bash tools must
accept `workdir` or `cwd`; the middleware injects `workdir` when absent.
Bundled bash also accepts an `env` object.

Restricted exec is Linux-first and reuses the canonical mount-namespace
wrapper. macOS uses `sandbox-exec` as a best-effort fallback from `agentview`;
it denies network and tracked Human File System access but cannot virtualize
absolute Human File System paths. Restricted calls use a minimal host
environment and are supported only by the bundled shell tool; external
`toolOperations` bash mappings remain available for unrestricted calls.
Unrestricted bundled shell calls also block writes to the Agent File System,
DualView git metadata, and the symbol database.

### Models

- Optional: `CopilotChatModel`, backed by the official GitHub Copilot SDK and the
  logged-in Copilot CLI user.
- Copilot runtime tools are disabled. LangChain executes all tools through the
  LangChain DualView middleware (hook).

```typescript
import {
  CopilotChatModel,
  createDualViewMiddleware,
} from "./plugin/langchain/index.js";

const model = new CopilotChatModel({ model: "auto", workingDirectory: workspacePath });
const dualView = createDualViewIntegration({
  workspacePath,
  inspectSymbol: {
    invokeLLM: (prompt) => model.completeRaw(prompt),
  },
});
```

`inspect_symbol` uses the existing DualView implementation and the same symbol
map as the middleware. The supplied model invocation must be isolated and must
not expose tools; `CopilotChatModel.completeRaw()` creates such a tool-less
session.

### Brave Search

The optional `web_search` tool uses LangChain's current `tool()` API around the
Brave REST endpoint and normalizes results into the existing DualView
`web_search` policy shape. It does not depend on the sunset
`@langchain/community` package.
It auto-enables when either `BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY` is present.
The API key can also be supplied explicitly:

```typescript
createDualViewIntegration({
  workspacePath,
  braveSearch: { apiKey: process.env.BRAVE_API_KEY },
});
```

`auto` is the default. Explicit model IDs depend on the logged-in account's
Copilot model catalog.

## Prototype limitation

Unrestricted bash starts in the Human File System. Restricted bash starts in
`agentview`; Linux also bind-mounts active Agent File Systems over their Human
File System paths. The macOS fallback cannot virtualize absolute paths embedded
inside shell command strings.
