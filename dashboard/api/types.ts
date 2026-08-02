import * as path from "node:path";

// ── Paths ───────────────────────────────────────────────────────────────────

export const DASHBOARD_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));
export const REPO_ROOT = path.dirname(DASHBOARD_DIR);
export const TEST_DIR = path.join(REPO_ROOT, "test");
export let SESSIONS_DIR = process.env.DUALVIEW_WORKSPACE_DIR || path.join(TEST_DIR, "log-sessions");

export function setSessionsDir(dir: string): void {
  SESSIONS_DIR = dir;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  date: string;
  mode: string;
  result: "PASS" | "FAIL" | "RUNNING" | "INTERRUPTED";
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  total: number;
  elapsedSec?: number;
  tests: TestRef[];
  workspaceIds: string[];
  /** wsId (e.g. "01") → test ID (e.g. "UT-01×symbolize") for running sessions. */
  wsMap?: Record<string, string>;
  docker?: boolean;
  gitBranch?: string;
  ciActor?: string;
  ciJobUrl?: string;
  /** Symbol format preset ID (e.g. "C1_S2_W1") when non-default format is used. */
  symbolFormat?: string;
  /** Defense plugin id for the run (e.g. "dualview", "none", "moltguard"). */
  defense?: string;
  /** OpenShell policy preset (e.g. "default", "network-extend") when defense === "openshell". */
  openshellPolicy?: string;
  /** Security mode: number of attacks that succeeded. */
  attackSuccessCount?: number;
  /** Security mode: number of attacks that were blocked. */
  attackBlockedCount?: number;
  /** Security mode: tests where oracle result was inconclusive. */
  attackInconclusive?: number;
  /** Security mode: attack success rate as percentage (0-100). */
  attackSuccessRate?: number;
}

export interface RetryAttemptRef {
  dir: string;           // e.g., "01-a1"
  elapsed: number | null;
  reason: string;
}

export interface TestRef {
  name: string;
  result: "PASS" | "FAIL" | "RUNNING" | "PENDING" | "SKIP" | "ERROR";
  reason: string;
  wsId: string | null;
  elapsed: number | null; // seconds
  attempt?: number;
  maxAttempts?: number;
  retryAttempts?: RetryAttemptRef[];
}

export interface LogEntry {
  elapsed: string;
  category: string;
  message: string;
  data?: string;
}

export interface AdfiMeta {
  trusted: boolean;
  toolName: string;
  callId: string;
  runId: string;
}

// ── Eval dashboard ───────────────────────────────────────────────────────────

export let EVAL_RESULTS_DIR = process.env.DUALVIEW_EVAL_DIR || path.join(TEST_DIR, "eval", "results");

export function setEvalResultsDir(dir: string): void {
  EVAL_RESULTS_DIR = dir;
}

export interface EvalRunSummary {
  runId: string;
  model: string;
  suite: string;
  date: string;
  /** Defense plugin id used for the run. e.g. "dualview", "none", "moltguard", "openshell". */
  defense: string;
  /** Human-readable display name (from defense.yaml). */
  defenseDisplayName?: string;
  /** @deprecated Use `defense === "dualview"`. Kept for backward compatibility with old runs. */
  dualview: boolean;
  /** DUALVIEW run with the entire PinchBench workspace marked as an untrusted dir (#162). */
  fileUntrusted?: boolean;
  gitBranch?: string;
  gitCommit?: string;
  scorePct: number | null;
  score: number | null;
  maxScore: number | null;
  taskCount: number;
}

export interface EvalStatus {
  running: boolean;
  runId?: string;
  phase?: string;
  model?: string;
  startedAt?: number;
  totalTasks?: number;
  completedTasks?: number;
  currentTask?: string;
  updatedAt?: number;
  elapsedSec?: number;
  remainingTasks?: number;
  averageTaskSec?: number;
  estimatedRemainingSec?: number;
  estimatedTotalSec?: number;
  resume?: { from: string; taskCount: number };
}

// ── Bot dashboard ────────────────────────────────────────────────────────────

/** Mutable so server.ts can override via --bot-dir flag before first API call. */
export let BOT_SESSIONS_DIR = process.env.DUALVIEW_BOT_DIR || "";

export function setBotSessionsDir(dir: string): void {
  BOT_SESSIONS_DIR = dir;
}

export interface ParsedSessionKey {
  agentId: string;
  platform: string;     // "slack" | "telegram" | "discord" | "webchat" | "hook"
  scope: string;        // "direct" | "channel" | "group" | "main" | "hook"
  peerId: string;       // channel/user/group ID, or "" for webchat
  raw: string;          // original session key
}

export interface BotSessionEntry {
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  updatedAt?: number;
  model?: string;
  label?: string;
  origin?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Count of non-empty lines in the main-agent session transcript (.jsonl). */
  messageCount?: number;
  /** Parsed channel info from session key */
  platform?: string;
  scope?: string;
  peerId?: string;
  channelLabel?: string;
}

export interface BotBatchSummary {
  batchId: string;
  date: string;
  status: "RUNNING" | "STOPPED";
  gitBranch?: string;
  gitCommit?: string;
  sessions: BotSessionEntry[];
  gatewayPort?: string;
  gatewayToken?: string;
}

// ── Regexes ─────────────────────────────────────────────────────────────────

export const BATCH_ID_RE = /^\d{8}_\d{6}(_\w+)?$/;
export const RETRY_DIR_RE = /^(\d{2})-a(\d+)$/;
export const ENTRY_RE = /^\[\s*([\d.]+s)\]\s+\[([^\]]+)\]\s+(.*)$/;
export const WS_ID_RE = /\blog-sessions\/(?:\d{8}_\d{6}(?:_\w+)?\/)?(\d{2})\//g;
export const TEST_END_RE = /=== END: (\S+) (PASS|FAIL)(?: \([^)]*\))? -- (.*?) ===$/;
export const TEST_SKIP_RE = /=== END \(skip\): (\S+) SKIP ===$/;
export const DUALVIEW_SUBJECT_RE = /^\[(DUALVIEW-TRUSTED|DUALVIEW-UNTRUSTED)\]\s+dualview:\s+tool=(\S+)\s+callId=(\S+)\s+run=(\S+)/;
