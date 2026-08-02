import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import type { AdfiMeta } from "./types.js";
import { resolveWsDir, parseAdfiSubject } from "./utils.js";
import { resolveGitDirForSubdir } from "./trusted-view.js";

// ── Git execution helper ────────────────────────────────────────────────────

/**
 * Run a git command with CI-safe configuration.
 * Adds safe.directory=* to avoid "dubious ownership" errors in CI where
 * the dashboard process may run as a different user than the test runner.
 */
function gitExec(args: string[], opts: { cwd: string; timeout?: number; encoding: "utf-8" }): string;
function gitExec(args: string[], opts: { cwd: string; timeout?: number }): Buffer;
function gitExec(args: string[], opts: { cwd: string; timeout?: number; encoding?: "utf-8" }): string | Buffer {
  return childProcess.execFileSync("git", ["-c", "safe.directory=*", ...args], { ...opts, stdio: "pipe" });
}

// ── Worktree resolution ─────────────────────────────────────────────────────

const _resolvedWorktrees = new Set<string>();

/**
 * Resolve extra git CLI args for broken worktree `.git` files.
 *
 * When CI creates a worktree inside a Docker container or a directory that is
 * later moved, the `.git` file (which contains `gitdir: /absolute/path/...`)
 * points to a non-existent location. Rather than rewriting the archived `.git`
 * file on disk (which can fail due to permissions or stale-path collisions on
 * the CI host), this function resolves the correct worktree git dir within the
 * local directory tree and returns `--git-dir` / `--work-tree` args so git
 * commands work without any file modifications.
 *
 * Returns an empty array when no override is needed.
 */
function resolveWorktreeGitArgs(gitDir: string): string[] {
  const dotGitPath = path.join(gitDir, ".git");
  if (!fs.existsSync(dotGitPath)) return [];

  const stat = fs.statSync(dotGitPath);
  if (stat.isDirectory()) return []; // Real .git dir, no worktree link

  const content = fs.readFileSync(dotGitPath, "utf-8").trim();
  const m = content.match(/^gitdir:\s+(.+)$/);
  if (!m) return [];

  const gitdirPath = m[1]!;

  // If the linked path resolves correctly, no override needed
  if (path.isAbsolute(gitdirPath) && fs.existsSync(gitdirPath)) return [];
  if (!path.isAbsolute(gitdirPath) && fs.existsSync(path.resolve(gitDir, gitdirPath))) return [];

  // Broken path — extract worktree name and search for the correct location
  const parts = gitdirPath.split(/[/\\]/);
  const wtIdx = parts.lastIndexOf("worktrees");
  if (wtIdx < 0 || wtIdx >= parts.length - 1) return [];
  const wtName = parts[wtIdx + 1]!;

  let searchDir = gitDir;
  for (let i = 0; i < 10; i++) {
    searchDir = path.dirname(searchDir);
    if (searchDir === path.dirname(searchDir)) break; // reached root
    const candidates = [
      path.join(searchDir, ".git", "worktrees", wtName),
      path.join(searchDir, "repo.git", "worktrees", wtName),
    ];
    const candidate = candidates.find((p) => fs.existsSync(p));
    if (candidate) {
      if (!_resolvedWorktrees.has(dotGitPath)) {
        _resolvedWorktrees.add(dotGitPath);
        console.log(`[dashboard] Resolved broken worktree .git: ${dotGitPath} → --git-dir ${candidate}`);
      }
      return ["--git-dir", path.resolve(candidate), "--work-tree", path.resolve(gitDir)];
    }
  }

  console.warn(`[dashboard] Could not resolve broken worktree .git at ${dotGitPath} (worktree name: ${wtName})`);
  return [];
}

function resolveGitArgsForDir(gitDir: string): string[] | null {
  if (!fs.existsSync(gitDir)) return null;
  if (fs.existsSync(path.join(gitDir, ".git"))) {
    return resolveWorktreeGitArgs(gitDir);
  }

  const repoGit = path.join(gitDir, "repo.git");
  if (fs.existsSync(repoGit)) {
    return ["--git-dir", path.resolve(repoGit), "--work-tree", path.resolve(gitDir)];
  }

  return null;
}

// ── Git log ─────────────────────────────────────────────────────────────────

/** Get git log for a subdirectory (typically "workspace") inside a workspace dir. */
export function getGitLog(batchId: string, wsId: string, subdir: string): unknown[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  return getGitLogForDir(wsDir, subdir);
}

/** Get git log given a workspace dir and subdirectory. */
export function getGitLogForDir(wsDir: string, subdir: string): unknown[] {
  const gitDir = resolveGitDirForSubdir(wsDir, subdir);
  const wtArgs = resolveGitArgsForDir(gitDir);
  if (!wtArgs) return [];

  try {
    gitExec([...wtArgs, "rev-parse", "HEAD"], { cwd: gitDir, timeout: 2000, encoding: "utf-8" });
  } catch {
    return [];
  }

  try {
    const out = gitExec([
      ...wtArgs, "log", "--format=COMMIT:%H%n%s%n%an%n%aI%n%D",
      "--name-only",
    ], { cwd: gitDir, timeout: 5000, encoding: "utf-8" });

    const commits: { hash: string; subject: string; author: string; date: string; refs: string | null; dualview: AdfiMeta | null; files: string[] }[] = [];
    let current: { hash: string; subject: string; author: string; date: string; refs: string | null; dualview: AdfiMeta | null; files: string[] } | null = null;

    for (const line of out.split("\n")) {
      if (line.startsWith("COMMIT:")) {
        if (current) commits.push(current);
        current = { hash: line.slice(7), subject: "", author: "", date: "", refs: null, dualview: null, files: [] };
      } else if (current) {
        if (!current.subject) {
          current.subject = line;
          current.dualview = parseAdfiSubject(line);
        }
        else if (!current.author) current.author = line;
        else if (!current.date) current.date = line;
        else if (current.refs === null) {
          current.refs = line.trim();
        }
        else if (line.trim()) current.files.push(line.trim());
      }
    }
    if (current) commits.push(current);
    return commits;
  } catch (err) {
    console.error(`[dashboard] getGitLog failed for ${gitDir}:`, (err as Error).message);
    return [];
  }
}

/** Get git log for a specific file inside a workspace subdirectory. */
export function getFileGitLog(batchId: string, wsId: string, subdir: string, filePath: string): unknown[] {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];
  return getFileGitLogForDir(wsDir, subdir, filePath);
}

/** Get git log for a specific file given a workspace dir. */
export function getFileGitLogForDir(wsDir: string, subdir: string, filePath: string): unknown[] {
  const gitDir = resolveGitDirForSubdir(wsDir, subdir);
  const wtArgs = resolveGitArgsForDir(gitDir);
  if (!wtArgs) return [];

  try {
    gitExec([...wtArgs, "rev-parse", "HEAD"], { cwd: gitDir, timeout: 2000, encoding: "utf-8" });
  } catch {
    return [];
  }

  try {
    const out = gitExec([
      ...wtArgs, "log", "--format=COMMIT:%H%n%s%n%an%n%aI%n%D", "--follow", "--", filePath,
    ], { cwd: gitDir, timeout: 5000, encoding: "utf-8" });

    const commits: { hash: string; subject: string; author: string; date: string; refs: string | null; dualview: AdfiMeta | null }[] = [];
    let current: { hash: string; subject: string; author: string; date: string; refs: string | null; dualview: AdfiMeta | null } | null = null;

    for (const line of out.split("\n")) {
      if (line.startsWith("COMMIT:")) {
        if (current) commits.push(current);
        current = { hash: line.slice(7), subject: "", author: "", date: "", refs: null, dualview: null };
      } else if (current) {
        if (!current.subject) {
          current.subject = line;
          current.dualview = parseAdfiSubject(line);
        }
        else if (!current.author) current.author = line;
        else if (!current.date) current.date = line;
        else if (current.refs === null) current.refs = line.trim();
      }
    }
    if (current) commits.push(current);
    return commits;
  } catch {
    return [];
  }
}

/** Get file content at a specific git commit. */
export function getFileAtCommit(batchId: string, wsId: string, subdir: string, filePath: string, commitHash: string): { content: string; binary: boolean } | null {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return null;
  return getFileAtCommitForDir(wsDir, subdir, filePath, commitHash);
}

/** Get file content at a specific git commit given a workspace dir. */
export function getFileAtCommitForDir(wsDir: string, subdir: string, filePath: string, commitHash: string): { content: string; binary: boolean } | null {
  const gitDir = resolveGitDirForSubdir(wsDir, subdir);
  const wtArgs = resolveGitArgsForDir(gitDir);
  if (!wtArgs) return null;

  if (!/^[0-9a-f]+$/i.test(commitHash)) return null;

  try {
    const buf = gitExec([
      ...wtArgs, "show", `${commitHash}:${filePath}`,
    ], { cwd: gitDir, timeout: 5000 });

    const isBinary = buf.indexOf(0) !== -1;
    if (isBinary) return { content: `(binary file, ${buf.length} bytes)`, binary: true };
    return { content: buf.toString("utf-8"), binary: false };
  } catch {
    return null;
  }
}

/** Get full commit details: message + diff. */
export function getCommitDetail(batchId: string, wsId: string, subdir: string, commitHash: string): { hash: string; subject: string; author: string; date: string; refs: string; dualview: AdfiMeta | null; body: string; diff: string } | null {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return null;
  return getCommitDetailForDir(wsDir, subdir, commitHash);
}

/** Get full commit details given a workspace dir. */
export function getCommitDetailForDir(wsDir: string, subdir: string, commitHash: string): { hash: string; subject: string; author: string; date: string; refs: string; dualview: AdfiMeta | null; body: string; diff: string } | null {
  const gitDir = resolveGitDirForSubdir(wsDir, subdir);
  const wtArgs = resolveGitArgsForDir(gitDir);
  if (!wtArgs) return null;
  if (!/^[0-9a-f]+$/i.test(commitHash)) return null;

  try {
    const info = gitExec([
      ...wtArgs, "log", "-1", "--format=%H%n%s%n%an%n%aI%n%D%n%b", commitHash,
    ], { cwd: gitDir, timeout: 5000, encoding: "utf-8" });

    const lines = info.split("\n");
    const subject = lines[1] ?? "";
    const diff = gitExec([
      ...wtArgs, "diff-tree", "-p", "--root", commitHash,
    ], { cwd: gitDir, timeout: 10000, encoding: "utf-8" });

    return {
      hash: lines[0] ?? "",
      subject,
      author: lines[2] ?? "",
      date: lines[3] ?? "",
      refs: (lines[4] ?? "").trim(),
      dualview: parseAdfiSubject(subject),
      body: lines.slice(5).join("\n").trim(),
      diff,
    };
  } catch {
    return null;
  }
}

type AdfiCommitGroup = Array<{
  hash: string; trusted: boolean; toolName: string; callId: string; runId: string;
  refs: string; date: string;
  files: Array<{ path: string; content: string | null; binary: boolean }>;
}>;

/** Get DUALVIEW commits grouped by callId, with per-file content at each commit. */
export function getAdfiCommitsByCallId(batchId: string, wsId: string, subdir: string): Record<string, AdfiCommitGroup> {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return {};
  return getAdfiCommitsByCallIdForDir(wsDir, subdir);
}

/** Get DUALVIEW commits grouped by callId given a workspace dir and subdirectory. */
export function getAdfiCommitsByCallIdForDir(wsDir: string, subdir: string): Record<string, AdfiCommitGroup> {
  const result: Record<string, AdfiCommitGroup> = {};
  const commits = getGitLogForDir(wsDir, subdir) as Array<{
    hash: string; subject: string; author: string; date: string; refs: string;
    dualview: AdfiMeta | null; files: string[];
  }>;

  const gitDir = resolveGitDirForSubdir(wsDir, subdir);
  const wtArgs = resolveGitArgsForDir(gitDir);
  if (!wtArgs) return result;

  for (const c of commits) {
    if (!c.dualview) continue;
    const { callId, trusted, toolName, runId } = c.dualview;
    if (!result[callId]) result[callId] = [];

    // Get file content at this commit for each changed file
    const files: Array<{ path: string; content: string | null; binary: boolean }> = [];
    for (const filePath of c.files) {
      try {
        const buf = gitExec([
          ...wtArgs, "show", `${c.hash}:${filePath}`,
        ], { cwd: gitDir, timeout: 5000 });
        const isBinary = buf.indexOf(0) !== -1;
        files.push({
          path: filePath,
          content: isBinary ? null : buf.toString("utf-8"),
          binary: isBinary,
        });
      } catch {
        files.push({ path: filePath, content: null, binary: false });
      }
    }

    result[callId].push({
      hash: c.hash,
      trusted,
      toolName,
      callId,
      runId,
      refs: c.refs,
      date: c.date,
      files,
    });
  }

  return result;
}
