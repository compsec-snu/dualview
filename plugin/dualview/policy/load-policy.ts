import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

import type { ToolPolicyEntry } from "./tool-overrides.js";

// ── New config shapes (preferred) ──────────────────────────────────────
// inbound:
//   url:     { default: UNTRUSTED, trustedList: [...] }
//   channel: { default: TRUSTED,   untrustedList: [...] }
//   dir:     { default: TRUSTED,   untrustedList: [...] }

export interface CategoryPolicyConfig {
  default?: "TRUSTED" | "UNTRUSTED";
  trustedList?: string[];
  untrustedList?: string[];
}

// ── Legacy config shapes (deprecated, still parsed for back-compat) ───

export interface LegacyChannelTrustPolicyConfig {
  untrustedChannels?: string[];
}

export interface LegacyUrlTrustPolicyConfig {
  trustedUrls?: string[];
}

export interface LegacyDirTrustPolicyConfig {
  untrustedDirs?: string[];
}

export interface CommandEntryConfig {
  id: string;
  aliases?: string[];
  schema?: Record<string, unknown>;
  trustErrors?: boolean;
  trustHelp?: boolean;
  subcommands?: Record<string, {
    schema: Record<string, unknown>;
    allowedFlags?: string[];
    trustErrors?: boolean;
    trustHelp?: boolean;
  }>;
}

export interface PolicyFileConfig {
  inbound?: {
    // New
    url?: CategoryPolicyConfig;
    channel?: CategoryPolicyConfig;
    dir?: CategoryPolicyConfig;
    command?: CommandEntryConfig[];
    // Legacy (deprecated)
    "channel-trust"?: LegacyChannelTrustPolicyConfig;
    "url-trust"?: LegacyUrlTrustPolicyConfig;
    "dir-trust"?: LegacyDirTrustPolicyConfig;
  };
  /**
   * Per-tool inbound/outbound overrides. Merged on top of built-in
   * TOOL_INBOUND_SPEC / TOOL_INPUT_RESOLVE / TOOL_INPUT_FIELD_POLICY by
   * `mergeToolOverrides`. See policy/tool-overrides.ts.
   */
  tools?: Record<string, ToolPolicyEntry>;
}

/**
 * Return explicit DIR policy paths whose file contents should be treated as
 * untrusted data sources. Only enumerable paths are returned; allowlist mode
 * with default=UNTRUSTED has an unbounded untrusted set and cannot be seeded.
 */
export function getExplicitUntrustedDirPolicyPaths(policyFile: PolicyFileConfig | null): string[] {
  const dirNew = policyFile?.inbound?.dir;
  if (dirNew) {
    return dirNew.default === "UNTRUSTED" ? [] : (dirNew.untrustedList ?? []);
  }
  return policyFile?.inbound?.["dir-trust"]?.untrustedDirs ?? [];
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Load DualView policy from a YAML file.
 * Returns null if policyPath is not set or file does not exist.
 */
export function loadPolicyFile(
  policyPath: string | undefined,
  basePath: string,
  log: Logger,
): PolicyFileConfig | null {
  if (!policyPath) return null;

  const resolved = resolve(basePath, policyPath);
  if (!existsSync(resolved)) {
    log.warn(`[DualView] policy file not found: ${resolved}`);
    return null;
  }

  try {
    const content = readFileSync(resolved, "utf-8");
    const parsed = yaml.load(content) as PolicyFileConfig;
    log.info(`[DualView] loaded policy file: ${resolved}`);
    return parsed;
  } catch (err) {
    log.warn(`[DualView] failed to load policy file ${resolved}: ${err}`);
    return null;
  }
}
