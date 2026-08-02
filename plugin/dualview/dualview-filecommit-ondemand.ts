/**
 * On-demand mode FileCommit — after_tool_call handler.
 *
 * Scans all active tracked roots for changes in their trusted worktrees,
 * then performs the dual-branch commit (TRUSTED + UNTRUSTED) for each.
 *
 * Uses GIT_DIR + GIT_WORK_TREE environment variables to operate on
 * canonical DualView workspaces under ~/.dualview/workspaces/<workspace-id>/.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmdirSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { gitExecSync } from "./dualview-git.js";
import {
  getTrackedRoots,
  dualviewGitOpts,
  type TrackedRoot,
} from "./dualview-ondemand.js";
import {
  loadSymbolMap,
  resolveAllSymbols,
  hasSymbols,
} from "./dualview-symbol-table.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface OnDemandFileCommitOptions {
  dbPath?: string;
  log?: Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches existing auditWrite pattern in dualview-filecommit-worktree.ts
  auditWrite?: (entry: any) => void;
}

interface FileCommitEvent {
  toolName: string;
  toolCallId?: string;
  runId?: string;
}

interface CommitOpts {
  trusted: boolean;
  toolName: string;
  callId?: string;
  runId?: string;
  files?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock helpers — zero footprint (lock lives in shadow dir, not user's project)
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 30_000;

function acquireLockOd(root: TrackedRoot): void {
  const shadowDir = dirname(root.gitDir);
  const lockDir = join(shadowDir, "commit.lock");
  if (!existsSync(shadowDir)) mkdirSync(shadowDir, { recursive: true });

  if (existsSync(lockDir)) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lockDir);
      }
    } catch { /* not found */ }
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`[DualView-ondemand] commit lock held by another process: ${lockDir}`);
    }
    throw err;
  }
}

function releaseLockOd(root: TrackedRoot): void {
  const shadowDir = dirname(root.gitDir);
  const lockDir = join(shadowDir, "commit.lock");
  try { rmdirSync(lockDir); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git helpers — using external GIT_DIR via dualviewGitOpts
// ─────────────────────────────────────────────────────────────────────────────

function getChangedFilesOd(root: TrackedRoot, worktree: string): { status: string; path: string }[] {
  const { stdout } = gitExecSync(["status", "--porcelain"], dualviewGitOpts(root, worktree));
  if (!stdout.trim()) return [];
  return stdout.trim().split("\n").map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line[2] === " " ? line.slice(3) : line.slice(2),
  }));
}

function stageFilesOd(root: TrackedRoot, worktree: string, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  gitExecSync(["add", "--", ...filePaths], dualviewGitOpts(root, worktree));
}

function collectFilePathsUnder(dirPath: string, relPath: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const childAbs = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilePathsUnder(childAbs, childRel));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(childRel);
    }
  }
  return results;
}

function expandTrustedChangedPaths(root: TrackedRoot, filePaths: string[]): string[] {
  const expanded = new Set<string>();
  for (const filePath of filePaths) {
    const cleanPath = filePath.replace(/\/+$/, "");
    const trustedFilePath = join(root.trustedPath, cleanPath);
    if (!existsSync(trustedFilePath)) {
      expanded.add(cleanPath);
      continue;
    }

    const stat = statSync(trustedFilePath);
    if (stat.isDirectory()) {
      for (const nested of collectFilePathsUnder(trustedFilePath, cleanPath)) {
        expanded.add(nested);
      }
    } else {
      expanded.add(cleanPath);
    }
  }
  return [...expanded].sort();
}

function commitOd(root: TrackedRoot, worktree: string, opts: CommitOpts): void {
  const tag = opts.trusted ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
  const filesMeta = opts.files?.length ? ` files=${opts.files.join(",")}` : "";
  const msg = `${tag} dualview: tool=${opts.toolName || "unknown"} callId=${opts.callId || "none"} run=${opts.runId || "none"}${filesMeta}`;
  const flags = opts.trusted ? [] : ["--no-verify"];
  gitExecSync(["commit", "-m", msg, "--allow-empty", ...flags], dualviewGitOpts(root, worktree));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an on-demand mode FileCommit handler for the after_tool_call hook.
 *
 * Iterates over all active tracked roots; for each root whose trusted
 * worktree has uncommitted changes, performs the dual-branch commit:
 *
 *   1. Commit [DUALVIEW-TRUSTED] on dualview-trusted branch (trusted worktree)
 *   2. Sync this tool call's changed files to main worktree (real filesystem)
 *   3. Commit [DUALVIEW-TRUSTED] on master (blame-visible trusted parent)
 *   4. De-symbolize in main worktree
 *   5. Commit [DUALVIEW-UNTRUSTED] on master (raw content)
 */
export function createOnDemandFileCommitHandler({ dbPath, log, auditWrite }: OnDemandFileCommitOptions) {
  return async (event: FileCommitEvent, _ctx: unknown): Promise<void> => {
    if (log) log.info(`[DualView-filecommit-od] after_tool_call FIRED: tool=${event?.toolName}`);

    for (const [_workTree, root] of getTrackedRoots()) {
      try {
        // 1. Detect changes in the trusted worktree
        const changed = getChangedFilesOd(root, root.trustedPath);
        if (changed.length === 0) continue;

        if (log) log.info(`[DualView-filecommit-od] ${root.workTree}: ${changed.length} changed file(s) in trusted worktree`);

        acquireLockOd(root);
        try {
          const filePaths = changed.map((f) => f.path);

          // 2. Commit trusted snapshot on the dualview-trusted branch
          stageFilesOd(root, root.trustedPath, filePaths);
          commitOd(root, root.trustedPath, {
            trusted: true,
            toolName: event.toolName,
            callId: event.toolCallId,
            runId: event.runId,
            files: filePaths,
          });
          const { stdout: trustedHeadOut } = gitExecSync(
            ["rev-parse", "HEAD"],
            dualviewGitOpts(root, root.trustedPath),
          );
          const trustedBranchHead = trustedHeadOut.trim();
          if (log) {
            log.info(`[DualView-filecommit-od] Committed ${filePaths.length} file(s) as [DUALVIEW-TRUSTED] on dualview-trusted: ${trustedBranchHead}`);
          }

          // 3. Sync only paths dirtied by this tool call to main. Do not diff
          // against master: trusted and main intentionally differ for policy
          // files, and those representation differences are not current writes.
          const syncedPaths = expandTrustedChangedPaths(root, filePaths);

          for (const filePath of syncedPaths) {
            const trustedFilePath = join(root.trustedPath, filePath);
            const mainFilePath = join(root.workTree, filePath);

            if (!existsSync(trustedFilePath)) {
              gitExecSync(
                ["rm", "-f", "--ignore-unmatch", "--", filePath],
                dualviewGitOpts(root),
              );
              continue;
            }

            const mainDir = dirname(mainFilePath);
            if (!existsSync(mainDir)) mkdirSync(mainDir, { recursive: true });
            copyFileSync(trustedFilePath, mainFilePath);
          }

          // 4. Commit trusted twin on master
          stageFilesOd(root, root.workTree, syncedPaths);
          commitOd(root, root.workTree, {
            trusted: true,
            toolName: event.toolName,
            callId: event.toolCallId,
            runId: event.runId,
            files: filePaths,
          });
          if (log) {
            log.info(`[DualView-filecommit-od] Committed ${syncedPaths.length} file(s) as [DUALVIEW-TRUSTED] on master`);
          }

          // 5. De-symbolize synced files in main worktree
          const symbolMap = loadSymbolMap(dbPath);
          for (const filePath of syncedPaths) {
            const mainFilePath = join(root.workTree, filePath);
            if (!existsSync(mainFilePath)) continue;

            const content = readFileSync(mainFilePath);
            const sample = content.subarray(0, 8192);
            if (sample.includes(0)) continue;

            const text = content.toString("utf8");
            if (hasSymbols(text) && symbolMap.symbols.size > 0) {
              const resolved = resolveAllSymbols(text, symbolMap);
              writeFileSync(mainFilePath, resolved);
            }
          }

          // 6. Commit untrusted version on master
          const mainChanged = getChangedFilesOd(root, root.workTree);
          if (mainChanged.length > 0) {
            stageFilesOd(root, root.workTree, syncedPaths);
          }
          commitOd(root, root.workTree, {
            trusted: false,
            toolName: event.toolName,
            callId: event.toolCallId,
            runId: event.runId,
            files: filePaths,
          });

          if (log) {
            log.info(`[DualView-filecommit-od] Committed ${syncedPaths.length} file(s) as [DUALVIEW-UNTRUSTED] on master`);
          }

          if (auditWrite) {
            auditWrite({
              hook: "file_commit_ondemand",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              runId: event.runId,
              workTree: root.workTree,
              trustedFiles: filePaths,
              syncedFiles: syncedPaths,
              trustedBranchHead,
            });
          }
        } finally {
          releaseLockOd(root);
        }
      } catch (err) {
        if (log) {
          log.warn(`[DualView-filecommit-od] Error for ${root.workTree}: ${(err as Error).message}`);
        }
      }
    }
  };
}
