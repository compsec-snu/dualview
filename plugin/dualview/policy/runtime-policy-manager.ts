import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";

import {
  loadPolicyFile,
  getExplicitUntrustedDirPolicyPaths,
  type CategoryPolicyConfig,
  type PolicyFileConfig,
} from "./load-policy.js";
import { createPolicyEngine, type PolicyEngine } from "./policy-engine.js";
import {
  _restoreToolPoliciesForTests,
  _snapshotToolPoliciesForTests,
  type ToolOutboundOverride,
  type ToolPolicyEntry,
  type ToolPolicySnapshot,
} from "./tool-overrides.js";
import { TOOL_INBOUND_SPEC } from "./tool-inbound.js";
import {
  TOOL_INPUT_FIELD_POLICY,
  TOOL_INPUT_RESOLVE,
  type InputFieldPolicy,
} from "./tool-outbound.js";
import type { ToolSpec } from "./schema-types.js";

type CategoryId = "URL" | "CHANNEL" | "DIR";
type PolicySource = "built-in" | "yaml" | "session";
type CategoryListField = "trustedList" | "untrustedList";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface RuntimePolicyChange {
  engine: PolicyEngine;
  effectivePolicyFile: PolicyFileConfig | null;
  explicitUntrustedDirPolicyPaths: string[];
}

export interface DataTrustPolicyRuntimeManagerOptions {
  policyPath?: string;
  basePath: string;
  log: Logger;
  policyFile?: PolicyFileConfig | null;
  onChange?: (change: RuntimePolicyChange) => void;
}

export interface PolicyMutationResult {
  ok: boolean;
  message: string;
  persist: boolean;
  policyKind: string;
  source: "session" | "yaml";
  changed: boolean;
  effectivePolicy?: DataTrustPolicyList;
}

export interface PolicyAddRequest {
  persist?: boolean;
  policyKind?: string;
  category?: string;
  list?: string;
  entry?: string;
}

export interface PolicyDeleteRequest {
  persist?: boolean;
  policyKind?: string;
  category?: string;
  list?: string;
  entry?: string;
}

export interface DataTrustPolicyList {
  name: "Data Trust Policy";
  summary: string;
  policyPath: string | null;
  categoryPolicies: Array<{
    category: CategoryId;
    default: "TRUSTED" | "UNTRUSTED";
    defaultSource: PolicySource;
    trustedList: Array<{ value: string; source: PolicySource }>;
    untrustedList: Array<{ value: string; source: PolicySource }>;
  }>;
  toolInboundSchemas: Array<{
    toolName: string;
    source: PolicySource;
    spec: ToolSpec;
  }>;
  relatedResolutionPolicy: Array<{
    toolName: string;
    source: PolicySource;
    outbound: ToolOutboundOverride;
  }>;
  sessionOverlay: PolicyFileConfig | null;
}

const BUILTIN_TOOL_POLICIES: ToolPolicySnapshot = _snapshotToolPoliciesForTests();

const BUILTIN_CATEGORY_POLICIES: Record<CategoryId, {
  default: "TRUSTED" | "UNTRUSTED";
  trustedList: string[];
  untrustedList: string[];
}> = {
  URL: { default: "UNTRUSTED", trustedList: [], untrustedList: [] },
  CHANNEL: { default: "TRUSTED", trustedList: [], untrustedList: [] },
  DIR: { default: "TRUSTED", trustedList: [], untrustedList: [] },
};

function clonePolicyFile(policy: PolicyFileConfig | null | undefined): PolicyFileConfig | null {
  if (!policy) return null;
  return JSON.parse(JSON.stringify(policy)) as PolicyFileConfig;
}

function emptyPolicyFile(): PolicyFileConfig {
  return { inbound: {}, tools: {} };
}

function prunePolicyFile(policy: PolicyFileConfig): PolicyFileConfig {
  if (policy.tools && Object.keys(policy.tools).length === 0) delete policy.tools;
  if (policy.inbound && Object.keys(policy.inbound).length === 0) delete policy.inbound;
  return policy;
}

function ensureInbound(policy: PolicyFileConfig): NonNullable<PolicyFileConfig["inbound"]> {
  if (!policy.inbound) policy.inbound = {};
  return policy.inbound;
}

function ensureTools(policy: PolicyFileConfig): Record<string, ToolPolicyEntry> {
  if (!policy.tools) policy.tools = {};
  return policy.tools;
}

function categoryKey(category: CategoryId): "url" | "channel" | "dir" {
  switch (category) {
    case "URL": return "url";
    case "CHANNEL": return "channel";
    case "DIR": return "dir";
  }
}

function normalizeCategory(category: string | undefined): CategoryId | null {
  const upper = category?.toUpperCase();
  if (upper === "URL" || upper === "CHANNEL" || upper === "DIR") return upper;
  return null;
}

function normalizeListField(list: string | undefined): CategoryListField | null {
  const normalized = list?.trim().toLowerCase();
  if (
    normalized === "trusted" ||
    normalized === "trust" ||
    normalized === "allow" ||
    normalized === "allowlist" ||
    normalized === "trustedlist"
  ) {
    return "trustedList";
  }
  if (
    normalized === "untrusted" ||
    normalized === "block" ||
    normalized === "blocklist" ||
    normalized === "deny" ||
    normalized === "denylist" ||
    normalized === "untrustedlist"
  ) {
    return "untrustedList";
  }
  return null;
}

function defaultForListField(field: CategoryListField): "TRUSTED" | "UNTRUSTED" {
  return field === "trustedList" ? "UNTRUSTED" : "TRUSTED";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === "string" && v.length > 0)));
}

function mergeCategoryConfig(
  base: CategoryPolicyConfig | undefined,
  override: CategoryPolicyConfig | undefined,
): CategoryPolicyConfig | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base?.default !== undefined || override?.default !== undefined
      ? { default: override?.default ?? base?.default }
      : {}),
    trustedList: unique([...(base?.trustedList ?? []), ...(override?.trustedList ?? [])]),
    untrustedList: unique([...(base?.untrustedList ?? []), ...(override?.untrustedList ?? [])]),
  };
}

function mergePolicyFiles(
  yamlPolicy: PolicyFileConfig | null,
  sessionOverlay: PolicyFileConfig | null,
): PolicyFileConfig | null {
  const out: PolicyFileConfig = {};

  for (const source of [yamlPolicy, sessionOverlay]) {
    if (!source) continue;
    if (source.inbound) {
      const inbound = ensureInbound(out);
      inbound.url = mergeCategoryConfig(inbound.url, source.inbound.url);
      inbound.channel = mergeCategoryConfig(inbound.channel, source.inbound.channel);
      inbound.dir = mergeCategoryConfig(inbound.dir, source.inbound.dir);

      if (source.inbound["url-trust"]?.trustedUrls?.length) {
        inbound.url = mergeCategoryConfig(inbound.url, {
          default: "UNTRUSTED",
          trustedList: source.inbound["url-trust"].trustedUrls,
        });
      }
      if (source.inbound["channel-trust"]?.untrustedChannels?.length) {
        inbound.channel = mergeCategoryConfig(inbound.channel, {
          default: "TRUSTED",
          untrustedList: source.inbound["channel-trust"].untrustedChannels,
        });
      }
      if (source.inbound["dir-trust"]?.untrustedDirs?.length) {
        inbound.dir = mergeCategoryConfig(inbound.dir, {
          default: "TRUSTED",
          untrustedList: source.inbound["dir-trust"].untrustedDirs,
        });
      }

      if (source.inbound.command) {
        inbound.command = [...(inbound.command ?? []), ...source.inbound.command];
      }
      if (source.inbound["url-trust"]) inbound["url-trust"] = source.inbound["url-trust"];
      if (source.inbound["channel-trust"]) inbound["channel-trust"] = source.inbound["channel-trust"];
      if (source.inbound["dir-trust"]) inbound["dir-trust"] = source.inbound["dir-trust"];
    }

    if (source.tools) {
      const tools = ensureTools(out);
      for (const [toolName, entry] of Object.entries(source.tools)) {
        tools[toolName] = { ...(tools[toolName] ?? {}), ...entry };
      }
    }
  }

  if (out.inbound) {
    for (const key of ["url", "channel", "dir"] as const) {
      const cfg = out.inbound[key];
      if (cfg) {
        cfg.trustedList = unique(cfg.trustedList ?? []);
        cfg.untrustedList = unique(cfg.untrustedList ?? []);
      }
    }
  }

  if (!out.inbound && !out.tools) return null;
  if (out.tools && Object.keys(out.tools).length === 0) delete out.tools;
  return out;
}

function loadPolicyForWrite(policyPath: string, basePath: string, log: Logger): PolicyFileConfig {
  const resolved = resolve(basePath, policyPath);
  if (!existsSync(resolved)) return emptyPolicyFile();
  return loadPolicyFile(policyPath, basePath, log) ?? emptyPolicyFile();
}

function writePolicyFile(policyPath: string, basePath: string, policy: PolicyFileConfig): void {
  const resolved = resolve(basePath, policyPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, yaml.dump(policy, { noRefs: true, sortKeys: false }), "utf-8");
}

function addCategoryEntry(policy: PolicyFileConfig, category: CategoryId, field: CategoryListField, entry: string): boolean {
  const inbound = ensureInbound(policy);
  const key = categoryKey(category);
  const existing = inbound[key] ?? {};
  const values = unique([...(existing[field] ?? []), entry]);
  const changed = values.length !== (existing[field] ?? []).length;
  inbound[key] = {
    ...existing,
    default: defaultForListField(field),
    [field]: values,
  };
  return changed || existing.default !== defaultForListField(field);
}

function removeCategoryEntry(policy: PolicyFileConfig, category: CategoryId, field: CategoryListField, entry: string): boolean {
  const inbound = policy.inbound;
  if (!inbound) return false;
  const key = categoryKey(category);
  const cfg = inbound[key];
  const before = cfg?.[field] ?? [];
  if (!cfg || !before.includes(entry)) return false;
  const after = before.filter((value) => value !== entry);
  cfg[field] = after;
  return true;
}

function outboundFromMaps(
  toolName: string,
  resolveMap: Record<string, boolean>,
  fieldPolicy: Record<string, Record<string, InputFieldPolicy>>,
): ToolOutboundOverride | undefined {
  if (fieldPolicy[toolName]) return { ...fieldPolicy[toolName] };
  if (Object.prototype.hasOwnProperty.call(resolveMap, toolName)) {
    return resolveMap[toolName] ? "resolve" : "not_resolve";
  }
  return undefined;
}

function sourceForToolSection(
  toolName: string,
  section: "inbound" | "outbound",
  yamlPolicy: PolicyFileConfig | null,
  sessionOverlay: PolicyFileConfig | null,
): PolicySource | null {
  if (sessionOverlay?.tools?.[toolName]?.[section] !== undefined) return "session";
  if (yamlPolicy?.tools?.[toolName]?.[section] !== undefined) return "yaml";
  if (section === "inbound" && BUILTIN_TOOL_POLICIES.inbound[toolName] !== undefined) return "built-in";
  if (
    section === "outbound" &&
    (BUILTIN_TOOL_POLICIES.resolve[toolName] !== undefined ||
      BUILTIN_TOOL_POLICIES.fieldPolicy[toolName] !== undefined)
  ) {
    return "built-in";
  }
  return null;
}

function pushEntries(
  target: Array<{ value: string; source: PolicySource }>,
  values: string[] | undefined,
  source: PolicySource,
): void {
  for (const value of values ?? []) {
    if (!target.some((entry) => entry.value === value && entry.source === source)) {
      target.push({ value, source });
    }
  }
}

function buildCategoryList(
  category: CategoryId,
  yamlPolicy: PolicyFileConfig | null,
  sessionOverlay: PolicyFileConfig | null,
): DataTrustPolicyList["categoryPolicies"][number] {
  const key = categoryKey(category);
  const builtIn = BUILTIN_CATEGORY_POLICIES[category];
  const yamlCfg = yamlPolicy?.inbound?.[key];
  const sessionCfg = sessionOverlay?.inbound?.[key];

  let defaultValue = builtIn.default;
  let defaultSource: PolicySource = "built-in";
  if (yamlCfg?.default) {
    defaultValue = yamlCfg.default;
    defaultSource = "yaml";
  }
  if (sessionCfg?.default) {
    defaultValue = sessionCfg.default;
    defaultSource = "session";
  }

  const trustedList: Array<{ value: string; source: PolicySource }> = [];
  const untrustedList: Array<{ value: string; source: PolicySource }> = [];
  pushEntries(trustedList, builtIn.trustedList, "built-in");
  pushEntries(untrustedList, builtIn.untrustedList, "built-in");

  if (category === "URL") pushEntries(trustedList, yamlPolicy?.inbound?.["url-trust"]?.trustedUrls, "yaml");
  if (category === "CHANNEL") pushEntries(untrustedList, yamlPolicy?.inbound?.["channel-trust"]?.untrustedChannels, "yaml");
  if (category === "DIR") pushEntries(untrustedList, yamlPolicy?.inbound?.["dir-trust"]?.untrustedDirs, "yaml");

  pushEntries(trustedList, yamlCfg?.trustedList, "yaml");
  pushEntries(untrustedList, yamlCfg?.untrustedList, "yaml");
  pushEntries(trustedList, sessionCfg?.trustedList, "session");
  pushEntries(untrustedList, sessionCfg?.untrustedList, "session");

  return {
    category,
    default: defaultValue,
    defaultSource,
    trustedList,
    untrustedList,
  };
}

function persistedPath(policyPath: string | undefined, basePath: string): string | null {
  return policyPath ? resolve(basePath, policyPath) : null;
}

export class DataTrustPolicyRuntimeManager {
  private readonly basePath: string;
  private readonly log: Logger;
  private readonly policyPath?: string;
  private readonly onChange?: (change: RuntimePolicyChange) => void;
  private yamlPolicy: PolicyFileConfig | null;
  private sessionOverlay: PolicyFileConfig | null = null;
  private effectivePolicyFile: PolicyFileConfig | null = null;
  private engine: PolicyEngine;

  constructor(opts: DataTrustPolicyRuntimeManagerOptions) {
    this.basePath = opts.basePath;
    this.log = opts.log;
    this.policyPath = opts.policyPath;
    this.onChange = opts.onChange;
    this.yamlPolicy = clonePolicyFile(opts.policyFile ?? loadPolicyFile(opts.policyPath, opts.basePath, opts.log));
    this.engine = createPolicyEngine(undefined, this.basePath, this.log, null);
    this.reapply(false);
  }

  getEngine(): PolicyEngine {
    return this.engine;
  }

  getEffectivePolicyFile(): PolicyFileConfig | null {
    return clonePolicyFile(this.effectivePolicyFile);
  }

  getExplicitUntrustedDirPolicyPaths(): string[] {
    return getExplicitUntrustedDirPolicyPaths(this.effectivePolicyFile);
  }

  list(): DataTrustPolicyList {
    const inboundTools = Object.keys(TOOL_INBOUND_SPEC).sort();
    const outboundTools = Array.from(new Set([
      ...Object.keys(TOOL_INPUT_RESOLVE),
      ...Object.keys(TOOL_INPUT_FIELD_POLICY),
    ])).sort();

    return {
      name: "Data Trust Policy",
      summary:
        "Data Trust Policy controls inbound classification of data from tools and sources. " +
        "The related resolution policy shows when symbols are resolved on outbound tool inputs.",
      policyPath: persistedPath(this.policyPath, this.basePath),
      categoryPolicies: (["URL", "CHANNEL", "DIR"] as CategoryId[]).map((category) =>
        buildCategoryList(category, this.yamlPolicy, this.sessionOverlay),
      ),
      toolInboundSchemas: inboundTools.map((toolName) => ({
        toolName,
        source: sourceForToolSection(toolName, "inbound", this.yamlPolicy, this.sessionOverlay) ?? "built-in",
        spec: TOOL_INBOUND_SPEC[toolName]!,
      })),
      relatedResolutionPolicy: outboundTools
        .map((toolName) => {
          const outbound = outboundFromMaps(toolName, TOOL_INPUT_RESOLVE, TOOL_INPUT_FIELD_POLICY);
          const source = sourceForToolSection(toolName, "outbound", this.yamlPolicy, this.sessionOverlay);
          if (!outbound || !source) return null;
          return { toolName, source, outbound };
        })
        .filter((entry): entry is DataTrustPolicyList["relatedResolutionPolicy"][number] => entry !== null),
      sessionOverlay: clonePolicyFile(this.sessionOverlay),
    };
  }

  add(request: PolicyAddRequest): PolicyMutationResult {
    const persist = request.persist === true;
    const source = persist ? "yaml" : "session";
    if (request.policyKind !== "category") {
      return this.errorResult(
        "policy_add only supports category Data Trust Policy list entries (URL, CHANNEL, DIR). " +
          "Per-tool policy is read-only at runtime and must be changed in dualview-policy.yaml or code review.",
        persist,
        request.policyKind ?? "unknown",
        source,
      );
    }

    const category = normalizeCategory(request.category);
    const listField = normalizeListField(request.list);
    const entry = request.entry?.trim();
    if (!category || !listField || !entry) {
      return this.errorResult("category policy_add requires category, list, and entry", persist, "category", source);
    }

    const target = this.mutableTarget(persist);
    const changed = addCategoryEntry(target, category, listField, entry);
    this.commitTarget(persist, target);
    return this.successResult(
      `Added ${category} ${listField} entry to ${source} Data Trust Policy: ${entry}`,
      persist,
      "category",
      source,
      changed,
    );
  }

  delete(request: PolicyDeleteRequest): PolicyMutationResult {
    const persist = request.persist === true;
    const source = persist ? "yaml" : "session";
    if (request.policyKind !== "category") {
      return this.errorResult(
        "policy_del only supports category Data Trust Policy list entries (URL, CHANNEL, DIR). " +
          "Per-tool policy is read-only at runtime and must be changed in dualview-policy.yaml or code review.",
        persist,
        request.policyKind ?? "unknown",
        source,
      );
    }

    const category = normalizeCategory(request.category);
    const listField = normalizeListField(request.list);
    const entry = request.entry?.trim();
    if (!category || !listField || !entry) {
      return this.errorResult("category policy_del requires category, list, and entry", persist, "category", source);
    }

    const target = this.mutableTarget(persist);
    const changed = removeCategoryEntry(target, category, listField, entry);
    if (!changed) {
      return this.errorResult(
        `No ${source} ${category} ${listField} entry exists for ${entry}; built-in defaults cannot be deleted`,
        persist,
        "category",
        source,
      );
    }
    this.commitTarget(persist, target);
    return this.successResult(
      `Deleted ${category} ${listField} entry from ${source} Data Trust Policy: ${entry}`,
      persist,
      "category",
      source,
      true,
    );
  }

  clearSessionOverlay(): void {
    if (!this.sessionOverlay) return;
    this.sessionOverlay = null;
    this.reapply();
  }

  private mutableTarget(persist: boolean): PolicyFileConfig {
    if (persist) {
      if (!this.policyPath) {
        throw new Error("persist=true requires cfg.policyPath");
      }
      return clonePolicyFile(loadPolicyForWrite(this.policyPath, this.basePath, this.log)) ?? emptyPolicyFile();
    }
    return clonePolicyFile(this.sessionOverlay) ?? emptyPolicyFile();
  }

  private commitTarget(persist: boolean, target: PolicyFileConfig): void {
    prunePolicyFile(target);
    if (persist) {
      if (!this.policyPath) throw new Error("persist=true requires cfg.policyPath");
      writePolicyFile(this.policyPath, this.basePath, target);
      this.yamlPolicy = clonePolicyFile(target);
    } else {
      this.sessionOverlay = clonePolicyFile(target);
    }
    this.reapply();
  }

  private reapply(notify: boolean = true): void {
    _restoreToolPoliciesForTests(BUILTIN_TOOL_POLICIES);
    this.effectivePolicyFile = mergePolicyFiles(this.yamlPolicy, this.sessionOverlay);
    this.engine = createPolicyEngine(undefined, this.basePath, this.log, this.effectivePolicyFile);
    if (notify && this.onChange) {
      this.onChange({
        engine: this.engine,
        effectivePolicyFile: this.getEffectivePolicyFile(),
        explicitUntrustedDirPolicyPaths: this.getExplicitUntrustedDirPolicyPaths(),
      });
    }
  }

  private errorResult(
    message: string,
    persist: boolean,
    policyKind: string,
    source: "session" | "yaml",
  ): PolicyMutationResult {
    return {
      ok: false,
      message,
      persist,
      policyKind,
      source,
      changed: false,
    };
  }

  private successResult(
    message: string,
    persist: boolean,
    policyKind: string,
    source: "session" | "yaml",
    changed: boolean,
  ): PolicyMutationResult {
    return {
      ok: true,
      message,
      persist,
      policyKind,
      source,
      changed,
      effectivePolicy: this.list(),
    };
  }
}

export function createDataTrustPolicyRuntimeManager(
  opts: DataTrustPolicyRuntimeManagerOptions,
): DataTrustPolicyRuntimeManager {
  return new DataTrustPolicyRuntimeManager(opts);
}
