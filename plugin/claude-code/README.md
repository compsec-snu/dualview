# DualView for Claude Code

- Native Claude tools:
  - `Read`, `Write`
  - `PreToolUse`: Agent File System path rewrite
  - `PostToolUse`: read auditing and Human File System synchronization
- DualView MCP tools:
  - `edit_file`
  - `bash`
  - `web_fetch`
  - `inspect_symbol`
- MCP `bash` and `web_fetch` execute in the MCP server, then their raw results
  are classified and transformed by `PostToolUse` before Claude sees them.
- MCP tool inputs are resolved or preserved according to DualView policy by
  `PreToolUse`; the MCP server receives the resulting execution arguments.
- `inspect_symbol` creates derived symbols as part of the shared tool
  implementation; this is not generic MCP result wrapping.
- Limitation: Claude `PostToolUseFailure` cannot replace failed tool output.
  MCP-internal failures therefore return fixed data-free errors; command output
  and other normal results use `PostToolUse`.
- Lifecycle hooks:
  - `SessionStart`: DualView guidance
  - `MessageDisplay`: human-view symbol resolution
- Native `Read` returns AgentView content unchanged.
- Native `Edit` is denied because Claude's read-before-edit cache does not
  register a `Read` whose path was rewritten by `PreToolUse`. This remains true
  when the `Read` output is left unchanged.
- Other native tools are denied to prevent bypass.

## Development

```bash
npm install --prefix plugin/dualview
npm install --prefix plugin/claude-code
npm --prefix plugin/claude-code run typecheck
claude plugin validate --strict plugin/claude-code
```

```bash
claude --plugin-dir ./plugin/claude-code --tools Read,Write
```
