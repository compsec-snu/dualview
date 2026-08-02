/**
 * Per-command outbound (input) policy for the `exec` tool.
 *
 * Refines the blanket `TOOL_INPUT_RESOLVE.exec = true` baseline and the
 * `TOOL_INPUT_FIELD_POLICY.exec = { command: "resolve" }` default by
 * supplying per-argv-position resolve decisions. Argv positions are
 * SCRIPT-RELATIVE — they count from the first argument to the script,
 * not from the interpreter — matching the `args` produced by
 * `normalizeExecCommand`.
 *
 * Primary motivation: prevent agent-symbolized tokens (potentially carrying
 * tainted PII) from being silently resolved into arguments passed to an
 * external API. For example, `node reddit-readonly.mjs search all $_DUALVIEW_SYM_q…`
 * should keep the query token symbolized rather than leaking its resolved
 * value into the HTTP request to reddit.com.
 *
 * Phase 1 integration is LOG-ONLY: the classifier runs in the
 * `before_tool_call` hook, its match (if any) is recorded to the audit
 * trail, but the actual argv refinement (selective resolve + shell-quoting
 * of symbolic tokens) is deferred to Phase 2. This keeps the initial PR
 * focused on the inbound side, which is the higher-priority defense.
 *
 * Phase 1 scope
 * -------------
 * Only entries whose argv shape is **pinned to observed skill source**
 * are shipped. Follow-up issues track verification work for additional
 * skills (gws, arxiv, gog, ...) — they stay at the tool-level default
 * until their argv conventions are verified.
 *
 * Adding a new skill
 * ------------------
 *   EXEC_INPUT_RESOLVE_ENTRIES["my-skill.mjs"] = {
 *     aliases: ["my-skill-fork.mjs"],  // optional
 *     args: { 0: "resolve", rest: "not_resolve" },
 *   };
 *
 * Scope: concrete exec only. Symbolic exec (RESTRICTED=1) is handled by
 * the existing outbound path; `classifyExecInput` returns null there.
 */

import type { InputFieldPolicy } from "./tool-outbound.js";
import { isSymbolicExec, normalizeExecCommand } from "./exec-identifier.js";

/**
 * Per-position resolve policy for the arguments of an exec command.
 *
 * Numeric keys are script-relative argv positions (0 = first argument to
 * the script after interpreter stripping, 1 = second, ...). `rest` covers
 * every position beyond the largest numbered entry. Absent positions fall
 * back to the tool-level default ("resolve" for exec).
 */
export interface ExecArgsPolicy {
  [position: number]: InputFieldPolicy;
  rest?: InputFieldPolicy;
}

export interface ExecInputSpec {
  /**
   * Alternative canonical ids that resolve to this spec. See exec-inbound.ts
   * for the same mechanism and collision semantics.
   */
  aliases?: readonly string[];
  args: ExecArgsPolicy;
}

/**
 * Primary library: canonical ExecCommandId -> ExecInputSpec.
 *
 * Each entry is keyed by the canonical script basename and MUST be derived
 * from observed skill source — `EXEC_INPUT_RESOLVE_ENTRIES` and
 * `EXEC_RESULT_TRUST_ENTRIES` (exec-inbound.ts) are kept in sync so a
 * skill with a verified inbound shape also gets its verified outbound
 * policy in the same PR.
 */
export const EXEC_INPUT_RESOLVE_ENTRIES: Record<string, ExecInputSpec> = {
  // ClawHub reddit-readonly skill.
  // argv[0] is the subcommand (posts/search/comments/recent-comments/
  // thread/find) — always a fixed enum chosen by the agent, safe to
  // resolve. Everything after may be a subreddit name, post id, or
  // freeform query that the agent might have symbolized for PII
  // protection; keep those symbolic so they never enter the outbound
  // HTTP request.
  // Verified against:
  //   ~/workspace/skills/reddit-readonly/scripts/reddit-readonly.mjs
  //   (main dispatch at EOF + usage() at line 552)
  "reddit-readonly.mjs": {
    args: {
      0: "resolve",
      rest: "not_resolve",
    },
  },
};

/**
 * Reverse index built at module load: canonical id AND every alias map to
 * the owning spec. Throws on collision so the library can't silently have
 * two entries for the same id.
 */
const EXEC_INPUT_RESOLVE_INDEX: Record<string, ExecInputSpec> = (() => {
  const idx: Record<string, ExecInputSpec> = {};
  for (const [canonical, spec] of Object.entries(EXEC_INPUT_RESOLVE_ENTRIES)) {
    if (canonical in idx) {
      throw new Error(`[exec-outbound] duplicate canonical id: ${canonical}`);
    }
    idx[canonical] = spec;
    for (const alias of spec.aliases ?? []) {
      if (alias in idx) {
        throw new Error(
          `[exec-outbound] alias collision: ${alias} (from ${canonical}) already indexed`,
        );
      }
      idx[alias] = spec;
    }
  }
  return idx;
})();

/** @internal Reverse index — exported for tests only. */
export function _execInputResolveIndexForTests(): Readonly<Record<string, ExecInputSpec>> {
  return EXEC_INPUT_RESOLVE_INDEX;
}

/**
 * Return the per-position policy for a given exec invocation, or null if:
 *   - the call is running in symbolic-exec mode, OR
 *   - the command can't be normalized (e.g. inline code), OR
 *   - no entry matches the canonical identifier.
 *
 * When null is returned the tool-level default applies to every position,
 * which is the existing behavior.
 */
export function classifyExecInput(
  command: string | undefined,
  params: Record<string, unknown> | undefined,
): ExecInputSpec | null {
  if (typeof command !== "string") return null;
  if (isSymbolicExec(params)) return null;
  const normalized = normalizeExecCommand(command);
  if (!normalized) return null;
  return EXEC_INPUT_RESOLVE_INDEX[normalized.id] ?? null;
}

/**
 * Resolve the effective policy for a single argv position using script-
 * relative indexing.
 *
 * Rules (in order):
 *   1. If the position has an explicit numeric entry, return it.
 *   2. If `rest` is set AND the position is beyond the largest numeric key,
 *      return `rest`.
 *   3. Otherwise return undefined (caller applies tool-level default).
 *
 * Exposed so the Phase 2 argv refinement step and the Phase 1 unit tests
 * share a single implementation.
 */
export function resolvePositionPolicy(
  spec: ExecInputSpec,
  position: number,
): InputFieldPolicy | undefined {
  if (position < 0) return undefined;
  const explicit = spec.args[position];
  if (explicit !== undefined) return explicit;
  if (spec.args.rest === undefined) return undefined;
  // `rest` only applies beyond the largest numeric key.
  let maxNumeric = -1;
  for (const key of Object.keys(spec.args)) {
    const n = Number(key);
    if (Number.isInteger(n) && n > maxNumeric) maxNumeric = n;
  }
  return position > maxNumeric ? spec.args.rest : undefined;
}
