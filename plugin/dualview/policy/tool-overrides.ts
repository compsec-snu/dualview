/**
 * Per-tool policy overrides sourced from YAML.
 *
 * Unifies what used to live in two separate JSON surfaces:
 *   - `toolSchemas`      (inbound)  — openclaw.json
 *   - `toolInputResolve` (outbound) — openclaw.json
 *
 * Both are now expressible in a single YAML section alongside the
 * category-level policies (URL, CHANNEL, DIR). Built-in defaults
 * (TOOL_INBOUND_SPEC / TOOL_INPUT_RESOLVE / TOOL_INPUT_FIELD_POLICY)
 * stay in TypeScript; YAML entries override an existing tool or add a
 * new one.
 *
 *   tools:
 *     web_fetch:
 *       inbound:                 # overrides TOOL_INBOUND_SPEC.web_fetch.schema
 *         url: TRUSTED
 *         text: UNTRUSTED
 *       outbound:                # overrides TOOL_INPUT_RESOLVE / _FIELD_POLICY
 *         url: resolve
 *     read:
 *       inbound: TRUSTED         # whole-tool literal
 *       outbound:
 *         file_path: not_resolve
 *     my_custom_tool:            # new tool — added to the maps
 *       inbound: UNTRUSTED
 *       outbound: resolve        # scalar form → tool-level resolve=true
 */

import type { SchemaNode, ToolSpec } from "./schema-types.js";
import { isActionSpec } from "./schema-types.js";
import { TOOL_INBOUND_SPEC } from "./tool-inbound.js";
import {
  TOOL_INPUT_RESOLVE,
  TOOL_INPUT_FIELD_POLICY,
  type InputFieldPolicy,
} from "./tool-outbound.js";

export type ToolInboundOverride = SchemaNode;

export type ToolOutboundOverride =
  | "resolve"
  | "not_resolve"
  | Record<string, InputFieldPolicy>;

export interface ToolPolicyEntry {
  inbound?: ToolInboundOverride;
  outbound?: ToolOutboundOverride;
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const VALID_FIELD_POLICIES: ReadonlySet<string> = new Set([
  "resolve",
  "not_resolve",
  "no_symbols_expected",
]);

function isFieldPolicy(v: unknown): v is InputFieldPolicy {
  return typeof v === "string" && VALID_FIELD_POLICIES.has(v);
}

/**
 * Apply YAML `tools` overrides on top of the built-in maps.
 *
 * The built-in exports TOOL_INBOUND_SPEC, TOOL_INPUT_RESOLVE, and
 * TOOL_INPUT_FIELD_POLICY are mutated in place — later lookups from
 * `getToolInboundSpec` and the runtime outbound gate see the merged view.
 */
export function mergeToolOverrides(
  tools: Record<string, ToolPolicyEntry> | undefined,
  log: Logger,
): void {
  if (!tools) return;
  for (const [toolName, entry] of Object.entries(tools)) {
    if (!toolName) {
      log.warn(`[DualView] policy: skipping tool override with empty name`);
      continue;
    }
    if (entry == null || typeof entry !== "object") {
      log.warn(`[DualView] policy: tool "${toolName}" override must be an object`);
      continue;
    }
    if (entry.inbound !== undefined) mergeInbound(toolName, entry.inbound, log);
    if (entry.outbound !== undefined) mergeOutbound(toolName, entry.outbound, log);
  }
}

function mergeInbound(
  toolName: string,
  override: ToolInboundOverride,
  log: Logger,
): void {
  const existing = TOOL_INBOUND_SPEC[toolName];
  if (existing && isActionSpec(existing)) {
    log.warn(
      `[DualView] policy: tool "${toolName}" is action-dispatched; YAML override ` +
      `replaces the entire action map with a flat schema`,
    );
  }
  const merged: ToolSpec = {
    ...(existing && !isActionSpec(existing) && existing.paramsKeys
      ? { paramsKeys: existing.paramsKeys }
      : {}),
    schema: override as SchemaNode,
  };
  TOOL_INBOUND_SPEC[toolName] = merged;
  log.info(`[DualView] policy: tool "${toolName}" inbound override registered`);
}

function mergeOutbound(
  toolName: string,
  override: ToolOutboundOverride,
  log: Logger,
): void {
  if (override === "resolve" || override === "not_resolve") {
    TOOL_INPUT_RESOLVE[toolName] = override === "resolve";
    log.info(`[DualView] policy: tool "${toolName}" outbound resolve=${override === "resolve"}`);
    return;
  }
  if (typeof override !== "object" || override === null) {
    log.warn(
      `[DualView] policy: tool "${toolName}" outbound must be "resolve" | "not_resolve" | object`,
    );
    return;
  }
  const fieldMap: Record<string, InputFieldPolicy> = { ...(TOOL_INPUT_FIELD_POLICY[toolName] ?? {}) };
  let hasResolve = false;
  for (const [field, policy] of Object.entries(override)) {
    if (!isFieldPolicy(policy)) {
      log.warn(
        `[DualView] policy: tool "${toolName}" field "${field}" has invalid policy ` +
        `"${String(policy)}" (expected resolve | not_resolve | no_symbols_expected)`,
      );
      continue;
    }
    fieldMap[field] = policy;
    if (policy === "resolve") hasResolve = true;
  }
  TOOL_INPUT_FIELD_POLICY[toolName] = fieldMap;
  TOOL_INPUT_RESOLVE[toolName] = hasResolve;
  log.info(
    `[DualView] policy: tool "${toolName}" outbound per-field override registered ` +
    `(${Object.keys(override).length} fields, tool-level resolve=${hasResolve})`,
  );
}

// ─── Test helpers ──────────────────────────────────────────────────────────

export interface ToolPolicySnapshot {
  inbound: Record<string, ToolSpec>;
  resolve: Record<string, boolean>;
  fieldPolicy: Record<string, Record<string, InputFieldPolicy>>;
}

/** Snapshot the three tool-policy maps so tests can restore them. */
export function _snapshotToolPoliciesForTests(): ToolPolicySnapshot {
  return {
    inbound: { ...TOOL_INBOUND_SPEC },
    resolve: { ...TOOL_INPUT_RESOLVE },
    fieldPolicy: Object.fromEntries(
      Object.entries(TOOL_INPUT_FIELD_POLICY).map(([k, v]) => [k, { ...v }]),
    ),
  };
}

/** Restore the three tool-policy maps from a prior snapshot. */
export function _restoreToolPoliciesForTests(snap: ToolPolicySnapshot): void {
  for (const k of Object.keys(TOOL_INBOUND_SPEC)) delete TOOL_INBOUND_SPEC[k];
  Object.assign(TOOL_INBOUND_SPEC, snap.inbound);
  for (const k of Object.keys(TOOL_INPUT_RESOLVE)) delete TOOL_INPUT_RESOLVE[k];
  Object.assign(TOOL_INPUT_RESOLVE, snap.resolve);
  for (const k of Object.keys(TOOL_INPUT_FIELD_POLICY)) delete TOOL_INPUT_FIELD_POLICY[k];
  Object.assign(TOOL_INPUT_FIELD_POLICY, snap.fieldPolicy);
}
