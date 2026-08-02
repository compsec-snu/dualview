import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { SESSIONS_DIR, BOT_SESSIONS_DIR, type AdfiMeta, type ParsedSessionKey, DUALVIEW_SUBJECT_RE } from "./types.js";

// ── ANSI stripping ──────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[\d+m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Workspace resolution ────────────────────────────────────────────────────

/** Resolve a workspace directory: log-sessions/<batchId>/<wsId>/ */
export function resolveWsDir(batchId: string, wsId: string): string | null {
  const wsDir = path.join(SESSIONS_DIR, batchId, wsId);
  if (fs.existsSync(wsDir)) return wsDir;
  return null;
}

/** Resolve an audit dir, falling back from the current "dualview-audit" name
 *  to the legacy "adfi-audit" name for sessions created before the rename.
 *  Pass the constructed .../dualview-audit path; returns the legacy sibling
 *  only when the preferred dir is absent and the legacy one exists. */
export function resolveAuditDir(dualviewAuditDir: string): string {
  if (fs.existsSync(dualviewAuditDir)) return dualviewAuditDir;
  const legacy = dualviewAuditDir.replace(/dualview-audit$/, "adfi-audit");
  if (legacy !== dualviewAuditDir && fs.existsSync(legacy)) return legacy;
  return dualviewAuditDir;
}

/** Resolve a bot openclaw state directory: try 00/ subdir first, fall back to meta.json.openclawDir (legacy). */
export function resolveBotWsDir(batchId: string, baseDir?: string): string | null {
  const dir = baseDir ?? BOT_SESSIONS_DIR;
  if (!dir) return null;
  const batchDir = path.join(dir, batchId);
  // New layout: batch/{batchId}/00/ is the state dir
  const wsDir = path.join(batchDir, "00");
  if (fs.existsSync(wsDir)) return wsDir;
  // Legacy fallback: meta.json.openclawDir points to external persistent dir
  try {
    const metaPath = path.join(batchDir, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.openclawDir && fs.existsSync(meta.openclawDir)) return meta.openclawDir;
    }
  } catch { /* fall through */ }
  // Persistent bot runner layout: log-sessions/<batch>/ stores meta/logs,
  // while the live OpenClaw state is shared at ../persistent/state.
  // Only use it for a real batch directory so unknown batch IDs stay null.
  if (fs.existsSync(batchDir)) {
    const persistentState = path.resolve(dir, "..", "persistent", "state");
    if (fs.existsSync(persistentState)) return persistentState;
  }
  return null;
}

// ── Session key parsing ──────────────────────────────────────────────────────

/**
 * Parse an OpenClaw session key into structured components.
 *
 * Session key formats:
 *   "agent:main:slack:channel:C0AGJ4YA8J0"  → {platform:"slack", scope:"channel", peerId:"C0AGJ4YA8J0"}
 *   "agent:main:telegram:direct:123456"      → {platform:"telegram", scope:"direct", peerId:"123456"}
 *   "agent:main:hook:a1b2c3d4"               → {platform:"hook", scope:"hook", peerId:"a1b2c3d4"}
 *   "agent:main:main"                        → {platform:"webchat", scope:"main", peerId:""}
 */
export function parseSessionKey(key: string): ParsedSessionKey {
  const parts = key.split(":");
  // "agent:main:slack:channel:C0AGJ4YA8J0" (5+ parts)
  if (parts.length >= 5) {
    return {
      agentId: parts[1]!,
      platform: parts[2]!,
      scope: parts[3]!,
      peerId: parts.slice(4).join(":"),
      raw: key,
    };
  }
  // "agent:main:hook:uuid" (4 parts, platform="hook")
  if (parts.length === 4 && parts[2] === "hook") {
    return { agentId: parts[1]!, platform: "hook", scope: "hook", peerId: parts[3]!, raw: key };
  }
  // "agent:main:main" — webchat / CLI
  return { agentId: parts[1] ?? "main", platform: "webchat", scope: "main", peerId: "", raw: key };
}

/** Generate a human-readable label for a parsed session key. */
export function sessionLabel(parsed: ParsedSessionKey): string {
  if (parsed.platform === "webchat") return "Webchat UI";
  if (parsed.platform === "hook") return `Webhook ${parsed.peerId.slice(0, 8)}`;
  const platform = parsed.platform.charAt(0).toUpperCase() + parsed.platform.slice(1);
  const scopeLabel = parsed.scope === "direct" ? "DM"
    : parsed.scope === "channel" ? "Channel"
    : parsed.scope === "group" ? "Group"
    : parsed.scope;
  return `${platform} ${scopeLabel}: ${parsed.peerId}`;
}


// ── JSONL parser ────────────────────────────────────────────────────────────

export function parseJsonlFile(filepath: string): unknown[] {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, "utf-8");
  const results: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.message?.content && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.thinkingSignature) delete block.thinkingSignature;
        }
      }
      results.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

// ── JSON response helper ────────────────────────────────────────────────────

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

// ── DUALVIEW commit metadata parser ─────────────────────────────────────────────

export function parseAdfiSubject(subject: string): AdfiMeta | null {
  const m = DUALVIEW_SUBJECT_RE.exec(subject);
  if (!m) return null;
  return {
    trusted: m[1] === "DUALVIEW-TRUSTED",
    toolName: m[2]!,
    callId: m[3]!,
    runId: m[4]!,
  };
}
