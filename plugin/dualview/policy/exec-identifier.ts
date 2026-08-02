/**
 * Canonical identifier extraction for `exec` tool invocations.
 *
 * Given a raw shell command string, this module reduces it to a single
 * (id, args) pair where `id` is the basename of the script or binary that
 * identifies *what* is being run. Interpreters (node, python, bun, ...) and
 * their leading flags are stripped so that
 * `node reddit-readonly.mjs posts rust` and
 * `node ~/workspace/skills/reddit-readonly/scripts/reddit-readonly.mjs posts rust`
 * both normalize to `reddit-readonly.mjs`.
 *
 * This canonical identifier is the primary lookup key for
 * `EXEC_RESULT_TRUST_ENTRIES` (exec-inbound.ts) and
 * `EXEC_INPUT_RESOLVE_ENTRIES` (exec-outbound.ts). Adding a new skill to
 * either table is a single object-literal key — no regex, no glob patterns,
 * no ordering concerns. Aliases on each entry resolve to the same spec via
 * the reverse index each module builds at load time.
 *
 * Scope: concrete exec only. `isSymbolicExec(params)` is a shared guard used
 * by both classifiers so they never interfere with the existing `exec_sym`
 * (RESTRICTED=1) TRUSTED-promotion path.
 */

/**
 * Interpreter binaries whose first non-flag argument is treated as the real
 * identifier (e.g. `node reddit-readonly.mjs ...` -> id = "reddit-readonly.mjs").
 *
 * Chained runners (bunx, npx, yarn, pnpm) are included so invocations like
 * `bunx tsx tools/my-skill.ts list` unwrap through multiple layers to
 * `my-skill.ts`.
 */
export const INTERPRETERS: ReadonlySet<string> = new Set<string>([
  // JS/TS runtimes
  "node", "bun", "deno",
  // JS/TS package/script runners
  "bunx", "npx", "yarn", "pnpm",
  // TypeScript execution
  "tsx", "ts-node",
  // Python
  "python", "python2", "python3",
  // Other scripting languages
  "ruby", "perl",
  // Shells
  "sh", "bash", "zsh",
]);

/**
 * Interpreter flags that consume a code/command string as their argument
 * (e.g. `node -e "console.log(1)"`, `bash -c "ls -la"`, `python -c "..."`).
 *
 * When one of these appears after an interpreter, the command is considered
 * unresolvable (no script identifier) and `normalizeExecCommand` returns null.
 * Phase 1 does not attempt to recurse into the embedded code.
 */
export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set<string>([
  "-e", "-c", "--eval", "--command",
]);

/** Shell-agnostic basename: returns the trailing path component. */
export function basename(path: string): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Shlex-style tokenizer for a shell command string.
 *
 * Handles:
 *   - whitespace-separated tokens
 *   - "..." double-quoted strings (with backslash escapes)
 *   - '...' single-quoted strings (literal, no escapes)
 *
 * This is deliberately minimal — it's used to identify the script/binary,
 * not to fully emulate POSIX shell semantics.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;
  const n = command.length;

  while (i < n) {
    const c = command[i];

    // Whitespace flushes the current token.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      i++;
      continue;
    }

    // Double-quoted string: backslash escapes the next character.
    if (c === '"') {
      inToken = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n) {
          current += command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      if (i < n) i++; // consume closing quote
      continue;
    }

    // Single-quoted string: literal, no escape processing.
    if (c === "'") {
      inToken = true;
      i++;
      while (i < n && command[i] !== "'") {
        current += command[i];
        i++;
      }
      if (i < n) i++; // consume closing quote
      continue;
    }

    // Regular character.
    current += c;
    inToken = true;
    i++;
  }

  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Canonical (id, args) pair extracted from a raw command string.
 *
 * `id`   — basename of the script or binary being run
 * `args` — script-relative arguments (interpreter + its flags stripped)
 */
export interface ExecCommand {
  id: string;
  args: string[];
}

/**
 * Reduce a raw exec command string to its canonical ExecCommand.
 *
 * Examples:
 *   "node reddit-readonly.mjs posts rust"           -> { id: "reddit-readonly.mjs", args: ["posts", "rust"] }
 *   "node ./scripts/reddit-readonly.mjs posts rust" -> { id: "reddit-readonly.mjs", args: ["posts", "rust"] }
 *   "node ~/workspace/skills/reddit-readonly/scripts/reddit-readonly.mjs posts rust"
 *                                                   -> { id: "reddit-readonly.mjs", args: ["posts", "rust"] }
 *   "python3 -u my-skill.py fetch 2401"             -> { id: "my-skill.py",         args: ["fetch", "2401"] }
 *   "bunx tsx tools/my-skill.ts list"               -> { id: "my-skill.ts",         args: ["list"] }
 *   "/usr/local/bin/my-bin search foo"              -> { id: "my-bin",              args: ["search", "foo"] }
 *
 * Returns null when the command is empty, only interpreters/flags, or uses
 * an inline-code flag (`-e`, `-c`, `--eval`, `--command`).
 */
export function normalizeExecCommand(command: string): ExecCommand | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const argv = tokenize(command);
  if (argv.length === 0) return null;

  let i = 0;
  while (i < argv.length) {
    const name = basename(argv[i]);
    if (INTERPRETERS.has(name)) {
      i++;
      // Skip leading flags after the interpreter. Bail out if an inline-code
      // flag is seen — the command has no identifiable script.
      while (i < argv.length && argv[i].startsWith("-")) {
        if (INLINE_CODE_FLAGS.has(argv[i])) return null;
        i++;
      }
      continue; // check whether the next token is *also* an interpreter
    }
    // Non-interpreter token — this is the canonical script/binary.
    return { id: basename(argv[i]), args: argv.slice(i + 1) };
  }
  // Fell off the end — every token was an interpreter or flag.
  return null;
}

/**
 * True when an exec call is running in symbolic-execution mode
 * (RESTRICTED=1). Shared guard for `classifyExecOutput` and
 * `classifyExecInput` so neither interferes with the existing `exec_sym`
 * TRUSTED-promotion path.
 */
export function isSymbolicExec(params: Record<string, unknown> | undefined): boolean {
  const env = params?.env as Record<string, string> | undefined;
  return env?.RESTRICTED === "1";
}
