/**
 * PolicyEngine — holds the registry of TrustCategory instances.
 *
 * The engine itself does no classification; it's a typed lookup table
 * plus a constructor that merges YAML policy + plugin config shortcuts
 * into concrete TrustCategory instances.
 *
 * Per-field trust decisions are made by policy/resolve-schema.ts, which
 * takes a PolicyEngine (via the `CategoryLookup` interface) and walks
 * tool inbound schemas.
 */

import { loadPolicyFile, type PolicyFileConfig } from "./load-policy.js";
import {
  createUrlTrustCategory,
  createChannelTrustCategory,
  createDirTrustCategory,
  type TrustCategory,
  type ListMode,
} from "./trust-category.js";
import type { CategoryLookup } from "./resolve-schema.js";
import { mergeCommandOverrides } from "./exec-inbound.js";
import { mergeToolOverrides } from "./tool-overrides.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class PolicyEngine implements CategoryLookup {
  private categories = new Map<string, TrustCategory>();

  register(category: TrustCategory): void {
    this.categories.set(category.id, category);
  }

  get(id: string): TrustCategory | undefined {
    return this.categories.get(id);
  }

  has(id: string): boolean {
    return this.categories.has(id);
  }

  /** Iterate registered categories — for logging / diagnostics. */
  list(): TrustCategory[] {
    return Array.from(this.categories.values());
  }
}

/**
 * Build a PolicyEngine from a YAML policy file. All policy input flows
 * through the YAML; there are no plugin-config shortcuts.
 *
 * YAML shape (new):
 *   inbound:
 *     url:     { default: UNTRUSTED, trustedList: [...] }
 *     channel: { default: TRUSTED,   untrustedList: [...] }
 *     dir:     { default: TRUSTED,   untrustedList: [...] }
 *
 * Legacy YAML keys (deprecated but still accepted):
 *   inbound.url-trust     { trustedUrls: [...] }     → url allowlist
 *   inbound.channel-trust { untrustedChannels: [...] } → channel blocklist
 *   inbound.dir-trust     { untrustedDirs: [...] }   → dir blocklist
 */
export function createPolicyEngine(
  policyPath: string | undefined,
  basePath: string,
  log: Logger,
  policyFileOverride?: PolicyFileConfig | null,
): PolicyEngine {
  const engine = new PolicyEngine();
  const policyFile = policyFileOverride === undefined
    ? loadPolicyFile(policyPath, basePath, log)
    : policyFileOverride;

  // Register built-in categories with their intrinsic "no policy"
  // defaults so every DataSpec in TOOL_INBOUND_SPEC resolves to the
  // pre-refactor baseline when the user provides no config. User YAML
  // / plugin config below overrides these.
  //
  //   URL     — external network, conservative: empty allowlist
  //             (everything not explicitly trusted is UNTRUSTED)
  //   CHANNEL — local messaging, permissive: empty blocklist
  //             (everything not explicitly untrusted is TRUSTED)
  //   DIR     — local filesystem, permissive: empty blocklist
  engine.register(createUrlTrustCategory({ mode: "allowlist", list: [] }));
  engine.register(createChannelTrustCategory({ mode: "blocklist", list: [] }));
  engine.register(createDirTrustCategory({ mode: "blocklist", list: [], basePath }));

  // ── URL ─────────────────────────────────────────────────────────────
  const urlNew = policyFile?.inbound?.url;
  const urlLegacy = policyFile?.inbound?.["url-trust"];
  if (urlNew) {
    const mode: ListMode = (urlNew.default === "UNTRUSTED") ? "allowlist" : "blocklist";
    const list = mode === "allowlist" ? (urlNew.trustedList ?? []) : (urlNew.untrustedList ?? []);
    engine.register(createUrlTrustCategory({ mode, list }));
    log.info(`[DualView] policy: URL category registered (${mode}, ${list.length} entries)`);
  } else if (urlLegacy?.trustedUrls?.length) {
    engine.register(createUrlTrustCategory({ mode: "allowlist", list: urlLegacy.trustedUrls }));
    log.warn(`[DualView] policy: inbound.url-trust is deprecated, use inbound.url.{default,trustedList}`);
    log.info(`[DualView] policy: URL category registered (allowlist, ${urlLegacy.trustedUrls.length} entries)`);
  }

  // ── CHANNEL ─────────────────────────────────────────────────────────
  const chNew = policyFile?.inbound?.channel;
  const chLegacy = policyFile?.inbound?.["channel-trust"];
  if (chNew) {
    const mode: ListMode = (chNew.default === "UNTRUSTED") ? "allowlist" : "blocklist";
    const list = mode === "allowlist" ? (chNew.trustedList ?? []) : (chNew.untrustedList ?? []);
    engine.register(createChannelTrustCategory({ mode, list }));
    log.info(`[DualView] policy: CHANNEL category registered (${mode}, ${list.length} entries)`);
  } else if (chLegacy?.untrustedChannels?.length) {
    engine.register(createChannelTrustCategory({ mode: "blocklist", list: chLegacy.untrustedChannels }));
    log.warn(`[DualView] policy: inbound.channel-trust is deprecated, use inbound.channel.{default,untrustedList}`);
    log.info(`[DualView] policy: CHANNEL category registered (blocklist, ${chLegacy.untrustedChannels.length} entries)`);
  }

  // ── DIR ─────────────────────────────────────────────────────────────
  const dirNew = policyFile?.inbound?.dir;
  if (dirNew) {
    const mode: ListMode = (dirNew.default === "UNTRUSTED") ? "allowlist" : "blocklist";
    const list = mode === "allowlist" ? (dirNew.trustedList ?? []) : (dirNew.untrustedList ?? []);
    engine.register(createDirTrustCategory({ mode, list, basePath }));
    log.info(`[DualView] policy: DIR category registered (${mode}, ${list.length} entries)`);
  } else {
    const dirLegacy = policyFile?.inbound?.["dir-trust"]?.untrustedDirs ?? [];
    if (dirLegacy.length > 0) {
      log.warn(`[DualView] policy: inbound.dir-trust is deprecated, use inbound.dir.{default,untrustedList}`);
      engine.register(createDirTrustCategory({
        mode: "blocklist",
        list: dirLegacy,
        basePath,
      }));
      log.info(`[DualView] policy: DIR category registered (blocklist, ${dirLegacy.length} entries)`);
    }
  }

  // ── COMMAND ─────────────────────────────────────────────────────────
  const cmdOverrides = policyFile?.inbound?.command;
  if (cmdOverrides && cmdOverrides.length > 0) {
    mergeCommandOverrides(cmdOverrides, log);
    log.info(`[DualView] policy: COMMAND overrides applied (${cmdOverrides.length} entries)`);
  }

  // ── TOOLS (per-tool inbound/outbound) ──────────────────────────────
  const toolOverrides = policyFile?.tools;
  if (toolOverrides && Object.keys(toolOverrides).length > 0) {
    mergeToolOverrides(toolOverrides, log);
    log.info(`[DualView] policy: TOOL overrides applied (${Object.keys(toolOverrides).length} tools)`);
  }

  return engine;
}
