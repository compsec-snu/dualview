/**
 * Bot dashboard assertion evaluator.
 *
 * Applies DUALVIEW security (correctness) assertions from plugin/dualview/correctness.yaml
 * to bot sessions. All evaluation is permissive — results are informational
 * (pass/fail/skip for learning), failures never trigger blocking actions.
 *
 * Only the correctness assertion set is applied (trust/taint invariants from
 * the plugin policy). Utility/task-specific assertions are not evaluated for
 * bot sessions because bot sessions have no associated user-task spec.
 *
 * Bot sessions are evaluated synchronously against pre-collected audit data
 * already on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

import { getBotAudit } from "./bot-sessions.js";
import { resolveBotWsDir } from "./utils.js";


// ── Types ───────────────────────────────────────────────────────────────────

export interface BotAssertionResponse {
  taintMode: string;
  permissive: true;
  tools: string[];
  /** Kept for backward compatibility; always ["dualview_correctness"] when any
   *  correctness assertions were applied. */
  templates: string[];
  results: BotAssertionResult[];
}

export interface BotAssertionResult {
  status: "pass" | "fail" | "skip";
  label: string;
  description?: string;
  reason: string;
  /** Always "correctness" for bot sessions — bot dashboard only runs DUALVIEW
   *  security/correctness assertions, not task-specific utility checks. */
  category: "correctness";
  tool?: string;
  assert: string;
  template?: string;
  tidx?: number;
}

/** Minimal audit entry shape used by the evaluators. */
interface AuditEntry {
  ts: string;
  hookType: string;
  sessionKey: string;
  toolName: string;
  toolCallId: string;
  taintAction: string;
  originalHead?: string;
  modifiedHead?: string;
  originalText?: string;
  modifiedText?: string;
  extra?: Record<string, unknown>;
  inputSymbols?: string;
  outputFields?: string[];
}

/** Minimal assertion step shape (parsed from template YAML). */
interface Step {
  assert: string;
  label?: string;
  description?: string;
  active?: true | false | "wip";
  when?: { mode?: string; test_mode?: string };
  tool?: string;
  tool_name?: string;
  // audit_entry_exists / absent
  where?: Record<string, unknown>;
  check?: Record<string, unknown>;
  count?: number;
  // audit_sequence
  steps?: Array<Record<string, unknown>>;
  // tool_output_policy / tool_input_policy
  trust?: string;
  field?: string;
  policy?: string;
  // tool_params / tool_result
  contains?: string;
  not_contains?: string;
  matches?: string;
  fields?: Record<string, unknown>;
  target?: string;
  // symbol_allocated
  min_count?: number;
  // tool_labeled
  label_type?: string;
  // inspect_resymbolized
  has_derived_symbols?: boolean;
  output_fields_present?: boolean;
  // template metadata (set by us)
  _template?: string;
  _templateIdx?: number;
}

type FieldMatcherOrValue = { contains?: string; not_contains?: string; matches?: string; not_matches?: string; equals?: string | number | boolean; gte?: number; lte?: number } | string | number | boolean;
type FieldMatcher = { contains?: string; not_contains?: string; matches?: string; not_matches?: string; equals?: string | number | boolean; gte?: number; lte?: number };


// ── Symbol format helpers ────────────────────────────────────────────────────

const DEFAULT_SYM_PREFIX = "$_DUALVIEW_SYM_";
const DEFAULT_SYM_PATTERN_SOURCE = String.raw`\$_DUALVIEW_SYM_[a-zA-Z_][a-zA-Z0-9_]*\[[0-9a-f]{4,8}\](?:\.[a-zA-Z_][a-zA-Z0-9_[\].]*)*`;

/** Read symbol format config from bot batch and return prefix + pattern. */
function resolveSymbolFormat(batchId: string, baseDir?: string): { prefix: string; patternSource: string } {
  try {
    const wsDir = resolveBotWsDir(batchId, baseDir);
    if (wsDir) {
      const cfgPath = path.join(wsDir, "openclaw.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        const dualview = cfg.plugins?.dualview ?? {};
        const fmtId = dualview.symbolFormat ?? process.env.DUALVIEW_SYMBOL_FORMAT;
        if (fmtId) {
          // Lazy import to avoid pulling in the full symbol-formats module at load time
          try {
            const { getPreset } = require("../../plugin/dualview/symbol-formats.js");
            const preset = getPreset(fmtId);
            if (preset) {
              return { prefix: preset.format.prefix, patternSource: preset.format.pattern.source };
            }
          } catch { /* symbol-formats not available, use default */ }
        }
      }
    }
  } catch { /* ignore */ }
  return { prefix: DEFAULT_SYM_PREFIX, patternSource: DEFAULT_SYM_PATTERN_SOURCE };
}

// ── Hook type compatibility ─────────────────────────────────────────────────

const TOOL_RESULT_HOOK_TYPES = new Set(["tool_result", "transform_tool_result", "inspect_symbol"]);
function isToolResultHook(hookType: string): boolean {
  return TOOL_RESULT_HOOK_TYPES.has(hookType);
}


// ── Pure helpers (replicated from assertions.ts to avoid async deps) ────────

function normalizeFieldMatcher(m: FieldMatcherOrValue): FieldMatcher {
  if (typeof m === "string" || typeof m === "number" || typeof m === "boolean") {
    return { equals: m };
  }
  return m;
}

function evaluateFieldMatcher(value: unknown, matcher: FieldMatcherOrValue): [boolean, string] {
  const m = normalizeFieldMatcher(matcher);
  const strVal = typeof value === "string" ? value : String(value ?? "");
  const numVal = typeof value === "number" ? value : parseFloat(strVal);

  if (m.equals !== undefined) {
    if (value === m.equals || strVal === String(m.equals)) {
      return [true, `equals ${JSON.stringify(m.equals)}`];
    }
    return [false, `expected ${JSON.stringify(m.equals)}, got ${JSON.stringify(value)}`];
  }

  if (m.contains !== undefined) {
    if (!strVal.includes(m.contains)) {
      return [false, `does not contain "${m.contains}"`];
    }
  }
  if (m.not_contains !== undefined) {
    if (strVal.includes(m.not_contains)) {
      return [false, `contains "${m.not_contains}" (should not)`];
    }
  }
  if (m.matches !== undefined) {
    if (!new RegExp(m.matches).test(strVal)) {
      return [false, `does not match /${m.matches}/`];
    }
  }
  if (m.not_matches !== undefined) {
    if (new RegExp(m.not_matches).test(strVal)) {
      return [false, `matches /${m.not_matches}/ (should not)`];
    }
  }
  if (m.gte !== undefined) {
    if (isNaN(numVal) || numVal < m.gte) {
      return [false, `${numVal} < ${m.gte}`];
    }
  }
  if (m.lte !== undefined) {
    if (isNaN(numVal) || numVal > m.lte) {
      return [false, `${numVal} > ${m.lte}`];
    }
  }

  return [true, "matched"];
}

function getNestedField(entry: AuditEntry, fieldPath: string): unknown {
  const parts = fieldPath.split(".");
  let current: unknown = entry;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function queryAuditEntries(
  entries: AuditEntry[],
  where: Record<string, FieldMatcherOrValue>,
): AuditEntry[] {
  return entries.filter((entry) => {
    for (const [field, matcher] of Object.entries(where)) {
      const value = getNestedField(entry, field);
      // hookType: accept both old and new names
      if (field === "hookType" && typeof value === "string" && isToolResultHook(value)) {
        const matcherStr = typeof matcher === "string" ? matcher : undefined;
        if (matcherStr && isToolResultHook(matcherStr)) continue;
      }
      const [passed] = evaluateFieldMatcher(value, matcher as FieldMatcherOrValue);
      if (!passed) return false;
    }
    return true;
  });
}

function snippet(text: string, maxLen = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return "..." + trimmed.slice(0, maxLen) + "...";
}


// ── Taint mode detection ────────────────────────────────────────────────────

function readBotTaintMode(batchId: string, baseDir?: string): string {
  const wsDir = resolveBotWsDir(batchId, baseDir);
  if (!wsDir) return "inline";
  try {
    const cfgPath = path.join(wsDir, "openclaw.json");
    if (!fs.existsSync(cfgPath)) return "inline";
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return (cfg?.plugins?.entries?.dualview?.config?.taintMode as string) || "inline";
  } catch {
    return "inline";
  }
}


// ── Tool discovery ──────────────────────────────────────────────────────────

function discoverTools(entries: AuditEntry[]): string[] {
  const tools = new Set<string>();
  for (const e of entries) {
    if (e.toolName && (e.hookType === "before_tool_call" || isToolResultHook(e.hookType))) {
      tools.add(e.toolName);
    }
  }
  return [...tools].sort();
}


// ── Assertion type aliases (new canonical → legacy evaluator name) ─────────
//
// plugin/dualview/correctness.yaml uses canonical assertion type names such as
// tool_outbound, tool_inbound, and tool_success.
// The static evaluators in this file still use the legacy names; resolve via
// this alias map so both old and new YAML inputs work.
const ASSERTION_TYPE_ALIASES: Record<string, string> = {
  "tool_outbound": "tool_input_policy",
  "tool_inbound": "tool_output_policy",
  "webhook_inbound": "webhook_output_policy",
  "tool_success": "tool_result_ok",
  "inspect_symbol_output": "inspect_resymbolized",
};

function resolveAssertType(assertType: string): string {
  return ASSERTION_TYPE_ALIASES[assertType] ?? assertType;
}


// ── Placeholder substitution ────────────────────────────────────────────────
//
// plugin/dualview/correctness.yaml contains `{SYM_PREFIX}` tokens inside matcher strings
// (e.g. `check.inputSymbols.contains: "{SYM_PREFIX}"`). Resolve them from the
// bot's configured symbol format.
function substitutePlaceholdersDeep<T>(obj: T, symPfx: string): T {
  if (typeof obj === "string") {
    return obj.replace(/\{SYM_PREFIX\}/g, symPfx) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => substitutePlaceholdersDeep(v, symPfx)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = substitutePlaceholdersDeep(v, symPfx);
    }
    return out as T;
  }
  return obj;
}


// ── Correctness assertion loading ────────────────────────────────────────────

/** Load plugin/dualview/correctness.yaml assertions, stamping template metadata so each
 *  result can be traced back to its source entry. */
function loadCorrectnessSteps(): Step[] {
  const repoRoot = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  const filePath = path.join(repoRoot, "plugin", "dualview", "correctness.yaml");
  const parsed = yaml.load(fs.readFileSync(filePath, "utf-8")) as {
    defaults?: Record<string, unknown>;
    assertions?: Step[];
  };
  const steps = parsed.assertions || [];
  if (parsed.defaults) {
    for (const step of steps) {
      for (const [key, value] of Object.entries(parsed.defaults)) {
        if ((step as unknown as Record<string, unknown>)[key] === undefined) {
          (step as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  for (let i = 0; i < steps.length; i++) {
    steps[i]._template = "dualview_correctness";
    steps[i]._templateIdx = i;
  }
  return steps;
}


// ── When condition ──────────────────────────────────────────────────────────

function shouldRun(when: Step["when"], taintMode: string): boolean {
  if (!when) return true;
  if (when.mode !== undefined && when.mode !== taintMode) return false;
  // In bot context, treat as utility mode (no injection tests)
  if (when.test_mode !== undefined && when.test_mode !== "utility") return false;
  return true;
}


// ── Assertion types that are NOT evaluable from audit data alone ────────────
//
// These require data that is not present in the collected audit JSONL: file
// tracking git state, assistant response text, inspect_symbol error logs, etc.
// Skipped with a "not supported in bot mode" reason rather than failing.
const UNSUPPORTED_TYPES = new Set([
  // Filesystem snapshot checks
  "file_exists", "file_absent", "file_content",
  // Git commit tracking (legacy + new names)
  "git_commit", "git_head", "git_commit_count", "git_file_tracking_policy",
  "fs_tagged_commit_exists", "fs_head_matches_tag", "fs_tagged_commit_count",
  "fs_write_dual_commit", "fs_commit_order",
  // Agent response content checks
  "response", "response_not_contains",
  "no_symbol_leakage", "human_no_symbol",
  "agent_no_untrusted",
  // Prompt inspection (needs TLLM system prompt, not audit)
  "tool_in_prompt", "dualview_tool_available",
  "tool_not_called_with",
  // Sandbox session exec check (needs command log stream)
  "command_not_executed",
]);

function hasClassifyEntry(entries: AuditEntry[], tool: string | undefined): boolean {
  if (!tool) return false;
  return entries.some((e) =>
    e.toolName === tool
    && e.hookType === "before_tool_call"
    && (e.taintAction === "classify_trusted" || e.taintAction === "classify_untrusted"),
  );
}

function shouldOmitBotAssertion(step: Step, entries: AuditEntry[], tools: Set<string>): boolean {
  const assertType = resolveAssertType(step.assert);

  // Bot dashboard evaluates historical audit JSONL only. Some tool input-policy
  // assertions require a classify audit entry to reconstruct pre/post policy
  // state; if the bot audit for that tool lacks classify entries, showing a
  // failure would be a dashboard-evaluator limitation rather than a policy bug.
  if (assertType === "tool_input_policy" && step.tool && tools.has(step.tool) && !hasClassifyEntry(entries, step.tool)) {
    return true;
  }

  // The old generic inspect_symbol field:* invariant assumes every output
  // value is symbolized. Current inspect_symbol results can include trusted
  // bookkeeping fields such as md5/error_code. Bot mode keeps the newer
  // inspect_symbol_output assertion instead.
  if (assertType === "tool_output_policy" && step.tool === "inspect_symbol" && step.field === "*") {
    return true;
  }

  return false;
}


// ── Static evaluators ───────────────────────────────────────────────────────

type Result = [label: string, passed: boolean, reason: string];

function evalToolResultOk(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_result_ok";
  const tool = step.tool!;

  if (!entries.some((e) => e.toolName === tool)) {
    return [label, true, `skipped (${tool} not called)`];
  }

  const entry = entries.find((e) => e.toolName === tool && isToolResultHook(e.hookType));
  if (!entry) return [label, false, `no tool result audit entry for ${tool}`];

  const original = entry.originalHead ?? "";
  try {
    const parsed = JSON.parse(original);
    if (parsed.error === true) {
      return [label, false, `tool result has error:true: ${snippet(original)}`];
    }
  } catch {
    if (/"error"\s*:\s*true/.test(original)) {
      return [label, false, `tool result contains "error": true: ${snippet(original)}`];
    }
  }

  return [label, true, "tool result OK (no error flag)"];
}

function evalToolSymbolized(step: Step, entries: AuditEntry[], taintMode: string, symPfx: string): Result {
  const label = step.label ?? "tool_symbolized";
  const tool = step.tool!;

  const entry = entries.find((e) => e.toolName === tool && isToolResultHook(e.hookType));
  if (!entry) return [label, false, "no tool result audit entry"];

  const action = entry.taintAction ?? "";
  const modified = entry.modifiedHead ?? "";

  if (taintMode === "symbolize") {
    if (action !== "symbolize") {
      return [label, false, `expected symbolize, got taintAction=${action}`];
    }
    if (modified.includes(symPfx)) {
      return [label, true, `taintAction=${action}, symbol ${symPfx} confirmed`];
    }
    return [label, true, `taintAction=${action} (symbol may be beyond modifiedHead preview)`];
  }

  if (taintMode === "inline") {
    if (action !== "classify_untrusted") {
      return [label, false, `expected classify_untrusted for inline mode, got taintAction=${action}`];
    }
    return [label, true, `taintAction=${action}, inline labeling confirmed`];
  }

  return [label, false, `unknown taintMode: ${taintMode}`];
}

function evalToolLabeled(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_labeled";
  const expectedType = step.label_type ?? "untrusted";

  const entry = entries.find((e) => e.toolName === step.tool && isToolResultHook(e.hookType));
  if (!entry) return [label, false, `no tool result entry for ${step.tool}`];

  const action = entry.taintAction;
  if (expectedType === "untrusted" && action === "classify_untrusted") {
    return [label, true, `tool ${step.tool} labeled as untrusted`];
  }
  if (expectedType === "trusted" && action === "classify_trusted") {
    return [label, true, `tool ${step.tool} labeled as trusted`];
  }
  return [label, false, `expected ${expectedType} labeling, got taintAction=${action}`];
}

function evalToolTrusted(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_trusted";
  const guard = entries.find((e) => e.toolName === step.tool && e.hookType === "before_tool_call");
  if (guard && (guard.taintAction === "classify_trusted" || guard.taintAction === "resolve_symbol")) {
    return [label, true, `tool ${step.tool} classified as TRUSTED (taintAction=${guard.taintAction})`];
  }
  const action = guard ? guard.taintAction : "no entry";
  return [label, false, `expected TRUSTED for ${step.tool}, got ${action}`];
}

function evalToolUntrusted(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_untrusted";
  const guard = entries.find((e) => e.toolName === step.tool && e.hookType === "before_tool_call");
  if (guard && guard.taintAction === "classify_untrusted") {
    return [label, true, `tool ${step.tool} classified as UNTRUSTED`];
  }
  const action = guard ? guard.taintAction : "no entry";
  return [label, false, `expected UNTRUSTED for ${step.tool}, got ${action}`];
}

function evalToolNotCalled(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_not_called";
  const calls = entries.filter((e) => e.toolName === step.tool && e.hookType === "before_tool_call");
  if (calls.length > 0) {
    return [label, false, `tool ${step.tool} was called ${calls.length} time(s) (expected 0)`];
  }
  return [label, true, `tool ${step.tool} was not called`];
}

function evalToolCallCount(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_call_count";
  const calls = entries.filter((e) => e.toolName === step.tool && e.hookType === "before_tool_call");
  if (calls.length !== step.count) {
    return [label, false, `tool ${step.tool} called ${calls.length} times (expected ${step.count})`];
  }
  return [label, true, `tool ${step.tool} called exactly ${step.count} time(s)`];
}

function evalToolParams(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_params";
  const entry = entries.find((e) => e.toolName === step.tool && e.hookType === "before_tool_call");
  if (!entry) return [label, false, `no before_tool_call entry for ${step.tool}`];

  const params = entry.originalHead ?? "";

  if (step.contains && !params.includes(step.contains)) {
    return [label, false, `params do not contain "${step.contains}"`];
  }
  if (step.not_contains && params.includes(step.not_contains)) {
    return [label, false, `params contain "${step.not_contains}" (should not)`];
  }
  if (step.matches && !new RegExp(step.matches).test(params)) {
    return [label, false, `params do not match /${step.matches}/`];
  }

  if (step.fields) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(params); } catch { /* truncated */ }

    for (const [fieldName, matcher] of Object.entries(step.fields)) {
      if (parsed) {
        const value = parsed[fieldName];
        if (value === undefined) return [label, false, `field "${fieldName}" not found in params`];
        const strValue = typeof value === "string" ? value : JSON.stringify(value);
        const [passed, reason] = evaluateFieldMatcher(strValue, matcher as FieldMatcherOrValue);
        if (!passed) return [label, false, `field "${fieldName}": ${reason}`];
      } else {
        const [passed, reason] = evaluateFieldMatcher(params, matcher as FieldMatcherOrValue);
        if (!passed) return [label, false, `field "${fieldName}" (raw fallback): ${reason}`];
      }
    }
  }

  return [label, true, `tool ${step.tool} params check passed`];
}

function evalToolInputPolicy(step: Step, entries: AuditEntry[], symPfx: string): Result {
  const label = step.label ?? `${step.tool}/input-policy/${step.field}`;
  const SYM_PATTERN = symPfx;

  if (!entries.some((e) => e.toolName === step.tool)) {
    return [label, true, `skipped (${step.tool} not called)`];
  }

  const classifyEntry = entries.find((e) =>
    e.toolName === step.tool
    && e.hookType === "before_tool_call"
    && (e.taintAction === "classify_trusted" || e.taintAction === "classify_untrusted"),
  );
  if (!classifyEntry) return [label, false, `no classify entry for ${step.tool}`];

  const classifyParams = classifyEntry.originalHead ?? "";
  let classifyParsed: Record<string, unknown> | null = null;
  try { classifyParsed = JSON.parse(classifyParams); } catch { /* truncated */ }

  const fieldValue = classifyParsed
    ? (typeof classifyParsed[step.field!] === "string"
        ? classifyParsed[step.field!] as string
        : JSON.stringify(classifyParsed[step.field!] ?? ""))
    : classifyParams;

  const hasSymbols = (fieldValue as string).includes(SYM_PATTERN);

  if (step.policy === "resolve") {
    if (!hasSymbols) return [label, true, `field "${step.field}" has no symbols (nothing to resolve)`];

    const resolveEntry = entries.find((e) =>
      e.toolName === step.tool
      && e.hookType === "before_tool_call"
      && e.taintAction === "resolve_symbol",
    );
    if (!resolveEntry) {
      return [label, false, `field "${step.field}" has symbols but no resolve_symbol entry`];
    }

    const resolvedParams = resolveEntry.modifiedHead ?? "";
    let resolvedParsed: Record<string, unknown> | null = null;
    try { resolvedParsed = JSON.parse(resolvedParams); } catch { /* truncated */ }

    const resolvedFieldValue = resolvedParsed
      ? (typeof resolvedParsed[step.field!] === "string"
          ? resolvedParsed[step.field!] as string
          : JSON.stringify(resolvedParsed[step.field!] ?? ""))
      : resolvedParams;

    if ((resolvedFieldValue as string).includes(SYM_PATTERN)) {
      return [label, false, `field "${step.field}" still has symbols after resolution`];
    }
    return [label, true, `field "${step.field}" had symbols -> resolved correctly`];
  }

  // policy === "not_resolve"
  const resolveEntry = entries.find((e) =>
    e.toolName === step.tool
    && e.hookType === "before_tool_call"
    && e.taintAction === "resolve_symbol",
  );
  if (resolveEntry) {
    return [label, false, `resolve_symbol entry exists for ${step.tool} (policy: not_resolve)`];
  }
  if (hasSymbols) {
    return [label, true, `field "${step.field}" has symbols, correctly preserved`];
  }
  return [label, true, `field "${step.field}" has no symbols and no resolve_symbol (correct)`];
}

function evalToolOutputPolicy(step: Step, entries: AuditEntry[], symPfx: string): Result {
  const label = step.label ?? (step.field ? `${step.tool}/output-policy/${step.field}` : `${step.tool}/output-policy`);
  const SYM_PATTERN = symPfx;

  if (!entries.some((e) => e.toolName === step.tool)) {
    return [label, true, `skipped (${step.tool} not called)`];
  }

  const resultEntry = entries.find((e) =>
    e.toolName === step.tool && isToolResultHook(e.hookType),
  );
  if (!resultEntry) return [label, false, `no tool_result entry for ${step.tool}`];

  if (resultEntry.taintAction === "inspect_error") {
    return [label, true, `skipped (${step.tool} errored: taintAction=inspect_error)`];
  }

  const originalText = resultEntry.originalHead ?? "";
  const modifiedText = resultEntry.modifiedHead ?? "";

  const stripPrefix = (s: string) => s.replace(/^\[DualView:SYMBOLIZED[^\]]*\]\n/, "");

  let originalParsed: Record<string, unknown> | null = null;
  let modifiedParsed: Record<string, unknown> | null = null;
  try { originalParsed = JSON.parse(originalText); } catch { /* truncated */ }
  try { modifiedParsed = JSON.parse(stripPrefix(modifiedText)); } catch { /* truncated */ }

  const getField = (parsed: Record<string, unknown> | null, raw: string, field: string): string => {
    if (parsed && parsed[field] !== undefined) {
      return typeof parsed[field] === "string" ? parsed[field] as string : JSON.stringify(parsed[field]);
    }
    return raw;
  };

  // field: "*" — dynamic per-field check
  if (step.field === "*") {
    if (!modifiedParsed || typeof modifiedParsed !== "object") {
      return [label, false, `could not parse modified result as JSON for "*" check (${snippet(modifiedText)})`];
    }
    const fields = Object.entries(modifiedParsed);
    if (fields.length === 0) return [label, false, "modified result has no fields"];
    for (const [key, val] of fields) {
      if (key.includes(SYM_PATTERN)) return [label, false, `key "${key}" contains symbols`];
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      if (step.trust === "untrusted" && !valStr.includes(SYM_PATTERN)) {
        return [label, false, `value for key "${key}" has no symbols (expected UNTRUSTED)`];
      }
      if (step.trust !== "untrusted" && valStr.includes(SYM_PATTERN)) {
        return [label, false, `value for key "${key}" has symbols (expected TRUSTED)`];
      }
    }
    return [label, true, `all ${fields.length} fields checked (keys trusted, values ${step.trust})`];
  }

  if (step.trust === "pass_through") {
    if (resultEntry.taintAction !== "classify_trusted") {
      return [label, false, `taintAction is "${resultEntry.taintAction}", expected classify_trusted`];
    }
    return [label, true, "classified as trusted (content may contain pre-existing symbols)"];
  }

  const fieldName = step.field ?? "(whole result)";
  const originalField = step.field ? getField(originalParsed, originalText, step.field) : originalText;
  const modifiedField = step.field ? getField(modifiedParsed, modifiedText, step.field) : modifiedText;

  if (step.trust === "untrusted") {
    if (!modifiedField.includes(SYM_PATTERN)) {
      return [label, false, `${fieldName} in modified result has no symbols (expected UNTRUSTED)`];
    }
    if (originalField.includes(SYM_PATTERN)) {
      return [label, false, `${fieldName} in original result has symbols (should be raw)`];
    }
    return [label, true, `${fieldName} correctly symbolized (original=raw, modified=symbolized)`];
  }

  // trust === "trusted"
  if (modifiedField.includes(SYM_PATTERN)) {
    return [label, false, `${fieldName} in modified result has symbols (expected TRUSTED)`];
  }
  return [label, true, `${fieldName} correctly trusted (no symbols in modified result)`];
}

function evalWebhookOutputPolicy(step: Step, entries: AuditEntry[], symPfx: string): Result {
  const label = step.label ?? `webhook/output-policy/${step.field}`;
  const SYM_PATTERN = symPfx;

  const entry = entries.find((e) => e.hookType === "transform_webhook_content");
  if (!entry) return [label, false, "no transform_webhook_content audit entry found"];

  const originalText = entry.originalHead ?? "";
  const modifiedText = entry.modifiedHead ?? "";

  // Extract the payload "data" object from originalHead.
  // The JSON may be inside a ```json fenced block or within
  // <<<EXTERNAL_UNTRUSTED_CONTENT>>> tags as raw JSON.
  const extractPayloadData = (text: string): Record<string, unknown> | null => {
    const fenced = text.match(/```json\s+([\s\S]*?)\s*```/);
    if (fenced) {
      const clean = fenced[1]!.replace(/^\[DualView:(?:SYMBOLIZED|UNTRUSTED)[^\]]*\]\n/, "");
      try { const p = JSON.parse(clean); return p?.data ?? p; } catch { /* fall through */ }
    }
    const ext = text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT/);
    if (ext) {
      const m = ext[1]!.match(/\{[\s\S]*\}/);
      if (m) { try { const p = JSON.parse(m[0]); return p?.data ?? p; } catch { /* fall through */ } }
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { const p = JSON.parse(m[0]); return p?.data ?? p; } catch { /* fall through */ } }
    return null;
  };

  const originalData = extractPayloadData(originalText);
  if (!originalData) return [label, false, "could not parse JSON from original webhook message"];

  const origVal = originalData[step.field!];
  if (origVal === undefined) return [label, false, `field "${step.field}" not found in original`];
  const origStr = typeof origVal === "string" ? origVal : JSON.stringify(origVal);

  // modifiedHead is a rendered template (not JSON). Check whether a symbol
  // referencing this field appears in the text.
  // Check if the modified text contains a symbol that includes this field name.
  // Uses the prefix-based approach to work with any symbol format.
  const escapedField = step.field!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldSymRe = new RegExp(`${SYM_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s]*${escapedField}`);
  const modifiedHasFieldSymbol = fieldSymRe.test(modifiedText);

  if (step.trust === "untrusted") {
    if (!modifiedHasFieldSymbol) return [label, false, `${step.field} has no symbols (expected UNTRUSTED)`];
    if (origStr.includes(SYM_PATTERN)) return [label, false, `${step.field} in original has symbols (should be raw)`];
    return [label, true, `${step.field} correctly symbolized`];
  }
  if (modifiedHasFieldSymbol) return [label, false, `${step.field} has symbols (expected TRUSTED)`];
  return [label, true, `${step.field} correctly trusted`];
}

function evalToolResult(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "tool_result";
  const target = step.target ?? "original";

  const entry = entries.find((e) => e.toolName === step.tool && isToolResultHook(e.hookType));
  if (!entry) return [label, false, `no tool result entry for ${step.tool}`];

  const text = target === "modified"
    ? (entry.modifiedText ?? entry.modifiedHead ?? "")
    : (entry.originalText ?? entry.originalHead ?? "");

  if (step.contains && !text.includes(step.contains)) {
    return [label, false, `${target} result does not contain "${step.contains}" (got: "${snippet(text)}")`];
  }
  if (step.not_contains && text.includes(step.not_contains)) {
    return [label, false, `${target} result contains "${step.not_contains}" (should not)`];
  }
  if (step.matches && !new RegExp(step.matches).test(text)) {
    return [label, false, `${target} result does not match /${step.matches}/`];
  }

  return [label, true, `tool ${step.tool} result check passed (${target})`];
}

function evalSymbolResolved(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "resolve_symbol";
  const entry = entries.find((e) =>
    e.toolName === step.tool
    && e.hookType === "before_tool_call"
    && e.taintAction === "resolve_symbol",
  );
  if (entry) return [label, true, `symbols resolved in ${step.tool} params via resolve_symbol`];
  return [label, false, `no resolve_symbol audit entry for ${step.tool}`];
}

function evalSymbolAllocated(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "symbol_allocated";
  const minCount = step.min_count ?? 1;

  const matches = entries.filter((e) => e.toolName === step.tool && e.taintAction === "symbolize");
  if (matches.length === 0) return [label, false, `no symbolize entry for ${step.tool}`];

  const entry = matches[0]!;
  const symbolsCreated = entry.extra?.symbolsCreated;
  if (typeof symbolsCreated === "number" && symbolsCreated < minCount) {
    return [label, false, `${symbolsCreated} symbols created (expected >= ${minCount})`];
  }

  return [label, true, `symbols allocated for ${step.tool}`];
}

function evalInspectResymbolized(step: Step, entries: AuditEntry[], symPfx: string): Result {
  const label = step.label ?? "inspect_resymbolized";

  const entry = entries.find((e) => e.hookType === "inspect_symbol" && e.taintAction === "symbolize");
  if (!entry) return [label, false, "no inspect_symbol audit entry"];

  if (step.has_derived_symbols !== false) {
    const modified = entry.modifiedText ?? entry.modifiedHead ?? "";
    if (!modified.includes(symPfx)) {
      return [label, false, `no derived ${symPfx} symbols in inspect output`];
    }
  }

  if (step.output_fields_present !== false) {
    const fields = entry.outputFields ?? [];
    if (fields.length === 0) return [label, false, "no outputFields in inspect audit entry"];
  }

  return [label, true, "inspect_symbol re-symbolization verified"];
}

function evalAuditEntryExists(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "audit_entry_exists";
  const matched = queryAuditEntries(entries, step.where as Record<string, FieldMatcherOrValue>);

  if (matched.length === 0) {
    return [label, false, `no audit entry matching ${JSON.stringify(step.where)}`];
  }
  if (step.count !== undefined && matched.length !== step.count) {
    return [label, false, `expected ${step.count} entries, found ${matched.length}`];
  }

  if (step.check) {
    for (const [field, matcher] of Object.entries(step.check)) {
      const entry = matched[0]!;
      const value = getNestedField(entry, field);
      const [passed, reason] = evaluateFieldMatcher(value, matcher as FieldMatcherOrValue);
      if (!passed) return [label, false, `field ${field}: ${reason}`];
    }
  }

  return [label, true, `${matched.length} matching audit entry(ies) found`];
}

function evalAuditEntryAbsent(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "audit_entry_absent";
  const matched = queryAuditEntries(entries, step.where as Record<string, FieldMatcherOrValue>);

  if (matched.length > 0) {
    return [label, false, `found ${matched.length} entries matching ${JSON.stringify(step.where)} (expected none)`];
  }
  return [label, true, "no matching audit entries (as expected)"];
}

function evalAuditSequence(step: Step, entries: AuditEntry[]): Result {
  const label = step.label ?? "audit_sequence";
  const seqSteps = step.steps!;

  // Skip if any referenced tool was never called
  const referencedTools = new Set(seqSteps.map((s) => s.toolName).filter(Boolean) as string[]);
  for (const t of referencedTools) {
    if (!entries.some((e) => e.toolName === t)) {
      return [label, true, `skipped (${t} not called)`];
    }
  }

  let lastTs = "";
  for (let i = 0; i < seqSteps.length; i++) {
    const where = seqSteps[i]!;
    const candidates = queryAuditEntries(entries, where as Record<string, FieldMatcherOrValue>)
      .filter((e) => e.ts > lastTs);

    if (candidates.length === 0) {
      return [label, false, `sequence step ${i + 1} (${JSON.stringify(where)}) has no match after ts=${lastTs}`];
    }
    lastTs = candidates[0]!.ts;
  }

  return [label, true, `all ${seqSteps.length} sequence steps found in order`];
}


// ── Step dispatcher ─────────────────────────────────────────────────────────

function evaluateStepStatic(step: Step, entries: AuditEntry[], taintMode: string, symPfx: string): Result {
  // Resolve canonical type names (from plugin/dualview/correctness.yaml) to the
  // legacy names used by these static evaluators.
  const assertType = resolveAssertType(step.assert);
  switch (assertType) {
    case "tool_result_ok":        return evalToolResultOk(step, entries);
    case "tool_symbolized":       return evalToolSymbolized(step, entries, taintMode, symPfx);
    case "tool_labeled":          return evalToolLabeled(step, entries);
    case "tool_trusted":          return evalToolTrusted(step, entries);
    case "tool_untrusted":        return evalToolUntrusted(step, entries);
    case "tool_not_called":       return evalToolNotCalled(step, entries);
    case "tool_call_count":       return evalToolCallCount(step, entries);
    case "tool_params":           return evalToolParams(step, entries);
    case "tool_input_policy":     return evalToolInputPolicy(step, entries, symPfx);
    case "tool_output_policy":    return evalToolOutputPolicy(step, entries, symPfx);
    case "webhook_output_policy": return evalWebhookOutputPolicy(step, entries, symPfx);
    case "tool_result":           return evalToolResult(step, entries);
    case "resolve_symbol":        return evalSymbolResolved(step, entries);
    case "symbol_allocated":      return evalSymbolAllocated(step, entries);
    case "inspect_resymbolized":  return evalInspectResymbolized(step, entries, symPfx);
    case "audit_entry_exists":    return evalAuditEntryExists(step, entries);
    case "audit_entry_absent":    return evalAuditEntryAbsent(step, entries);
    case "audit_sequence":        return evalAuditSequence(step, entries);
    default:
      return [step.label ?? step.assert, false, `unknown assertion type: ${step.assert}`];
  }
}


// ── Placement extraction (tool name from step) ─────────────────────────────

function extractTool(step: Step): string | undefined {
  if (step.tool) return step.tool;
  if (step.tool_name) return step.tool_name;
  if (step.where && typeof (step.where as Record<string, unknown>).toolName === "string") {
    return (step.where as Record<string, string>).toolName;
  }
  return undefined;
}


// ── Main entry point ────────────────────────────────────────────────────────

export function evaluateBotAssertions(
  batchId: string,
  baseDir?: string,
): BotAssertionResponse {
  const taintMode = readBotTaintMode(batchId, baseDir);
  const rawEntries = getBotAudit(batchId, baseDir) as AuditEntry[];
  const tools = discoverTools(rawEntries);
  const symFmt = resolveSymbolFormat(batchId, baseDir);
  const toolSet = new Set(tools);

  // If the bot batch has no audit entries at all, skip assertion loading —
  // nonexistent batches should return an empty response.
  if (rawEntries.length === 0) {
    return { taintMode, permissive: true, tools, templates: [], results: [] };
  }

  // Load the unified correctness assertion set and substitute placeholders
  // ({SYM_PREFIX}) from the batch's configured symbol format.
  const correctnessSteps = loadCorrectnessSteps();
  const steps = correctnessSteps.map((s) => {
    const substituted = substitutePlaceholdersDeep(s, symFmt.prefix);
    // Preserve template metadata (not a string, so untouched by substitution).
    substituted._template = s._template;
    substituted._templateIdx = s._templateIdx;
    return substituted;
  });

  const results: BotAssertionResult[] = [];
  const templateId = "dualview_correctness";

  const mkResult = (
    step: Step,
    status: "pass" | "fail" | "skip",
    label: string,
    reason: string,
  ): BotAssertionResult => ({
    status,
    label,
    description: step.description,
    reason,
    category: "correctness",
    tool: extractTool(step),
    assert: resolveAssertType(step.assert),
    template: step._template ?? templateId,
    tidx: step._templateIdx,
  });

  for (const step of steps) {
    const stepLabel = step.label ?? resolveAssertType(step.assert);

    // Skip inactive assertions
    if (step.active === false) {
      results.push(mkResult(step, "skip", stepLabel, "skipped (inactive)"));
      continue;
    }

    // _require_tool gating: some global assertions (e.g. inspect_symbol hook
    // checks) should only run when the named tool has audit entries.
    const requireTool = (step as unknown as Record<string, unknown>)._require_tool;
    if (typeof requireTool === "string" && !toolSet.has(requireTool)) {
      results.push(mkResult(step, "skip", stepLabel, `skipped (${requireTool} not called)`));
      continue;
    }

    // Check when condition
    if (!shouldRun(step.when, taintMode)) {
      results.push(mkResult(
        step, "skip", stepLabel,
        `condition not met: mode=${step.when?.mode ?? "any"} (current: ${taintMode})`,
      ));
      continue;
    }

    // Check if assertion type is supported by the static evaluator set.
    // Both the raw type and its resolved canonical name are checked so that
    // legacy YAMLs (tool_input_policy) and new ones (tool_outbound) are
    // filtered consistently.
    const resolvedType = resolveAssertType(step.assert);
    if (UNSUPPORTED_TYPES.has(step.assert) || UNSUPPORTED_TYPES.has(resolvedType)) {
      results.push(mkResult(step, "skip", stepLabel, `not supported in bot mode (${step.assert})`));
      continue;
    }

    if (shouldOmitBotAssertion(step, rawEntries, toolSet)) {
      continue;
    }

    // Evaluate
    try {
      const [label, passed, reason] = evaluateStepStatic(step, rawEntries, taintMode, symFmt.prefix);
      results.push(mkResult(step, passed ? "pass" : "fail", label, reason));
    } catch (err) {
      results.push(mkResult(step, "fail", stepLabel, `evaluation error: ${err}`));
    }
  }

  return {
    taintMode,
    permissive: true,
    tools,
    templates: results.length > 0 ? [templateId] : [],
    results,
  };
}
