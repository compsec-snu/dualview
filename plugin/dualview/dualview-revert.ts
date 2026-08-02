/**
 * DualView Revert — full-state filesystem rollback.
 *
 * Revert means moving the entire filesystem state back to a specific point
 * in the DualView commit history. This is a full reset, not a partial undo.
 *
 * See docs/design/revert.md for the design.
 */

import {
  gitExecSync,
  getWorktreePath,
  parseDualViewCommitMessage,
  type ParsedDualViewCommit,
} from "./dualview-git.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteCycle {
  /** 1-based write number (oldest = 1) */
  number: number;
  /** The [DUALVIEW-UNTRUSTED] commit hash on master */
  untrustedCommit: string;
  /** The [DUALVIEW-TRUSTED] commit hash on master (parent of untrustedCommit) */
  trustedCommit: string;
  /** Parsed commit metadata */
  meta: ParsedDualViewCommit;
  /** Files affected (from files= metadata, if present) */
  files: string[];
  /** Commit timestamp */
  timestamp: string;
}

export interface RevertPlan {
  /** Target write cycle to revert to */
  target: WriteCycle;
  /** Number of write cycles that will be abandoned */
  abandonedCount: number;
  /** Files that will exist after revert */
  filesKept: string[];
  /** Files that will be removed (existed after target but not at target) */
  filesRemoved: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// List write cycles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all write cycles in the DualView commit history.
 * Returns oldest-first, with 1-based numbering.
 */
export function listWriteCycles(gitRoot: string): WriteCycle[] {
  // Get all DUALVIEW-UNTRUSTED commits oldest-first
  const { stdout } = gitExecSync(
    ["log", "--fixed-strings", "--reverse", "--format=%H|%aI", "--grep=[DUALVIEW-UNTRUSTED]"],
    { cwd: gitRoot },
  );

  if (!stdout.trim()) return [];

  const lines = stdout.trim().split("\n").filter(Boolean);
  const cycles: WriteCycle[] = [];

  for (let i = 0; i < lines.length; i++) {
    const [hash, timestamp] = lines[i]!.split("|");
    if (!hash) continue;

    // The trusted commit is the parent of the untrusted commit on master
    const { stdout: parentOut } = gitExecSync(
      ["rev-parse", `${hash}~1`],
      { cwd: gitRoot },
    );
    const trustedCommit = parentOut.trim();

    // Parse commit message for metadata
    const { stdout: msgOut } = gitExecSync(
      ["log", "-1", "--format=%B", hash],
      { cwd: gitRoot },
    );
    const meta = parseDualViewCommitMessage(msgOut.trim());
    if (!meta) continue;

    // Extract files from metadata (files=a.md,b.txt)
    const filesMatch = msgOut.match(/files=([^\s]+)/);
    const files = filesMatch ? filesMatch[1]!.split(",") : [];

    cycles.push({
      number: i + 1,
      untrustedCommit: hash,
      trustedCommit,
      meta,
      files,
      timestamp: timestamp ?? "",
    });
  }

  return cycles;
}

/**
 * Find a specific write cycle by number (1-based).
 */
export function findWriteCycleByNumber(gitRoot: string, n: number): WriteCycle {
  const cycles = listWriteCycles(gitRoot);
  if (n < 1 || n > cycles.length) {
    throw new Error(`Write #${n} not found (${cycles.length} write cycles exist)`);
  }
  return cycles[n - 1]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revert plan (dry run)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute what a revert to write cycle N would do, without executing it.
 */
export function planRevert(gitRoot: string, targetNumber: number): RevertPlan {
  const cycles = listWriteCycles(gitRoot);
  if (targetNumber < 1 || targetNumber > cycles.length) {
    throw new Error(`Write #${targetNumber} not found (${cycles.length} write cycles exist)`);
  }

  const target = cycles[targetNumber - 1]!;
  const abandonedCount = cycles.length - targetNumber;

  // Files at target state
  const { stdout: targetFiles } = gitExecSync(
    ["ls-tree", "-r", "--name-only", target.untrustedCommit],
    { cwd: gitRoot },
  );
  const filesKept = targetFiles.trim().split("\n").filter((f) => f && f !== ".gitkeep");

  // Files at current state
  const { stdout: currentFiles } = gitExecSync(
    ["ls-tree", "-r", "--name-only", "HEAD"],
    { cwd: gitRoot },
  );
  const currentSet = new Set(currentFiles.trim().split("\n").filter(Boolean));

  // Files that exist now but will not exist after revert
  const keptSet = new Set(filesKept);
  const filesRemoved = [...currentSet].filter((f) => !keptSet.has(f) && f !== ".gitkeep");

  return { target, abandonedCount, filesKept, filesRemoved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute revert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revert the filesystem to the state after write cycle N.
 *
 * This performs a full-state rollback:
 *   1. git reset --hard U(N) on master
 *   2. git update-ref dualview-trusted to the N-th trusted commit
 *   3. Reset the trusted worktree
 *
 * Abandoned commits remain in git reflog.
 */
export function revertToWriteCycle(gitRoot: string, targetNumber: number): RevertPlan {
  const plan = planRevert(gitRoot, targetNumber);

  // 1. Reset master/HEAD to the target untrusted commit
  const { stderr: resetErr } = gitExecSync(
    ["reset", "--hard", plan.target.untrustedCommit],
    { cwd: gitRoot },
  );
  if (resetErr && resetErr.includes("fatal:")) {
    throw new Error(`git reset failed: ${resetErr.trim()}`);
  }

  // 2. Find the matching dualview-trusted commit.
  // The dualview-trusted chain has its own independent commits (one per write cycle).
  // Skip the initial commit (the branch root before any DualView writes) by filtering
  // for commits whose message contains [DUALVIEW-TRUSTED].
  const { stdout: trustedLog } = gitExecSync(
    ["log", "--fixed-strings", "--reverse", "--format=%H", "--grep=[DUALVIEW-TRUSTED]", "dualview-trusted"],
    { cwd: gitRoot },
  );
  const trustedCommits = trustedLog.trim().split("\n").filter(Boolean);

  if (targetNumber >= 1 && targetNumber <= trustedCommits.length) {
    const targetTrustedCommit = trustedCommits[targetNumber - 1]!;
    gitExecSync(
      ["update-ref", "refs/heads/dualview-trusted", targetTrustedCommit],
      { cwd: gitRoot },
    );
  }

  // 3. Reset the trusted worktree
  const wtPath = getWorktreePath(gitRoot);
  if (existsSync(join(wtPath, ".git"))) {
    gitExecSync(["reset", "--hard", "dualview-trusted"], { cwd: wtPath });
  }

  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "fs";
import { join } from "path";
