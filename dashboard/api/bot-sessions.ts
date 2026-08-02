import * as fs from "node:fs";
import * as path from "node:path";
import {
  BOT_SESSIONS_DIR, BATCH_ID_RE,
  type BotBatchSummary, type BotSessionEntry,
} from "./types.js";
import { parseJsonlFile, resolveBotWsDir, parseSessionKey, sessionLabel, resolveAuditDir } from "./utils.js";

// ── Bot session list ─────────────────────────────────────────────────────────

/** Parse bot batch directories. Accepts optional baseDir override for testing. */
export function parseBotSessionList(baseDir?: string): BotBatchSummary[] {
  const dir = baseDir ?? BOT_SESSIONS_DIR;
  if (!dir || !fs.existsSync(dir)) return [];

  const batchDirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && BATCH_ID_RE.test(d.name))
    .map((d) => d.name);

  const batches: BotBatchSummary[] = [];

  for (const batchId of batchDirs) {
    const batchDir = path.join(dir, batchId);
    const metaPath = path.join(batchDir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { continue; }

    // Only include bot batches (skip e2e batches if dirs are shared)
    if (meta.kind !== "bot") continue;

    // Read sessions from the openclaw state dir (00/ first, legacy openclawDir fallback)
    const openclawDir = resolveBotWsDir(batchId, dir) ?? path.join(batchDir, "00");
    const mainSessDir = path.join(openclawDir, "agents", "main", "sessions");
    const sessions: BotSessionEntry[] = [];
    const sessionsJsonPath = path.join(mainSessDir, "sessions.json");

    // Pre-scan JSONL transcripts once per batch so we can attach a message count
    // to each session without re-reading the directory per entry.
    const jsonlFiles = fs.existsSync(mainSessDir)
      ? fs.readdirSync(mainSessDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    const countSessionMessages = (sessionId: string): number | undefined => {
      if (!sessionId) return undefined;
      const f = jsonlFiles.find((name) => name.startsWith(sessionId));
      if (!f) return undefined;
      try {
        return fs.readFileSync(path.join(mainSessDir, f), "utf-8")
          .split("\n").filter((l) => l.trim()).length;
      } catch { return undefined; }
    };
    if (fs.existsSync(sessionsJsonPath)) {
      try {
        const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
        // sessions.json can be:
        //   1. An array of session objects
        //   2. An object with a .sessions array
        //   3. An object keyed by session key (e.g. "agent:main:main") with session values
        let entries: unknown[];
        if (Array.isArray(sessionsData)) {
          entries = sessionsData;
        } else if (Array.isArray(sessionsData.sessions)) {
          entries = sessionsData.sessions;
        } else {
          // Object keyed by session key → extract values
          entries = Object.values(sessionsData);
        }

        // sessions.json is keyed by session key — iterate keys to get both key and value
        const keyedEntries: Array<[string, Record<string, unknown>]> = Array.isArray(sessionsData)
          ? entries.map((e, i) => [String(i), e as Record<string, unknown>])
          : Array.isArray(sessionsData.sessions)
            ? entries.map((e, i) => [String(i), e as Record<string, unknown>])
            : Object.entries(sessionsData);

        for (const [sessionKey, e] of keyedEntries) {
          const parsed = parseSessionKey(sessionKey);
          const sessionId = (e.sessionId as string) ?? "";
          sessions.push({
            sessionKey,
            sessionId,
            sessionFile: (e.sessionFile as string) ?? "",
            updatedAt: e.updatedAt as number | undefined,
            model: e.model as string | undefined,
            label: e.label as string | undefined,
            origin: e.origin as string | undefined,
            inputTokens: e.inputTokens as number | undefined,
            outputTokens: e.outputTokens as number | undefined,
            messageCount: countSessionMessages(sessionId),
            platform: parsed.platform,
            scope: parsed.scope,
            peerId: parsed.peerId,
            channelLabel: sessionLabel(parsed),
          });
        }

        // Sort by updatedAt descending (most recent first)
        sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      } catch { /* skip parse errors */ }
    }

    // Read gateway port from meta.json, token from openclaw.json
    const gwPort = (meta.gatewayPort as string) || undefined;
    let gwToken: string | undefined;
    try {
      const cfgPath = path.join(openclawDir, "openclaw.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        gwToken = cfg?.gateway?.auth?.token as string | undefined;
      }
    } catch { /* skip */ }

    batches.push({
      batchId,
      date: (meta.date as string) ?? "",
      status: meta.status === "RUNNING" ? "RUNNING" : "STOPPED",
      gitBranch: meta.gitBranch as string | undefined,
      gitCommit: meta.gitCommit as string | undefined,
      sessions,
      gatewayPort: gwPort,
      gatewayToken: gwToken,
    });
  }

  // Sort batches newest first
  batches.sort((a, b) => b.batchId.localeCompare(a.batchId));
  return batches;
}

// ── Bot workspace data ───────────────────────────────────────────────────────

/**
 * Read conversation for a specific bot session.
 * Returns { main: [...entries], ullm: [...entries] }
 */
export function getBotConversation(
  batchId: string,
  sessionId: string,
  baseDir?: string,
): Record<string, unknown[]> {
  const wsDir = resolveBotWsDir(batchId, baseDir);
  if (!wsDir) return { main: [], ullm: [] };

  const result: Record<string, unknown[]> = { main: [], ullm: [] };

  for (const agent of ["main", "ullm"]) {
    const sessDir = path.join(wsDir, "agents", agent, "sessions");
    if (!fs.existsSync(sessDir)) continue;

    const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
    if (agent === "ullm") {
      // U-LLM sessions have their own IDs (one per inspect_symbol call);
      // load all of them sorted chronologically, matching e2e behavior.
      const sessions = files.map((f) => parseJsonlFile(path.join(sessDir, f)));
      const firstTs = (entries: unknown[]): string => {
        for (const e of entries as Array<Record<string, unknown>>) {
          const ts = (e.timestamp as string) || (e.message as Record<string, unknown>)?.timestamp as string;
          if (ts) return ts;
        }
        return "";
      };
      sessions.sort((a, b) => firstTs(a).localeCompare(firstTs(b)));
      result.ullm!.push(...sessions.flat());
    } else {
      // Main agent: match by sessionId in filename
      for (const f of files) {
        if (f.startsWith(sessionId)) {
          result[agent]!.push(...parseJsonlFile(path.join(sessDir, f)));
        }
      }
    }
  }

  return result;
}

/** Read audit events for a bot batch. */
export function getBotAudit(batchId: string, baseDir?: string): unknown[] {
  const wsDir = resolveBotWsDir(batchId, baseDir);
  if (!wsDir) return [];

  const auditDir = resolveAuditDir(path.join(wsDir, "logs", "dualview-audit"));
  if (!fs.existsSync(auditDir)) return [];

  // Read all audit JSONL files and merge by timestamp
  const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl") && !f.includes(".llm-requests."));
  const entries = files.flatMap((f) => parseJsonlFile(path.join(auditDir, f)));
  entries.sort((a, b) =>
    ((a as Record<string, string>).ts ?? "").localeCompare((b as Record<string, string>).ts ?? ""),
  );
  return entries;
}

/** Read LLM request logs for a bot batch. */
export function getBotLlmRequests(batchId: string, baseDir?: string): Record<string, unknown[]> {
  const wsDir = resolveBotWsDir(batchId, baseDir);
  if (!wsDir) return {};

  const auditDir = resolveAuditDir(path.join(wsDir, "logs", "dualview-audit"));
  if (!fs.existsSync(auditDir)) return {};

  const mainFiles = fs.readdirSync(auditDir)
    .filter((f) => f.includes("main") && f.endsWith(".llm-requests.jsonl"));
  const ullmFiles = fs.readdirSync(auditDir)
    .filter((f) => f.includes("ullm") && f.endsWith(".llm-requests.jsonl"));

  return {
    main: mainFiles.flatMap((f) => parseJsonlFile(path.join(auditDir, f))),
    ullm: ullmFiles.flatMap((f) => parseJsonlFile(path.join(auditDir, f))),
  };
}
