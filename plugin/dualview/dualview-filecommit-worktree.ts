import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import {
  getChangedFiles,
  stageFiles,
  dualviewCommit,
  acquireLock,
  releaseLock,
  getWorktreePath,
  gitExecSync,
  writeConflictLog,
  ensureGitignoreExcludes,
  initWorktree,
  isWorktreeInitialized,
} from "./dualview-git.js";
import {
  loadSymbolMap,
  resolveAllSymbols,
  hasSymbols,
} from "./dualview-symbol-table.js";

// ─────────────────────────────────────────────────────────────────────────────
// DualView Worktree FileCommit — after_tool_call handler (worktree mode)
//
// Hybrid trusted-history write path:
//   1. Detect changed files in agentview
//   2. Commit trusted snapshot on dualview-trusted branch (trusted-only lineage)
//   3. Sync this tool call's changed paths into main worktree
//   4. Stage + commit on master: [DUALVIEW-TRUSTED] (blame-visible trusted parent)
//   5. De-symbolize synced files in main worktree
//   6. Stage + commit on master: [DUALVIEW-UNTRUSTED] (raw content)
// ─────────────────────────────────────────────────────────────────────────────

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface WorktreeFileCommitOptions {
  gitRoot: string;
  dbPath?: string;
  log?: Logger;
  auditWrite?: (entry: object) => void;
}

interface FileCommitEvent {
  toolName: string;
  toolCallId?: string;
  runId?: string;
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

function expandTrustedChangedPaths(trustedPath: string, filePaths: string[]): string[] {
  const expanded = new Set<string>();
  for (const filePath of filePaths) {
    const cleanPath = filePath.replace(/\/+$/, "");
    const trustedFilePath = join(trustedPath, cleanPath);
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

/**
 * Create a worktree-mode FileCommit handler for the after_tool_call hook.
 *
 * Trusted writes are committed twice: once on the trusted-only `dualview-trusted`
 * branch/worktree, then again on master as the immediate parent of the raw
 * [DUALVIEW-UNTRUSTED] commit. This preserves plain git-blame ancestry on master
 * while keeping the trusted worktree on a trusted-only lineage.
 */
export function createWorktreeFileCommitHandler({ gitRoot, dbPath, log, auditWrite }: WorktreeFileCommitOptions) {
  const trustedPath = getWorktreePath(gitRoot);

  return async (event: FileCommitEvent, _ctx: unknown): Promise<void> => {
    if (log) log.info(`[DualView-filecommit-wt] after_tool_call FIRED: tool=${event?.toolName}`);
    try {
      // The workspace git metadata can be recreated while the trusted worktree
      // still exists. Make sure the canonical agentview worktree exists before
      // status/diff handling.
      ensureGitignoreExcludes(gitRoot);
      if (!isWorktreeInitialized(gitRoot)) {
        try {
          initWorktree(gitRoot);
        } catch (initErr) {
          if (log) log.warn(`[DualView-filecommit-wt] late initWorktree failed: ${(initErr as Error).message}`);
          return;
        }
      }

      // 1. Detect changes in the trusted worktree
      const changed = getChangedFiles(trustedPath);
      if (log) log.info(`[DualView-filecommit-wt] changed files in trusted worktree: ${changed.length}`);
      if (changed.length === 0) return;

      acquireLock(gitRoot);
      try {
        const filePaths = changed.map((f) => f.path);

        // 2. Commit trusted snapshot on the trusted-only worktree branch.
        stageFiles(trustedPath, filePaths);
        dualviewCommit(trustedPath, {
          trusted: true,
          toolName: event.toolName,
          callId: event.toolCallId,
          runId: event.runId,
          files: filePaths,
        });
        const { stdout: trustedHeadOut } = gitExecSync(["rev-parse", "HEAD"], { cwd: trustedPath });
        const trustedBranchHead = trustedHeadOut.trim();
        if (log) {
          log.info(`[DualView-filecommit-wt] Committed ${filePaths.length} file(s) as [DUALVIEW-TRUSTED] on dualview-trusted: ${trustedBranchHead}`);
        }

        // 3. Sync only paths dirtied by this tool call to main. Do not diff
        // against master: trusted and main intentionally differ for policy
        // files, and those representation differences are not current writes.
        const syncedPaths = expandTrustedChangedPaths(trustedPath, filePaths);

        // Race guard (issue #213 R2): the human may have edited files in the
        // main worktree since the last commit. Overwriting them with the
        // trusted snapshot would silently drop their work. Detect any dirty
        // main-worktree paths up front and skip those from the sync — the
        // human's uncommitted content stays put; the next reconcile pass
        // absorbs it into the trusted branch.
        const mainDirty = new Set<string>();
        for (const f of getChangedFiles(gitRoot)) mainDirty.add(f.path);

        const safeSyncedPaths: string[] = [];
        const skippedPaths: string[] = [];
        for (const filePath of syncedPaths) {
          if (mainDirty.has(filePath)) {
            skippedPaths.push(filePath);
            writeConflictLog(gitRoot, {
              race: "R2",
              source: "createWorktreeFileCommitHandler",
              target: filePath,
              reason: "main worktree has uncommitted edits; refusing to overwrite",
              extra: { toolName: event.toolName, toolCallId: event.toolCallId, runId: event.runId },
            });
            if (log) {
              log.warn(`[DualView-filecommit-wt] R2 race: skipping ${filePath} (main worktree dirty)`);
            }
            continue;
          }

          const trustedFilePath = join(trustedPath, filePath);
          const mainFilePath = join(gitRoot, filePath);

          if (!existsSync(trustedFilePath)) {
            // File deleted on trusted side: remove from main side too.
            gitExecSync(["rm", "-f", "--ignore-unmatch", "--", filePath], { cwd: gitRoot });
            safeSyncedPaths.push(filePath);
            continue;
          }

          const mainDir = dirname(mainFilePath);
          if (!existsSync(mainDir)) mkdirSync(mainDir, { recursive: true });
          copyFileSync(trustedFilePath, mainFilePath);
          safeSyncedPaths.push(filePath);
        }

        if (safeSyncedPaths.length === 0) {
          if (log) {
            log.warn(
              `[DualView-filecommit-wt] All ${syncedPaths.length} path(s) skipped due to R2 race; trusted branch moved but master untouched`,
            );
          }
          return;
        }

        // 4. Commit a trusted twin on master. This is the direct parent of the
        // next UNTRUSTED commit, preserving plain git-blame ancestry.
        stageFiles(gitRoot, safeSyncedPaths);
        dualviewCommit(gitRoot, {
          trusted: true,
          toolName: event.toolName,
          callId: event.toolCallId,
          runId: event.runId,
          files: filePaths,
        });
        if (log) {
          log.info(`[DualView-filecommit-wt] Committed ${safeSyncedPaths.length} file(s) as [DUALVIEW-TRUSTED] on master`);
        }

        // 5. De-symbolize synced files in main worktree.
        const symbolMap = loadSymbolMap(dbPath);
        for (const filePath of safeSyncedPaths) {
          const mainFilePath = join(gitRoot, filePath);

          if (!existsSync(mainFilePath)) {
            continue; // file deleted
          }

          const content = readFileSync(mainFilePath);
          const sample = content.subarray(0, 8192);
          if (sample.includes(0)) {
            continue;
          }

          const text = content.toString("utf8");
          if (hasSymbols(text) && symbolMap.symbols.size > 0) {
            const resolved = resolveAllSymbols(text, symbolMap);
            writeFileSync(mainFilePath, resolved);
          }
        }

        // 6. Commit the raw/untrusted version on master.
        const mainChanged = getChangedFiles(gitRoot);
        if (mainChanged.length > 0) {
          stageFiles(gitRoot, safeSyncedPaths);
        }
        dualviewCommit(gitRoot, {
          trusted: false,
          toolName: event.toolName,
          callId: event.toolCallId,
          runId: event.runId,
          files: filePaths,
        });

        if (log) {
          log.info(`[DualView-filecommit-wt] Committed ${safeSyncedPaths.length} file(s) as [DUALVIEW-UNTRUSTED] on master`);
        }

        if (auditWrite) {
          auditWrite({
            hook: "file_commit_worktree",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            runId: event.runId,
            trustedFiles: filePaths,
            syncedFiles: safeSyncedPaths,
            skippedDirtyFiles: skippedPaths,
            trustedBranchHead,
            untrustedFiles: safeSyncedPaths,
          });
        }
      } finally {
        releaseLock(gitRoot);
      }
    } catch (err) {
      if (log) {
        log.warn(`[DualView-filecommit-wt] Error: ${(err as Error).message}`);
      }
    }
  };
}
