/**
 * Eval dashboard API: PinchBench run results with transcripts.
 *
 * Each run is a directory under EVAL_RESULTS_DIR with:
 *   meta.json          - { runId, model, suite, dualview, gitBranch, gitCommit, timestamp }
 *   result.json        - raw PinchBench result JSON
 *   transcripts/       - per-task .jsonl transcript files
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { getAdfiCommitsByCallIdForDir, getGitLogForDir } from "./git.js";
import { EVAL_RESULTS_DIR, TEST_DIR, type EvalRunSummary, type EvalStatus } from "./types.js";
import { resolveAuditDir } from "./utils.js";

function pinchbenchManifestPath(): string {
  return process.env.DUALVIEW_PINCHBENCH_MANIFEST
    || path.join(path.dirname(TEST_DIR), "evaluation", "pinchbench-skill", "tasks", "manifest.yaml");
}

function listTranscriptTaskIds(runId: string): string[] {
  const dir = path.join(EVAL_RESULTS_DIR, runId, "transcripts");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .sort();
}

function readPinchbenchManifestTaskIds(): { all: string[]; core: string[] } {
  const manifestPath = pinchbenchManifestPath();
  if (!fs.existsSync(manifestPath)) return { all: [], core: [] };
  const lines = fs.readFileSync(manifestPath, "utf-8").split("\n");
  const runFirst: string[] = [];
  const core: string[] = [];
  const categoryTasks: string[] = [];
  let section: "run_first" | "core" | "categories" | null = null;
  for (const line of lines) {
    const top = line.match(/^([a-z_]+):\s*$/);
    if (top) {
      const key = top[1]!;
      section = key === "run_first" || key === "core" || key === "categories" ? key : null;
      continue;
    }
    const item = line.match(/^\s*-\s+(task_[A-Za-z0-9_]+)/);
    if (!item) continue;
    const taskId = item[1]!;
    if (section === "run_first") runFirst.push(taskId);
    else if (section === "core") core.push(taskId);
    else if (section === "categories") categoryTasks.push(taskId);
  }
  const all = [...runFirst, ...categoryTasks.filter((id) => !runFirst.includes(id))];
  return { all, core };
}

function suiteTaskIds(suite: string, core = false): string[] {
  const manifest = readPinchbenchManifestTaskIds();
  if (core) return manifest.core;
  if (suite === "all") return manifest.all;
  return suite.split(",").map((s) => s.trim()).filter(Boolean);
}

function synthesizeInProgressEvalResult(runId: string): unknown | null {
  const meta = getEvalMeta(runId) as Record<string, unknown> | null;
  if (!meta) return null;
  const transcriptTaskIds = listTranscriptTaskIds(runId);
  const running = getEvalStatus();
  const currentTask = running.runId === runId ? running.currentTask : undefined;
  const totalTaskIds = suiteTaskIds(String(meta.suite ?? "all"));
  const transcriptTaskIdSet = new Set(transcriptTaskIds);
  const orderedTranscriptTaskIds = totalTaskIds.length > 0
    ? [
        ...totalTaskIds.filter((taskId) => transcriptTaskIdSet.has(taskId)),
        ...transcriptTaskIds.filter((taskId) => !totalTaskIds.includes(taskId)),
      ]
    : transcriptTaskIds;
  const taskIds = [...orderedTranscriptTaskIds];
  if (currentTask && !taskIds.includes(currentTask)) taskIds.push(currentTask);
  const totalTasks = totalTaskIds.length || Math.max(taskIds.length, running.totalTasks ?? 0);
  return {
    model: meta.model ?? "unknown",
    benchmark_version: "in-progress",
    run_id: runId,
    suite: meta.suite ?? "all",
    in_progress: true,
    completed_tasks: transcriptTaskIds.length,
    total_tasks: totalTasks,
    current_task: currentTask,
    tasks: taskIds.map((taskId) => ({
      task_id: taskId,
      status: taskId === currentTask ? "running" : "transcript",
      timed_out: false,
      grading: { runs: [], mean: null },
      frontmatter: { id: taskId, name: taskId.replace(/^task_/, "").replace(/_/g, " ") },
    })),
    efficiency: {},
  };
}

export function parseEvalRuns(): EvalRunSummary[] {
  if (!fs.existsSync(EVAL_RESULTS_DIR)) return [];
  // Don't sort by directory name — the dirname encodes the *original* runId
  // timestamp, so resumed runs would stay pinned to their initial position.
  // Sort by meta.timestamp below (which run-pinchbench.ts bumps to "now" on
  // every invocation, including resume).
  const dirs = fs.readdirSync(EVAL_RESULTS_DIR)
    .filter((d) => {
      const metaPath = path.join(EVAL_RESULTS_DIR, d, "meta.json");
      return fs.existsSync(metaPath);
    });

  const runs: EvalRunSummary[] = [];
  for (const d of dirs) {
    const runDir = path.join(EVAL_RESULTS_DIR, d);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));

      let scorePct: number | null = null;
      let score: number | null = null;
      let maxScore: number | null = null;
      let taskCount = 0;

      const resultPath = path.join(runDir, "result.json");
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        const tasks = result.tasks || [];
        taskCount = tasks.length;
        if (taskCount > 0) {
          score = tasks.reduce((s: number, t: { grading?: { mean?: number } }) => s + (t.grading?.mean ?? 0), 0);
          maxScore = taskCount;
          scorePct = (score! / maxScore) * 100;
        }
      } else {
        taskCount = listTranscriptTaskIds(d).length;
      }

      // Backward-compat: old runs predate the `defense` field. Infer from `dualview` boolean.
      const defense: string = typeof meta.defense === "string"
        ? meta.defense
        : (meta.dualview === true ? "dualview" : "none");
      runs.push({
        runId: d,
        model: meta.model || "unknown",
        suite: meta.suite || "all",
        date: meta.timestamp || new Date().toISOString(),
        defense,
        defenseDisplayName: typeof meta.defenseDisplayName === "string" ? meta.defenseDisplayName : undefined,
        dualview: defense === "dualview",
        fileUntrusted: meta.fileUntrusted === true,
        gitBranch: meta.gitBranch,
        gitCommit: meta.gitCommit,
        scorePct,
        score,
        maxScore,
        taskCount,
      });
    } catch { /* skip malformed */ }
  }
  runs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return runs;
}

export function getEvalResult(runId: string): unknown | null {
  const p = path.join(EVAL_RESULTS_DIR, runId, "result.json");
  if (!fs.existsSync(p)) return synthesizeInProgressEvalResult(runId);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function getEvalMeta(runId: string): unknown | null {
  const p = path.join(EVAL_RESULTS_DIR, runId, "meta.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function listEvalTranscripts(runId: string): string[] {
  return listTranscriptTaskIds(runId);
}

export function getEvalTranscript(runId: string, taskId: string): unknown[] {
  const p = path.join(EVAL_RESULTS_DIR, runId, "transcripts", `${taskId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const lines: unknown[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { lines.push({ raw: line }); }
  }
  return lines;
}

export function getEvalConversation(runId: string, taskId: string): Record<string, unknown[]> {
  const entries = getEvalTranscript(runId, taskId).map((entry) => {
    const e = entry as Record<string, unknown>;
    const msg = e.message as Record<string, unknown> | undefined;
    // Strip `details` from toolResult entries to match e2e format
    // (prevents duplicate "Details" block in conversation renderer)
    if (msg?.role === "toolResult" && "details" in msg) {
      const { details: _, ...rest } = msg;
      return { ...e, message: rest };
    }
    return entry;
  });
  return { main: entries };
}

export function getEvalNotify(runId: string): unknown[] {
  const p = path.join(EVAL_RESULTS_DIR, runId, "dualview-notify.jsonl");
  if (!fs.existsSync(p)) return [];
  const lines: unknown[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return lines;
}

export function getEvalLlmRequestsByAgent(runId: string): Record<string, unknown[]> {
  const dir = resolveAuditDir(path.join(EVAL_RESULTS_DIR, runId, "dualview-audit"));
  if (!fs.existsSync(dir)) return {};
  const result: Record<string, unknown[]> = { main: [], ullm: [] };
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".llm-requests.jsonl")) continue;
    const lines: unknown[] = [];
    for (const line of fs.readFileSync(path.join(dir, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    }
    if (file.includes("ullm")) {
      result.ullm!.push(...lines);
    } else {
      result.main!.push(...lines);
    }
  }
  return result;
}

export function getEvalAuditLog(runId: string, taskId?: string): unknown[] {
  const dir = resolveAuditDir(path.join(EVAL_RESULTS_DIR, runId, "dualview-audit"));
  if (!fs.existsSync(dir)) return [];
  // Find the main audit JSONL (not llm-requests)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.includes("llm-requests"));
  if (files.length === 0) return [];
  const selectedLines: string[] = [];
  let legacyFallbackLines: string[] | null = taskId ? [] : null;
  let sawTaskIdTag = false;
  const taskNeedle = taskId ? `"taskId":"${taskId}"` : "";
  const hasTaskIdNeedle = `"taskId":`;
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      if (!taskId) {
        selectedLines.push(line);
        continue;
      }
      if (line.includes(hasTaskIdNeedle)) {
        sawTaskIdTag = true;
        legacyFallbackLines = null;
        if (line.includes(taskNeedle)) selectedLines.push(line);
      } else if (!sawTaskIdTag) {
        legacyFallbackLines?.push(line);
      }
    }
  }

  const linesToParse = taskId && !sawTaskIdTag ? (legacyFallbackLines ?? []) : selectedLines;
  const lines: unknown[] = [];
  for (const line of linesToParse) {
    try { lines.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return lines;
}

export function getEvalLlmRequests(runId: string): unknown[] {
  const dir = resolveAuditDir(path.join(EVAL_RESULTS_DIR, runId, "dualview-audit"));
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".llm-requests.jsonl"));
  if (files.length === 0) return [];
  const lines: unknown[] = [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return lines;
}

type EvalGitCommit = {
  hash: string;
  date: string;
  subject: string;
};

function findEvalDualViewWorkspaceDir(runId: string): string | null {
  const workspacesDir = path.join(EVAL_RESULTS_DIR, runId, "dualview", "workspaces");
  if (!fs.existsSync(workspacesDir)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspacesDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "repo.git")))
    .sort();

  return candidates[0] ?? null;
}

export function getEvalTrackingDir(runId: string): string {
  return findEvalDualViewWorkspaceDir(runId) ?? path.join(EVAL_RESULTS_DIR, runId, "dualview", "workspaces", "__missing__");
}

function hasEvalGitTracking(runId: string): boolean {
  return getEvalGitArgs(runId) !== null;
}

function findEvalWorkspaceSnapshotDir(runId: string): string | null {
  const runDir = path.join(EVAL_RESULTS_DIR, runId);
  const direct = path.join(runDir, "workspace");
  if (fs.existsSync(direct)) return direct;

  const pinchbenchDir = path.join(runDir, "pinchbench-workspace");
  const directPinchbench = path.join(pinchbenchDir, "agent_workspace");
  if (fs.existsSync(directPinchbench)) return directPinchbench;
  if (!fs.existsSync(pinchbenchDir)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pinchbenchDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(pinchbenchDir, entry.name, "agent_workspace");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findEvalTrustedFileRoot(runId: string): string | null {
  const trackingDir = getEvalTrackingDir(runId);
  const agentview = path.join(trackingDir, "agentview");
  if (fs.existsSync(agentview)) return agentview;
  return null;
}

function getEvalGitArgs(runId: string): string[] | null {
  const trackingDir = getEvalTrackingDir(runId);
  const repoGit = path.join(trackingDir, "repo.git");
  if (fs.existsSync(path.join(repoGit, "HEAD"))) {
    return ["--git-dir", path.resolve(repoGit), "--work-tree", path.resolve(trackingDir)];
  }
  if (fs.existsSync(path.join(trackingDir, ".git"))) {
    return ["-C", path.resolve(trackingDir)];
  }
  return null;
}

function evalGitText(runId: string, args: string[]): string | null {
  const gitArgs = getEvalGitArgs(runId);
  if (!gitArgs) return null;
  try {
    return childProcess.execFileSync("git", [...gitArgs, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function evalGitBuffer(runId: string, args: string[]): Buffer | null {
  const gitArgs = getEvalGitArgs(runId);
  if (!gitArgs) return null;
  try {
    return childProcess.execFileSync("git", [...gitArgs, ...args], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function evalGitRef(runId: string, view?: string): string {
  if (view === "trusted" && evalGitText(runId, ["rev-parse", "--verify", "dualview-trusted^{commit}"])) {
    return "dualview-trusted";
  }
  if (evalGitText(runId, ["rev-parse", "--verify", "master^{commit}"])) return "master";
  return "HEAD";
}

function parseEvalGitCommits(runId: string, ref: string): EvalGitCommit[] {
  const out = evalGitText(runId, ["log", ref, "--format=%H%x00%aI%x00%s"]);
  if (!out) return [];
  const commits: EvalGitCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [hash, date, subject] = line.split("\0");
    if (hash && date && subject != null) commits.push({ hash, date, subject });
  }
  return commits;
}

function getEvalTaskTimeWindow(runId: string, taskId: string): { startMs: number | null; endMs: number | null } {
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const entry of getEvalTranscript(runId, taskId)) {
    const ts = (entry as Record<string, unknown>).timestamp;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    if (startMs == null || ms < startMs) startMs = ms;
    if (endMs == null || ms > endMs) endMs = ms;
  }
  return { startMs, endMs };
}

function getEvalTaskToolCallIds(runId: string, taskId: string): Set<string> {
  const callIds = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) callIds.add(value);
  };

  for (const entry of getEvalTranscript(runId, taskId)) {
    const msg = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg) continue;
    add(msg.toolCallId);
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "toolCall" || b.type === "tool_use") add(b.id);
      }
    }
  }

  for (const entry of getEvalAuditLog(runId, taskId)) {
    add((entry as Record<string, unknown>).toolCallId);
  }

  return callIds;
}

function getEvalTaskSnapshotCommit(runId: string, taskId: string, view?: string): string | null {
  const normalizedView = view === "trusted" ? "trusted" : "untrusted";
  const ref = evalGitRef(runId, normalizedView);
  const commits = parseEvalGitCommits(runId, ref);
  if (commits.length === 0) return null;

  const callIds = getEvalTaskToolCallIds(runId, taskId);
  if (callIds.size > 0) {
    const tag = normalizedView === "trusted" ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
    const matchesCall = (c: EvalGitCommit): boolean => [...callIds].some((id) => c.subject.includes(id));
    const tagged = commits.find((c) => matchesCall(c) && c.subject.includes(tag));
    if (tagged) return tagged.hash;
    const any = commits.find(matchesCall);
    if (any) return any.hash;
  }

  const { startMs, endMs } = getEvalTaskTimeWindow(runId, taskId);
  if (endMs == null) return null;
  const lowerBound = startMs == null ? Number.NEGATIVE_INFINITY : startMs - 5000;
  const upperBound = endMs + 5000;
  const timed = commits.find((c) => {
    const ms = Date.parse(c.date);
    return Number.isFinite(ms) && ms >= lowerBound && ms <= upperBound;
  });
  return timed?.hash ?? null;
}

function isSafeEvalGitPath(filePath: string): boolean {
  if (!filePath || path.isAbsolute(filePath)) return false;
  return !filePath.split(/[\\/]+/).some((part) => part === ".." || part === "");
}

function isTrustedGitSubdir(subdir: string): boolean {
  const normalized = subdir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "agentview" || normalized.endsWith("/agentview");
}

function listEvalGitFilesAtCommit(runId: string, commit: string): string[] {
  if (!/^[0-9a-f]+$/i.test(commit)) return [];
  const out = evalGitText(runId, ["ls-tree", "-r", "--name-only", commit]);
  if (!out) return [];
  return out.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.split("/").some((part) => part.startsWith(".")));
}

function readEvalGitFileAtCommit(runId: string, commit: string, filePath: string): { content: string; binary: boolean } | null {
  if (!/^[0-9a-f]+$/i.test(commit) || !isSafeEvalGitPath(filePath)) return null;
  const buf = evalGitBuffer(runId, ["show", `${commit}:${filePath}`]);
  if (!buf) return null;
  const binary = buf.indexOf(0) !== -1;
  if (binary) return { content: `(binary file, ${buf.length} bytes)`, binary: true };
  return { content: buf.toString("utf-8"), binary: false };
}

export function getEvalWsViewRoots(runId: string, taskId?: string): Record<string, string> {
  if (taskId) {
    const roots: Record<string, string> = {};
    const trackingDir = getEvalTrackingDir(runId);
    const hasTracking = hasEvalGitTracking(runId);
    const untrustedCommit = getEvalTaskSnapshotCommit(runId, taskId, "untrusted");
    const trustedCommit = getEvalTaskSnapshotCommit(runId, taskId, "trusted");
    if (untrustedCommit) {
      roots.root = `${trackingDir}@${untrustedCommit.slice(0, 7)}`;
      roots.untrusted = roots.root;
    }
    if (trustedCommit) roots.trusted = `${trackingDir}@${trustedCommit.slice(0, 7)} (dualview-trusted)`;
    if (!hasTracking && (!roots.root || !roots.untrusted || !roots.trusted)) {
      const fallback = getEvalWsViewRoots(runId);
      if (!roots.root && fallback.root) roots.root = fallback.root;
      if (!roots.untrusted && fallback.untrusted) roots.untrusted = fallback.untrusted;
      if (!roots.trusted && fallback.trusted) roots.trusted = fallback.trusted;
    }
    return roots;
  }

  const wsDir = findEvalWorkspaceSnapshotDir(runId);
  const roots: Record<string, string> = {};
  if (wsDir) roots.root = wsDir;

  const trustedRoot = findEvalTrustedFileRoot(runId);
  if (trustedRoot) roots.trusted = trustedRoot;
  // Untrusted = root workspace (the main workspace is untrusted in DUALVIEW context)
  if (roots.root) roots.untrusted = roots.root;
  return roots;
}

export function listEvalWsFiles(runId: string, view?: string, taskId?: string): string[] {
  if (taskId) {
    const commit = getEvalTaskSnapshotCommit(runId, taskId, view);
    if (commit) return listEvalGitFilesAtCommit(runId, commit);
    return hasEvalGitTracking(runId) ? [] : listEvalWsFiles(runId, view);
  }

  const roots = getEvalWsViewRoots(runId);
  const wsDir = roots[view || "root"];
  if (!wsDir || !fs.existsSync(wsDir)) return [];
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(wsDir, "");
  return files;
}

export function readEvalWsFile(runId: string, filePath: string, view?: string, taskId?: string): { content: string; binary: boolean } | null {
  if (taskId) {
    const commit = getEvalTaskSnapshotCommit(runId, taskId, view);
    if (commit) return readEvalGitFileAtCommit(runId, commit, filePath);
    return hasEvalGitTracking(runId) ? null : readEvalWsFile(runId, filePath, view);
  }

  const roots = getEvalWsViewRoots(runId);
  const wsDir = roots[view || "root"];
  if (!wsDir) return null;
  const resolved = path.resolve(wsDir, filePath);
  if (!resolved.startsWith(wsDir)) return null;
  if (!fs.existsSync(resolved)) return null;
  try {
    const content = fs.readFileSync(resolved, "utf-8");
    return { content, binary: false };
  } catch {
    return { content: "(binary file)", binary: true };
  }
}

export function getEvalWsGitLog(runId: string, subdir: string, taskId?: string): unknown[] {
  const trackingDir = getEvalTrackingDir(runId);
  if (!fs.existsSync(trackingDir)) return [];
  const commits = getGitLogForDir(trackingDir, subdir) as Array<{ subject?: string; date?: string }>;
  if (!taskId) return commits;

  const callIds = getEvalTaskToolCallIds(runId, taskId);
  if (callIds.size > 0) {
    const callMatches = commits.filter((c) => [...callIds].some((id) => (c.subject || "").includes(id)));
    const tag = isTrustedGitSubdir(subdir) ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
    const tagged = callMatches.filter((c) => (c.subject || "").includes(tag));
    return tagged.length > 0 ? tagged : callMatches;
  }

  const { startMs, endMs } = getEvalTaskTimeWindow(runId, taskId);
  if (endMs == null) return [];
  const lowerBound = startMs == null ? Number.NEGATIVE_INFINITY : startMs - 5000;
  const upperBound = endMs + 5000;
  const timed = commits.filter((c) => {
    const ms = Date.parse(c.date || "");
    return Number.isFinite(ms) && ms >= lowerBound && ms <= upperBound;
  });
  const tag = isTrustedGitSubdir(subdir) ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
  const tagged = timed.filter((c) => (c.subject || "").includes(tag));
  return tagged.length > 0 ? tagged : timed;
}

export function getEvalWsAdfiCommits(runId: string, taskId?: string): Record<string, unknown> {
  const trackingDir = getEvalTrackingDir(runId);
  if (!fs.existsSync(trackingDir)) return {};
  const grouped = getAdfiCommitsByCallIdForDir(trackingDir, ".") as Record<string, unknown>;
  if (!taskId) return grouped;

  const callIds = getEvalTaskToolCallIds(runId, taskId);
  if (callIds.size === 0) return {};
  return Object.fromEntries(Object.entries(grouped).filter(([callId]) => callIds.has(callId)));
}

export function getEvalTaskSpec(runId: string, taskId: string): string | null {
  // EVAL_RESULTS_DIR = test/eval/results, repo root = ../../..
  const repoRoot = path.resolve(EVAL_RESULTS_DIR, "..", "..", "..");
  const candidates = [
    path.join(repoRoot, "evaluation", "pinchbench-skill", "tasks", `${taskId}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return null;
}

export function getEvalGatewayLog(runId: string): string {
  const p = path.join(EVAL_RESULTS_DIR, runId, "gateway.log");
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf-8");
}

function withEvalTaskEta(status: EvalStatus, nowSec = Date.now() / 1000): EvalStatus {
  if (!status.running || !Number.isFinite(status.startedAt)) return status;

  const completedTasks = Number.isFinite(status.completedTasks) ? status.completedTasks! : 0;
  const totalTasks = Number.isFinite(status.totalTasks)
    ? status.totalTasks!
    : (Number.isFinite(status.resume?.taskCount) ? status.resume!.taskCount : undefined);
  const elapsedSec = Math.max(0, Math.round(nowSec - status.startedAt!));
  const remainingTasks = Number.isFinite(totalTasks)
    ? Math.max(0, totalTasks! - completedTasks)
    : undefined;
  if (completedTasks <= 0 || remainingTasks == null) {
    return { ...status, elapsedSec, remainingTasks };
  }

  const averageTaskSec = elapsedSec / completedTasks;
  const estimatedRemainingSec = Math.round(averageTaskSec * remainingTasks);
  return {
    ...status,
    elapsedSec,
    remainingTasks,
    averageTaskSec,
    estimatedRemainingSec,
    estimatedTotalSec: elapsedSec + estimatedRemainingSec,
  };
}

export function getEvalStatus(): EvalStatus {
  const p = path.join(EVAL_RESULTS_DIR, "running.json");
  if (!fs.existsSync(p)) return { running: false };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const runId = typeof data.runId === "string" ? data.runId : undefined;
    const meta = runId ? getEvalMeta(runId) as Record<string, unknown> | null : null;
    const totalTaskIds = suiteTaskIds(String(meta?.suite ?? ""), false);
    const transcriptCount = runId ? listTranscriptTaskIds(runId).length : 0;
    const reportedTotal = Number.isFinite(data.totalTasks) ? data.totalTasks : 0;
    const totalTasks = reportedTotal > 1 ? reportedTotal : (totalTaskIds.length > 0 ? totalTaskIds.length : data.totalTasks);
    const completedTasks = Math.max(Number.isFinite(data.completedTasks) ? data.completedTasks : 0, transcriptCount);
    return withEvalTaskEta({ running: true, ...data, totalTasks, completedTasks });
  } catch {
    return { running: false };
  }
}
