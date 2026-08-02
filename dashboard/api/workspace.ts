import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWsDir, parseJsonlFile, resolveAuditDir } from "./utils.js";
import { resolveTrustedViewRoot } from "./trusted-view.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Scan an audit directory for files matching a pattern and return all entries. */
function scanAuditFiles(auditDir: string, pattern: RegExp): unknown[] {
  if (!fs.existsSync(auditDir)) return [];
  const files = fs.readdirSync(auditDir).filter((f) => pattern.test(f));
  return files.flatMap((f) => parseJsonlFile(path.join(auditDir, f)));
}

// ── Workspace data ──────────────────────────────────────────────────────────

export function getConversationByAgent(batchId: string, wsId: string, agent: string): unknown[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  const sessDir = path.join(wsDir, "agents", agent, "sessions");
  if (!fs.existsSync(sessDir)) return [];
  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];

  // Read all session files — each inspect_symbol call starts a new ullm session
  const sessions = files.map(f => parseJsonlFile(path.join(sessDir, f)));

  // Sort sessions chronologically by earliest timestamp so the conversation
  // queue aligns with LLM request order (important for index-based matching).
  const firstTs = (entries: unknown[]): string => {
    for (const e of entries as Array<Record<string, unknown>>) {
      const ts = (e.timestamp as string) || (e.message as Record<string, unknown>)?.timestamp as string;
      if (ts) return ts;
    }
    return "";
  };
  sessions.sort((a, b) => firstTs(a).localeCompare(firstTs(b)));

  return sessions.flat();
}

export function getConversation(batchId: string, wsId: string): Record<string, unknown[]> {
  return {
    main: getConversationByAgent(batchId, wsId, "main"),
    ullm: getConversationByAgent(batchId, wsId, "ullm"),
  };
}

export function getAudit(batchId: string, wsId: string): unknown[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  const auditDir = resolveAuditDir(path.join(wsDir, "logs", "dualview-audit"));
  const main = parseJsonlFile(path.join(auditDir, "agent_main_main.jsonl"));
  // Include webhook hook session audit entries (agent_main_hook_*.jsonl)
  const hookEntries = scanAuditFiles(auditDir, /^agent_main_hook_[^.]+\.jsonl$/);
  if (hookEntries.length === 0) return main;
  return [...main, ...hookEntries].sort((a, b) =>
    ((a as Record<string, string>).ts ?? "").localeCompare((b as Record<string, string>).ts ?? ""),
  );
}

export function getNotify(batchId: string, wsId: string): unknown[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  return parseJsonlFile(path.join(wsDir, "dualview-notify.jsonl"));
}

export function getLlmRequests(batchId: string, wsId: string): Record<string, unknown[]> {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return {};
  const auditDir = resolveAuditDir(path.join(wsDir, "logs", "dualview-audit"));
  const mainReqs = parseJsonlFile(path.join(auditDir, "agent_main_main.llm-requests.jsonl"));
  // Webhook hook sessions belong to the main agent — merge into main
  const hookReqs = scanAuditFiles(auditDir, /^agent_main_hook_[^.]+\.llm-requests\.jsonl$/);
  return {
    main: [...mainReqs, ...hookReqs],
    ullm: parseJsonlFile(path.join(auditDir, "agent_ullm_ullm.llm-requests.jsonl")),
  };
}

// ── File view resolution ────────────────────────────────────────────────────

/**
 * Resolve a file view root directory within a workspace.
 * - "root": the workspace dir itself (shows everything including .openclaw config)
 * - "trusted": the Agent File System at dualview/workspaces/<id>/agentview
 * - "untrusted": the Human File System workspace/ subdir
 */
export function resolveViewRoot(wsDir: string, view: string): string | null {
  if (view === "trusted") {
    return resolveTrustedViewRoot(wsDir);
  }
  if (view === "untrusted") {
    const p = path.join(wsDir, "workspace");
    return fs.existsSync(p) ? p : null;
  }
  // "root" — the wsDir itself
  return wsDir;
}

/** Return resolved absolute paths for each file view within a workspace. */
export function getViewRoots(batchId: string, wsId: string): Record<string, string | null> {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return { root: null, trusted: null, untrusted: null };
  return getViewRootsForDir(wsDir);
}

/** Return resolved absolute paths for each file view given a workspace dir. */
export function getViewRootsForDir(wsDir: string): Record<string, string | null> {
  return {
    root: resolveViewRoot(wsDir, "root"),
    trusted: resolveViewRoot(wsDir, "trusted"),
    untrusted: resolveViewRoot(wsDir, "untrusted"),
  };
}

/** List files in a workspace directory (recursive, relative paths). */
export function listWsFiles(batchId: string, wsId: string, view?: string): string[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  return listFilesForDir(wsDir, view);
}

/** List files given a workspace dir (recursive, relative paths). */
export function listFilesForDir(wsDir: string, view?: string): string[] {
  const baseDir = view ? resolveViewRoot(wsDir, view) : wsDir;
  if (!baseDir) return [];
  const results: string[] = [];
  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (view && entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(baseDir, "");
  return results;
}

/** Read a single file from a workspace (archived or live). */
export function readWsFile(batchId: string, wsId: string, filePath: string, view?: string): { content: string; binary: boolean } | null {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return null;
  return readFileForDir(wsDir, filePath, view);
}

/** Read a single file given a workspace dir. */
export function readFileForDir(wsDir: string, filePath: string, view?: string): { content: string; binary: boolean } | null {
  const baseDir = view ? resolveViewRoot(wsDir, view) : wsDir;
  if (!baseDir) return null;

  // Prevent path traversal
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, filePath);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null;

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;

  const buf = fs.readFileSync(resolved);
  const isBinary = buf.includes(0);
  if (isBinary) {
    return { content: `(binary file, ${buf.length} bytes)`, binary: true };
  }
  return { content: buf.toString("utf-8"), binary: false };
}
