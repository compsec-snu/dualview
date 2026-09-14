/**
 * On-demand mode FileCommit — after_tool_call handler.
 *
 * Scans all active tracked roots for changes in their trusted worktrees,
 * then performs the dual-branch commit (TRUSTED + UNTRUSTED) for each.
 *
 * Uses GIT_DIR + GIT_WORK_TREE environment variables to operate on
 * canonical DualView workspaces under ~/.dualview/workspaces/<workspace-id>/.
 */

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import {
  gitExecSync,
  gitExecSyncOrThrow,
  fileSnapshotsEqual,
  readGitIndexSnapshot,
  readFilesystemSnapshot,
  readWorktreeSnapshot,
  stageFileSnapshots,
  writeFilesystemSnapshot,
  writeConflictLog,
  type GitFileSnapshot,
} from "./dualview-git.js";
import {
  getTrackedRoots,
  dualviewGitOpts,
  type TrackedRoot,
} from "./dualview-ondemand.js";
import {
  loadSymbolMap,
  resolveAllSymbols,
  hasSymbols,
  type SymbolMap,
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
  /** Caller-owned symbols, including in-memory-only policy_file allocations. */
  symbolMap?: SymbolMap;
  log?: Logger;
  /** Restrict commit scanning to selected roots. Defaults to the global registry. */
  roots?: () => Iterable<TrackedRoot>;
  /** Restrict each selected root to paths within the configured workspace scope. */
  pathFilter?: (root: TrackedRoot, filePath: string) => boolean;
  /** Human paths intentionally staged by an adapter as part of the same write. */
  allowedHumanChanges?: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches existing auditWrite pattern in dualview-filecommit-worktree.ts
  auditWrite?: (entry: any) => void;
  /** Propagate synchronization failures for adapters that require fail-closed writes. */
  throwOnError?: boolean;
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
  const { stdout } = gitExecSyncOrThrow(
    ["status", "--porcelain"],
    dualviewGitOpts(root, worktree),
    `reading worktree status for ${worktree}`,
  );
  if (!stdout.trim()) return [];
  return stdout.trim().split("\n").map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line[2] === " " ? line.slice(3) : line.slice(2),
  }));
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
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(trustedFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      expanded.add(cleanPath);
      continue;
    }

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

let snapshotInstallCounter = 0;

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function worktreeSnapshot(rootPath: string, filePath: string): GitFileSnapshot {
  return readWorktreeSnapshot(rootPath, filePath);
}

function installSnapshotIfUnchanged(
  targetPath: string,
  expected: GitFileSnapshot,
  desired: GitFileSnapshot,
): boolean {
  const token = `${process.pid}-${++snapshotInstallCounter}`;
  const backupPath = `${targetPath}.dualview-backup-${token}`;
  const temporaryPath = `${targetPath}.dualview-install-${token}`;
  let movedOriginal = false;

  const discardOrRestoreBackup = () => {
    if (!movedOriginal || !pathExists(backupPath)) return;
    if (pathExists(targetPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    } else {
      renameSync(backupPath, targetPath);
    }
    movedOriginal = false;
  };

  try {
    try {
      renameSync(targetPath, backupPath);
      movedOriginal = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const movedSnapshot = movedOriginal
      ? readFilesystemSnapshot(backupPath, expected.path)
      : { path: expected.path, content: null };
    if (!fileSnapshotsEqual(movedSnapshot, expected)) {
      discardOrRestoreBackup();
      return false;
    }

    if (pathExists(targetPath)) {
      discardOrRestoreBackup();
      return false;
    }

    if (desired.content !== null) {
      const parentDir = dirname(targetPath);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      try {
        if (desired.mode === "120000") {
          symlinkSync(desired.content.toString(), targetPath);
        } else {
          const mode = desired.mode === "100755" ? 0o755 : 0o644;
          writeFileSync(temporaryPath, desired.content, { mode });
          chmodSync(temporaryPath, mode);
          linkSync(temporaryPath, targetPath);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        discardOrRestoreBackup();
        return false;
      } finally {
        rmSync(temporaryPath, { recursive: true, force: true });
      }
    }

    if (movedOriginal) {
      rmSync(backupPath, { recursive: true, force: true });
      movedOriginal = false;
    }
    return true;
  } catch (err) {
    rmSync(temporaryPath, { recursive: true, force: true });
    discardOrRestoreBackup();
    throw err;
  }
}

function restoreTrustedPaths(root: TrackedRoot, filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    const tracked = gitExecSyncOrThrow(
      ["ls-tree", "-r", "--name-only", "HEAD", "--", filePath],
      dualviewGitOpts(root, root.trustedPath),
      `checking trusted HEAD for ${filePath}`,
    ).stdout.trim();
    if (tracked) {
      gitExecSyncOrThrow(
        ["restore", "--source=HEAD", "--worktree", "--", filePath],
        dualviewGitOpts(root, root.trustedPath),
        `restoring trusted path ${filePath}`,
      );
      continue;
    }
    rmSync(join(root.trustedPath, filePath), { recursive: true, force: true });
  }
}

function commitOd(root: TrackedRoot, worktree: string, opts: CommitOpts): void {
  const tag = opts.trusted ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
  const filesMeta = opts.files?.length ? ` files=${opts.files.join(",")}` : "";
  const msg = `${tag} dualview: tool=${opts.toolName || "unknown"} callId=${opts.callId || "none"} run=${opts.runId || "none"}${filesMeta}`;
  const flags = opts.trusted ? [] : ["--no-verify"];
  gitExecSyncOrThrow(
    ["commit", "-m", msg, "--allow-empty", ...flags],
    dualviewGitOpts(root, worktree),
    `${tag} commit`,
  );
}

function latestCommitSubjectForPath(
  root: TrackedRoot,
  commit: string,
  filePath: string,
): string {
  return gitExecSyncOrThrow(
    ["log", "-1", "--format=%s", commit, "--", filePath],
    dualviewGitOpts(root),
    `reading latest commit for ${filePath}`,
  ).stdout.trim();
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
 *   2. Resolve and install Human-facing snapshots without overwriting Human edits
 *   3. Commit [DUALVIEW-TRUSTED] on master (blame-visible trusted parent)
 *   4. Commit [DUALVIEW-UNTRUSTED] on master (Human-facing content)
 */
export function createOnDemandFileCommitHandler({
  dbPath,
  symbolMap: externalSymbolMap,
  log,
  roots,
  pathFilter,
  allowedHumanChanges,
  auditWrite,
  throwOnError,
}: OnDemandFileCommitOptions) {
  const allowedHumanPaths = new Set(allowedHumanChanges ?? []);
  return async (event: FileCommitEvent, _ctx: unknown): Promise<void> => {
    if (log) log.info(`[DualView-filecommit-od] after_tool_call FIRED: tool=${event?.toolName}`);

    for (const root of roots?.() ?? getTrackedRoots().values()) {
      try {
        // 1. Detect changes in the trusted worktree
        const changed = getChangedFilesOd(root, root.trustedPath)
          .filter((file) => !pathFilter || pathFilter(root, file.path));
        if (changed.length === 0) continue;

        if (log) log.info(`[DualView-filecommit-od] ${root.workTree}: ${changed.length} changed file(s) in trusted worktree`);

        acquireLockOd(root);
        try {
          const filePaths = changed.map((f) => f.path);
          // Sync only paths dirtied by this tool call to main. Do not diff
          // against master: trusted and main intentionally differ for policy
          // files, and those representation differences are not current writes.
          const syncedPaths = expandTrustedChangedPaths(root, filePaths);
          const trustedSnapshots = new Map(
            syncedPaths.map((filePath) => [
              filePath,
              worktreeSnapshot(root.trustedPath, filePath),
            ]),
          );
          const persistedSymbols = loadSymbolMap(dbPath);
          const symbolMap: SymbolMap = {
            symbols: new Map([
              ...(externalSymbolMap?.symbols ?? []),
              ...persistedSymbols.symbols,
            ]),
          };
          const humanSnapshots = new Map(
            [...trustedSnapshots].map(([filePath, snapshot]) => {
              if (snapshot.content === null
                || snapshot.mode === "120000"
                || snapshot.content.subarray(0, 8192).includes(0)) {
                return [filePath, snapshot];
              }
              const text = snapshot.content.toString("utf8");
              return [
                filePath,
                {
                  ...snapshot,
                  content: Buffer.from(
                    hasSymbols(text) && symbolMap.symbols.size > 0
                      ? resolveAllSymbols(text, symbolMap)
                      : text,
                  ),
                },
              ];
            }),
          );
          const mainHead = gitExecSyncOrThrow(
            ["rev-parse", "HEAD"],
            dualviewGitOpts(root),
            "reading main branch HEAD",
          ).stdout.trim();
          const trustedHead = gitExecSyncOrThrow(
            ["rev-parse", "HEAD"],
            dualviewGitOpts(root, root.trustedPath),
            "reading trusted branch HEAD",
          ).stdout.trim();
          const supersededHumanPaths = syncedPaths.filter((filePath) => {
            if (trustedSnapshots.size !== 1) return false;
            const snapshot = trustedSnapshots.get(filePath);
            return snapshot?.content === null
              && latestCommitSubjectForPath(root, mainHead, filePath)
                .startsWith("[DUALVIEW-HUMAN]");
          });
          const mainDirty = new Set<string>();
          for (const file of getChangedFilesOd(root, root.workTree)) {
            mainDirty.add(file.path);
          }
          let safeSyncedPaths: string[] = [];
          const skippedPaths: string[] = [];
          const skippedReasons = new Map<string, string>();
          const skipForRace = (filePath: string, reason: string) => {
            skippedPaths.push(filePath);
            skippedReasons.set(filePath, reason);
            if (log) {
              log.warn(`[DualView-filecommit-od] R2 race: skipping ${filePath} (${reason})`);
            }
          };
          const expectedSnapshots = new Map<string, GitFileSnapshot>();
          const installCandidates: string[] = [];
          for (const filePath of syncedPaths) {
            const dirtyAtSync = !allowedHumanPaths.has(filePath)
              && (
                mainDirty.has(filePath)
                || getChangedFilesOd(root, root.workTree).some((file) => file.path === filePath)
              );
            if (dirtyAtSync) {
              skipForRace(filePath, "main worktree has uncommitted edits; refusing to overwrite");
              continue;
            }

            const dirtyAfterRescan = !allowedHumanPaths.has(filePath)
              && getChangedFilesOd(root, root.workTree)
                .some((file) => file.path === filePath);
            if (dirtyAfterRescan) {
              skipForRace(filePath, "main worktree changed after per-path rescan");
              continue;
            }

            expectedSnapshots.set(
              filePath,
              readGitIndexSnapshot(filePath, dualviewGitOpts(root)),
            );
            installCandidates.push(filePath);
          }

          const installedPaths: string[] = [];
          try {
            for (const filePath of installCandidates) {
              const mainFilePath = join(root.workTree, filePath);
              const desired = humanSnapshots.get(filePath)!;
              const expected = expectedSnapshots.get(filePath)!;
              const installed = installSnapshotIfUnchanged(mainFilePath, expected, desired);
              if (!installed) {
                skipForRace(filePath, "main worktree changed while applying Agent file changes");
                continue;
              }
              installedPaths.push(filePath);
            }
            safeSyncedPaths = [...installedPaths];

            safeSyncedPaths = safeSyncedPaths.filter((filePath) => {
              const desired = humanSnapshots.get(filePath)!;
              const current = worktreeSnapshot(root.workTree, filePath);
              const unchanged = fileSnapshotsEqual(desired, current);
              if (!unchanged) {
                skipForRace(filePath, "main worktree changed after copy/remove");
              }
              return unchanged;
            });
          } catch (err) {
            const rollbackErrors: string[] = [];
            for (const filePath of [...installedPaths].reverse()) {
              try {
                installSnapshotIfUnchanged(
                  join(root.workTree, filePath),
                  humanSnapshots.get(filePath)!,
                  expectedSnapshots.get(filePath)!,
                );
              } catch (rollbackErr) {
                rollbackErrors.push(`${filePath}: ${(rollbackErr as Error).message}`);
              }
            }
            if (rollbackErrors.length > 0) {
              throw new Error(
                `${(err as Error).message}; install rollback failed: ${rollbackErrors.join("; ")}`,
              );
            }
            throw err;
          }

          const safeSet = new Set(safeSyncedPaths);
          const skippedSyncedPaths = syncedPaths.filter((filePath) => !safeSet.has(filePath));
          let trustedBranchHead = trustedHead;
          try {
            gitExecSyncOrThrow(
              ["reset", "--mixed", "--quiet", "HEAD"],
              dualviewGitOpts(root, root.trustedPath),
              "resetting trusted shadow index",
            );
            stageFileSnapshots(
              [...trustedSnapshots.values()],
              dualviewGitOpts(root, root.trustedPath),
            );
            commitOd(root, root.trustedPath, {
              trusted: true,
              toolName: event.toolName,
              callId: event.toolCallId,
              runId: event.runId,
              files: syncedPaths,
            });
            trustedBranchHead = gitExecSyncOrThrow(
              ["rev-parse", "HEAD"],
              dualviewGitOpts(root, root.trustedPath),
              "reading committed trusted branch HEAD",
            ).stdout.trim();
            if (log) {
              log.info(
                `[DualView-filecommit-od] Committed ${syncedPaths.length} file(s) as [DUALVIEW-TRUSTED] on dualview-trusted: ${trustedBranchHead}`,
              );
            }
            const recordSkippedPaths = () => {
              for (const filePath of skippedSyncedPaths) {
                writeConflictLog(root.workTree, {
                  race: "R2",
                  source: "createOnDemandFileCommitHandler",
                  target: filePath,
                  reason: skippedReasons.get(filePath) ?? "concurrent Human file operation",
                  extra: {
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    runId: event.runId,
                    trustedBranchHead,
                  },
                });
              }
            };
            const recordSupersededHumanPaths = () => {
              for (const filePath of supersededHumanPaths) {
                writeConflictLog(root.workTree, {
                  race: "R2",
                  source: "createOnDemandFileCommitHandler",
                  target: filePath,
                  reason: "Agent deletion superseded a reconciled Human file operation",
                  extra: {
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    runId: event.runId,
                    outcome: "human-operation-superseded",
                    trustedBranchHead,
                  },
                });
              }
            };
            restoreTrustedPaths(root, skippedSyncedPaths);

            if (safeSyncedPaths.length === 0) {
              if (log) {
                log.warn(
                  `[DualView-filecommit-od] All ${syncedPaths.length} path(s) skipped due to R2 race`,
                );
              }
              recordSkippedPaths();
              recordSupersededHumanPaths();
              if (auditWrite) {
                auditWrite({
                  hook: "file_commit_ondemand",
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  runId: event.runId,
                  workTree: root.workTree,
                  trustedFiles: filePaths,
                  syncedFiles: [],
                  skippedDirtyFiles: skippedPaths,
                  trustedBranchHead,
                });
              }
              if (throwOnError) {
                throw new Error(
                  `DualView refused to overwrite ${skippedPaths.length} Human File System path(s)`,
                );
              }
              continue;
            }

            // Commit the Agent snapshot only for paths that reached the Human
            // File System without overwriting a concurrent Human operation.
            const safeTrustedSnapshots = safeSyncedPaths.map(
              (filePath) => trustedSnapshots.get(filePath)!,
            );
            const safeHumanSnapshots = safeSyncedPaths.map(
              (filePath) => humanSnapshots.get(filePath)!,
            );

            gitExecSyncOrThrow(
              ["reset", "--mixed", "--quiet", "HEAD"],
              dualviewGitOpts(root),
              "resetting main shadow index",
            );
            stageFileSnapshots(safeTrustedSnapshots, dualviewGitOpts(root));
            commitOd(root, root.workTree, {
              trusted: true,
              toolName: event.toolName,
              callId: event.toolCallId,
              runId: event.runId,
              files: safeSyncedPaths,
            });
            if (log) {
              log.info(`[DualView-filecommit-od] Committed ${safeSyncedPaths.length} file(s) as [DUALVIEW-TRUSTED] on master`);
            }

            stageFileSnapshots(safeHumanSnapshots, dualviewGitOpts(root));
            commitOd(root, root.workTree, {
              trusted: false,
              toolName: event.toolName,
              callId: event.toolCallId,
              runId: event.runId,
              files: safeSyncedPaths,
            });

            if (log) {
              log.info(`[DualView-filecommit-od] Committed ${safeSyncedPaths.length} file(s) as [DUALVIEW-UNTRUSTED] on master`);
            }
            recordSkippedPaths();
            recordSupersededHumanPaths();
          } catch (err) {
            const rollbackErrors: string[] = [];
            const rollback = (label: string, action: () => void) => {
              try {
                action();
              } catch (rollbackErr) {
                rollbackErrors.push(`${label}: ${(rollbackErr as Error).message}`);
              }
            };

            rollback("main branch", () => {
              gitExecSyncOrThrow(
                ["reset", "--mixed", "--quiet", mainHead],
                dualviewGitOpts(root),
                "rolling back main branch",
              );
              for (const filePath of [...installedPaths].reverse()) {
                installSnapshotIfUnchanged(
                  join(root.workTree, filePath),
                  humanSnapshots.get(filePath)!,
                  expectedSnapshots.get(filePath)!,
                );
              }
            });
            rollback("trusted branch", () => {
              gitExecSyncOrThrow(
                ["reset", "--mixed", "--quiet", trustedHead],
                dualviewGitOpts(root, root.trustedPath),
                "rolling back trusted branch",
              );
              for (const snapshot of trustedSnapshots.values()) {
                writeFilesystemSnapshot(
                  join(root.trustedPath, snapshot.path),
                  snapshot,
                );
              }
            });

            if (rollbackErrors.length > 0) {
              throw new Error(
                `${(err as Error).message}; File commit rollback failed: ${rollbackErrors.join("; ")}`,
              );
            }
            throw err;
          }

          if (auditWrite) {
            auditWrite({
              hook: "file_commit_ondemand",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              runId: event.runId,
              workTree: root.workTree,
              trustedFiles: filePaths,
              syncedFiles: safeSyncedPaths,
              skippedDirtyFiles: skippedPaths,
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
        if (throwOnError) throw err;
      }
    }
  };
}
