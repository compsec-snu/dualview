import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import {
  gitExecSync,
  gitExecSyncOrThrow,
  getWorktreePath,
  acquireLock,
  releaseLock,
  writeConflictLog,
  ensureGitignoreExcludes,
  fileSnapshotsEqual,
  gitIndexEntrySnapshotsEqual,
  readGitIndexEntrySnapshot,
  readFilesystemSnapshot,
  readWorktreeSnapshot,
  stageFileSnapshots,
  withLockedGitIndex,
  withTemporaryGitIndex,
  writeFilesystemSnapshot,
  type ChangedFile,
  type ConflictLogEntry,
  type GitFileSnapshot,
  type GitIndexEntrySnapshot,
  type GitExecOpts,
} from "./dualview-git.js";
import {
  dualviewGitOpts,
  type TrackedRoot,
} from "./dualview-ondemand.js";
import {
  loadSymbolMap,
  hasSymbols,
  getSymbolPattern,
  obsoleteSymbol,
  allocateDerivedSymbol,
  createSymbolMutationJournal,
  rollbackSymbolMapChanges,
  type SymbolMap,
  type SymbolMutationJournal,
} from "./dualview-symbol-table.js";
import { symbolizePolicyFile } from "./dualview-policy-file.js";

// ─────────────────────────────────────────────────────────────────────────────
// DualView Human Edit Reconciliation
//
// Detects manual human edits in the human-view (main worktree), classifies
// changed lines as trusted edits or trust promotions, splits multi-line
// symbols when only part of an untrusted block is edited, and commits the
// result as [DUALVIEW-HUMAN].
//
// See docs/design/human-edit-policy.md for the full design.
// ─────────────────────────────────────────────────────────────────────────────

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Short content digest used for race detection (issue #213 R1/R2). */
function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readHumanFile(path: string, relativePath: string, policyUntrusted: boolean): Buffer {
  if (policyUntrusted && lstatSync(path).isSymbolicLink()) {
    return Buffer.from(`[blocked policy symlink: ${relativePath}]`);
  }
  return readFileSync(path);
}

// ── Line Map ────────────────────────────────────────────────────────────────

/** A segment in the trusted worktree file. */
export interface LineMapSegment {
  /** Type: 'literal' for trusted text, 'symbol' for a symbol placeholder. */
  type: "literal" | "symbol";
  /** The symbol name (only for type=symbol). */
  symName?: string;
  /** The trusted worktree line number (1-indexed). */
  trustedLine: number;
  /** Human-view line range: start (1-indexed, inclusive). */
  humanStart: number;
  /** Human-view line range: end (1-indexed, inclusive). */
  humanEnd: number;
}

/**
 * Build a line-number map between the trusted worktree and the human-view.
 *
 * For each line in the trusted worktree, if it contains a symbol, look up
 * the symbol's resolved value to determine how many human-view lines it
 * spans. Literal lines map 1:1.
 */
export function buildLineMap(
  trustedContent: string,
  symbolMap: SymbolMap,
): LineMapSegment[] {
  const trustedLines = trustedContent.split("\n");
  const segments: LineMapSegment[] = [];
  const symPattern = getSymbolPattern();
  let humanLine = 1;

  for (let i = 0; i < trustedLines.length; i++) {
    const line = trustedLines[i];
    symPattern.lastIndex = 0;
    const match = symPattern.exec(line);

    // Check if the line is purely a symbol (possibly with leading/trailing whitespace)
    if (match && line.trim() === match[0]) {
      const symName = match[0];
      const entry = symbolMap.symbols.get(symName);
      if (entry && entry.obsoleted_at == null) {
        const valueLineCount = entry.value.split("\n").length;
        segments.push({
          type: "symbol",
          symName,
          trustedLine: i + 1,
          humanStart: humanLine,
          humanEnd: humanLine + valueLineCount - 1,
        });
        humanLine += valueLineCount;
        continue;
      }
    }

    // Literal line: 1:1 mapping
    segments.push({
      type: "literal",
      trustedLine: i + 1,
      humanStart: humanLine,
      humanEnd: humanLine,
    });
    humanLine += 1;
  }

  return segments;
}

/**
 * Find the segment that contains a given human-view line number.
 */
export function findSegmentForHumanLine(
  segments: LineMapSegment[],
  humanLine: number,
): LineMapSegment | undefined {
  for (const seg of segments) {
    if (humanLine >= seg.humanStart && humanLine <= seg.humanEnd) {
      return seg;
    }
  }
  return undefined;
}

// ── Symbol Splitting ────────────────────────────────────────────────────────

/** A piece of a split symbol: either a derived symbol or human literal text. */
export interface SplitPiece {
  type: "symbol" | "literal";
  /** For type=symbol: the newly allocated derived symbol name. */
  symName?: string;
  /** For type=literal: the human-authored text lines. */
  lines?: string[];
}

export interface EditRange {
  /** 0-indexed start line within the symbol's value. */
  start: number;
  /** 0-indexed end line (inclusive) within the symbol's value. */
  end: number;
  /** The human's replacement lines for this range. */
  humanLines: string[];
}

/**
 * Split a symbol around human-edited ranges. Allocates derived symbols for
 * untouched portions and returns the ordered pieces to write into the
 * trusted worktree.
 */
export function splitSymbol(
  symbolMap: SymbolMap,
  symName: string,
  editRanges: EditRange[],
  dbPath?: string,
  journal?: SymbolMutationJournal,
): SplitPiece[] {
  const entry = symbolMap.symbols.get(symName);
  if (!entry) throw new Error(`Unknown symbol: ${symName}`);

  const valueLines = entry.value.split("\n");
  const pieces: SplitPiece[] = [];
  let cursor = 0;
  let derivedIndex = 0;

  // Sort edit ranges by start offset
  const sorted = [...editRanges].sort((a, b) => a.start - b.start);

  for (const edit of sorted) {
    // Pre-edit untouched portion
    if (cursor < edit.start) {
      const preValue = valueLines.slice(cursor, edit.start).join("\n");
      const derivedSym = allocateDerivedSymbol(symbolMap, {
        parentSymName: symName,
        value: preValue,
        lineStart: cursor,
        lineEnd: edit.start,
        splitIndex: derivedIndex++,
      }, dbPath, journal);
      pieces.push({ type: "symbol", symName: derivedSym });
    }

    // Human-edited portion
    pieces.push({ type: "literal", lines: edit.humanLines });
    cursor = edit.end + 1;
  }

  // Post-edit untouched portion
  if (cursor < valueLines.length) {
    const postValue = valueLines.slice(cursor).join("\n");
    const derivedSym = allocateDerivedSymbol(symbolMap, {
      parentSymName: symName,
      value: postValue,
      lineStart: cursor,
      lineEnd: valueLines.length,
      splitIndex: derivedIndex++,
    }, dbPath, journal);
    pieces.push({ type: "symbol", symName: derivedSym });
  }

  // Obsolete the original
  obsoleteSymbol(symbolMap, symName, "human", dbPath, journal);

  return pieces;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Files that were reconciled. */
  files: string[];
  /** Symbols that were promoted (obsoleted). */
  promotedSymbols: string[];
  /** Whether any changes were committed. */
  committed: boolean;
}

export interface ReconcileOptions {
  /** Fixed-strategy human-view git root. */
  gitRoot?: string;
  /** On-demand tracked root. Uses the shadow git context via dualviewGitOpts(). */
  trackedRoot?: TrackedRoot;
  dbPath?: string;
  log?: Logger;
  auditWrite?: (entry: object) => void;
  symbolMap?: SymbolMap;
  isPolicyUntrusted?: (absolutePath: string) => boolean;
  /** Limit reconciliation to paths within the configured workspace scope. */
  pathFilter?: (filePath: string) => boolean;
}

interface ReconcileGitContext {
  humanPath: string;
  trustedPath: string;
  humanGit: GitExecOpts;
  trustedGit: GitExecOpts;
  humanIndexIsShadow: boolean;
  pendingPath: string;
  acquire: () => void;
  release: () => void;
  writeConflict: (entry: ConflictLogEntry) => void;
}

const ONDEMAND_LOCK_STALE_MS = 30_000;

function getChangedFilesFor(opts: GitExecOpts): ChangedFile[] {
  const { stdout } = gitExecSyncOrThrow(
    ["status", "--porcelain", "--untracked-files=all"],
    opts,
    "reading worktree status",
  );
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line[2] === " " ? line.slice(3) : line.slice(2),
    }));
}

function readPendingPaths(pendingPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function writePendingPaths(pendingPath: string, paths: Iterable<string>): void {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) {
    rmSync(pendingPath, { force: true });
    return;
  }
  const parentDir = dirname(pendingPath);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(unique));
}

function addPendingPaths(pendingPath: string, paths: Iterable<string>): void {
  writePendingPaths(pendingPath, [...readPendingPaths(pendingPath), ...paths]);
}

function committedChangedPaths(
  git: ReconcileGitContext,
  fromHead: string,
  toHead: string,
  pathFilter?: (filePath: string) => boolean,
): string[] {
  const output = gitExecSyncOrThrow(
    ["diff", "--no-renames", "--name-only", "-z", fromHead, toHead],
    git.humanGit,
    "reading concurrent committed paths",
  ).stdout;
  return output
    .split("\0")
    .filter((filePath) => filePath && (!pathFilter || pathFilter(filePath)));
}

function dualviewHumanCommitFor(
  opts: GitExecOpts,
  { files, promotedSymbols }: { files: string[]; promotedSymbols: string[] },
): void {
  const msg = dualviewHumanCommitMessage(files, promotedSymbols);
  gitExecSyncOrThrow(
    ["commit", "-m", msg, "--allow-empty"],
    opts,
    "Human reconciliation commit",
  );
}

function dualviewHumanCommitMessage(
  files: string[],
  promotedSymbols: string[],
): string {
  const filesList = files.join(",");
  const promoted = promotedSymbols.length > 0 ? promotedSymbols.join(",") : "none";
  return `[DUALVIEW-HUMAN] dualview: source=human files=${filesList} promoted=${promoted}`;
}

function publishFixedHumanCommit(
  opts: GitExecOpts,
  expectedHead: string,
  snapshots: readonly GitFileSnapshot[],
  files: string[],
  promotedSymbols: string[],
): string {
  return withTemporaryGitIndex(opts, expectedHead, (commitGit) => {
    stageFileSnapshots(snapshots, commitGit);
    const tree = gitExecSyncOrThrow(
      ["write-tree"],
      commitGit,
      "writing fixed-mode Human tree",
    ).stdout.trim();
    const commit = gitExecSyncOrThrow(
      [
        "commit-tree",
        tree,
        "-p",
        expectedHead,
        "-m",
        dualviewHumanCommitMessage(files, promotedSymbols),
      ],
      commitGit,
      "creating fixed-mode Human commit",
    ).stdout.trim();
    gitExecSyncOrThrow(
      ["update-ref", "HEAD", commit, expectedHead],
      opts,
      "publishing fixed-mode Human commit",
    );
    return commit;
  });
}

function acquireOnDemandLock(root: TrackedRoot): void {
  const shadowDir = dirname(root.gitDir);
  const lockDir = join(shadowDir, "commit.lock");
  if (!existsSync(shadowDir)) mkdirSync(shadowDir, { recursive: true });

  if (existsSync(lockDir)) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > ONDEMAND_LOCK_STALE_MS) {
        rmdirSync(lockDir);
      }
    } catch {
      // Best effort stale-lock cleanup.
    }
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

function releaseOnDemandLock(root: TrackedRoot): void {
  try { rmdirSync(join(dirname(root.gitDir), "commit.lock")); } catch { /* ignore */ }
}

function writeOnDemandConflictLog(root: TrackedRoot, entry: ConflictLogEntry): void {
  try {
    const shadowDir = dirname(root.gitDir);
    if (!existsSync(shadowDir)) mkdirSync(shadowDir, { recursive: true });
    appendFileSync(join(shadowDir, "conflicts.log"), JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + "\n");
  } catch {
    // Conflict logging is best-effort and must never wedge reconciliation.
  }
}

function buildGitContext({ gitRoot, trackedRoot }: ReconcileOptions): ReconcileGitContext {
  if (gitRoot && trackedRoot) {
    throw new Error("reconcileHumanEdits: pass either gitRoot or trackedRoot, not both");
  }

  if (trackedRoot) {
    return {
      humanPath: trackedRoot.workTree,
      trustedPath: trackedRoot.trustedPath,
      humanGit: dualviewGitOpts(trackedRoot),
      trustedGit: dualviewGitOpts(trackedRoot, trackedRoot.trustedPath),
      humanIndexIsShadow: true,
      pendingPath: join(dirname(trackedRoot.trustedPath), "pending-human-reconcile.json"),
      acquire: () => acquireOnDemandLock(trackedRoot),
      release: () => releaseOnDemandLock(trackedRoot),
      writeConflict: (entry) => writeOnDemandConflictLog(trackedRoot, entry),
    };
  }

  if (!gitRoot) {
    throw new Error("reconcileHumanEdits: gitRoot or trackedRoot is required");
  }

  // Keep git's metadata directory present before status checks.
  ensureGitignoreExcludes(gitRoot);

  return {
    humanPath: gitRoot,
    trustedPath: getWorktreePath(gitRoot),
    humanGit: { cwd: gitRoot },
    trustedGit: { cwd: getWorktreePath(gitRoot) },
    humanIndexIsShadow: false,
    pendingPath: join(dirname(getWorktreePath(gitRoot)), "pending-human-reconcile.json"),
    acquire: () => acquireLock(gitRoot),
    release: () => releaseLock(gitRoot),
    writeConflict: (entry) => writeConflictLog(gitRoot, entry),
  };
}

/**
 * Detect and reconcile human edits in the human-view.
 *
 * Returns null if no human edits detected.
 */
export function reconcileHumanEdits(
  opts: ReconcileOptions,
): ReconcileResult | null {
  const { dbPath, log, auditWrite, isPolicyUntrusted, pathFilter } = opts;
  const git = buildGitContext(opts);

  // 1. Detect uncommitted changes in human-view
  const changedByPath = new Map(
    getChangedFilesFor(git.humanGit)
      .filter((file) => !pathFilter || pathFilter(file.path))
      .map((file) => [file.path, file]),
  );
  for (const filePath of readPendingPaths(git.pendingPath)) {
    if (changedByPath.has(filePath) || (pathFilter && !pathFilter(filePath))) continue;
    try {
      if (lstatSync(join(git.humanPath, filePath)).isDirectory()) continue;
      changedByPath.set(filePath, { status: "M", path: filePath });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      changedByPath.set(filePath, { status: "D", path: filePath });
    }
  }
  const changed = [...changedByPath.values()];
  if (changed.length === 0) return null;
  if (!existsSync(git.trustedPath)) return null;

  if (log) log.info(`[DualView-human-edit] Detected ${changed.length} uncommitted change(s) in human-view`);

  git.acquire();
  try {
    const persistedSymbols = loadSymbolMap(dbPath);
    const symbolMap = opts.symbolMap ?? persistedSymbols;
    if (opts.symbolMap) {
      for (const [name, entry] of persistedSymbols.symbols) {
        if (!symbolMap.symbols.has(name)) symbolMap.symbols.set(name, entry);
      }
    }
    const symbolJournal = createSymbolMutationJournal();
    const humanHead = gitExecSyncOrThrow(
      ["rev-parse", "HEAD"],
      git.humanGit,
      "reading Human branch HEAD",
    ).stdout.trim();
    const trustedHead = gitExecSyncOrThrow(
      ["rev-parse", "HEAD"],
      git.trustedGit,
      "reading trusted branch HEAD",
    ).stdout.trim();
    const reconciledFiles: string[] = [];
    const trustedBefore = new Map<string, GitFileSnapshot>();
    const pending = new Map<string, {
      humanSnapshot: GitFileSnapshot;
      applyTrusted: () => string[];
    }>();
    const preSnapshots = new Map<string, GitFileSnapshot>();

    for (const file of changed) {
      // Only process modified files (not deleted/untracked without content)
      if (file.status === "D") {
        const trustedFile = join(git.trustedPath, file.path);
        const trustedSnapshot = readFilesystemSnapshot(trustedFile, file.path);
        if (trustedSnapshot.content !== null) {
          reconciledFiles.push(file.path);
          trustedBefore.set(file.path, trustedSnapshot);
          preSnapshots.set(file.path, { path: file.path, content: null });
          pending.set(file.path, {
            humanSnapshot: { path: file.path, content: null },
            applyTrusted: () => {
              rmSync(trustedFile, { recursive: true, force: true });
              return [];
            },
          });
        }
        continue;
      }

      const humanFilePath = join(git.humanPath, file.path);
      const trustedFilePath = join(git.trustedPath, file.path);

      let humanStat: ReturnType<typeof lstatSync>;
      try {
        humanStat = lstatSync(humanFilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (humanStat.isDirectory()) continue;

      // Capture the human-view content *now*, use this buffer for every
      // downstream decision, including file type and executable mode.
      const policyUntrusted = isPolicyUntrusted?.(humanFilePath) === true;
      const humanSnapshot = readFilesystemSnapshot(humanFilePath, file.path);
      const humanContent = policyUntrusted
        ? readHumanFile(humanFilePath, file.path, true)
        : humanSnapshot.content!;
      const trustedSnapshot = readFilesystemSnapshot(trustedFilePath, file.path);
      trustedBefore.set(file.path, trustedSnapshot);
      const copyHumanContent = () => {
        writeFilesystemSnapshot(trustedFilePath, humanSnapshot);
        return [];
      };

      if (policyUntrusted) {
        reconciledFiles.push(file.path);
        preSnapshots.set(file.path, humanSnapshot);
        pending.set(file.path, {
          humanSnapshot,
          applyTrusted: () => {
            symbolizePolicyFile({
              file: file.path,
              content: humanContent,
              targetPath: trustedFilePath,
              symbolMap,
              dbPath,
              callId: "human-edit",
              journal: symbolJournal,
            });
            return [];
          },
        });
        continue;
      }

      // For new files (status ??, A): copy to trusted worktree as-is
      if (file.status === "??" || file.status === "A") {
        reconciledFiles.push(file.path);
        preSnapshots.set(file.path, humanSnapshot);
        pending.set(file.path, {
          humanSnapshot,
          applyTrusted: copyHumanContent,
        });
        continue;
      }

      // Modified file: check if trusted worktree version has symbols
      if (trustedSnapshot.content === null) {
        reconciledFiles.push(file.path);
        preSnapshots.set(file.path, humanSnapshot);
        pending.set(file.path, {
          humanSnapshot,
          applyTrusted: copyHumanContent,
        });
        continue;
      }

      // Symlinks and binary files do not contain reconcilable symbols.
      if (humanSnapshot.mode === "120000"
        || trustedSnapshot.mode === "120000"
        || humanContent.subarray(0, 8192).includes(0)) {
        reconciledFiles.push(file.path);
        preSnapshots.set(file.path, humanSnapshot);
        pending.set(file.path, {
          humanSnapshot,
          applyTrusted: copyHumanContent,
        });
        continue;
      }

      const trustedContent = trustedSnapshot.content.toString("utf8");

      // If trusted file has no symbols, simple case: just copy
      if (!hasSymbols(trustedContent)) {
        reconciledFiles.push(file.path);
        preSnapshots.set(file.path, humanSnapshot);
        pending.set(file.path, {
          humanSnapshot,
          applyTrusted: copyHumanContent,
        });
        continue;
      }

      const humanText = humanContent.toString("utf8");
      reconciledFiles.push(file.path);
      preSnapshots.set(file.path, humanSnapshot);
      pending.set(file.path, {
        humanSnapshot,
        applyTrusted: () => {
          const reconciled = reconcileFile(
            trustedContent,
            humanText,
            symbolMap,
            dbPath,
            log,
            symbolJournal,
          );
          writeFilesystemSnapshot(trustedFilePath, {
            ...humanSnapshot,
            content: Buffer.from(reconciled.content),
          });
          return reconciled.promotedSymbols;
        },
      });
    }

    // Race guard (issue #213 R1): the lock serialises DualView processes but not
    // the human's editor. Between the initial read and the commit below, the
    // human could have saved again; that new content would be staged under
    // a commit whose reconcile logic never saw it. Re-hash every file we're
    // about to stage and drop any whose on-disk content has shifted.
    const stableFiles = (filePaths: readonly string[]): string[] => {
      const safe: string[] = [];
      for (const filePath of filePaths) {
        const expected = preSnapshots.get(filePath)!;
        const onDisk = readWorktreeSnapshot(git.humanPath, filePath);
        if (fileSnapshotsEqual(expected, onDisk)) {
          safe.push(filePath);
          continue;
        }
        const expectedHash = expected.content === null ? null : hashBuffer(expected.content);
        const observedHash = onDisk.content === null ? null : hashBuffer(onDisk.content);
        git.writeConflict({
          race: "R1",
          source: "reconcileHumanEdits",
          target: filePath,
          reason: "human-view content changed during reconcile window",
          extra: {
            expectedHash,
            observedHash,
            expectedMode: expected.mode,
            observedMode: onDisk.mode,
          },
        });
        if (log) {
          log.warn(
            `[DualView-human-edit] R1 race: dropping ${filePath} (pre=${expectedHash ?? "absent"} post=${observedHash ?? "absent"})`,
          );
        }
      }
      return safe;
    };

    let safeFiles = stableFiles(reconciledFiles);
    if (safeFiles.length === 0) {
      return null;
    }

    safeFiles = stableFiles(safeFiles);
    if (safeFiles.length === 0) {
      return null;
    }
    const fixedIndexBefore = new Map<string, GitIndexEntrySnapshot>();
    const fixedHeadEntries = new Map<string, GitIndexEntrySnapshot>();
    if (!git.humanIndexIsShadow) {
      for (const filePath of safeFiles) {
        fixedIndexBefore.set(
          filePath,
          readGitIndexEntrySnapshot(filePath, git.humanGit),
        );
      }
      withTemporaryGitIndex(git.humanGit, humanHead, (headGit) => {
        for (const filePath of safeFiles) {
          fixedHeadEntries.set(
            filePath,
            readGitIndexEntrySnapshot(filePath, headGit),
          );
        }
      });
    }

    const allPromoted: string[] = [];
    let publishedHumanCommit: string | null = null;
    try {
      for (const filePath of safeFiles) {
        const operation = pending.get(filePath);
        if (operation) allPromoted.push(...operation.applyTrusted());
      }

      // Commit trusted worktree
      const trustedChanged = getChangedFilesFor(git.trustedGit)
        .filter((file) => safeFiles.includes(file.path));
      if (trustedChanged.length > 0) {
        gitExecSyncOrThrow(
          ["reset", "--mixed", "--quiet", "HEAD"],
          git.trustedGit,
          "resetting trusted shadow index",
        );
        stageFileSnapshots(
          trustedChanged.map((file) => readWorktreeSnapshot(git.trustedPath, file.path)),
          git.trustedGit,
        );
        dualviewHumanCommitFor(git.trustedGit, {
          files: safeFiles,
          promotedSymbols: allPromoted,
        });
      }

      const humanSnapshots = safeFiles.map(
        (filePath) => pending.get(filePath)!.humanSnapshot,
      );
      if (git.humanIndexIsShadow) {
        // The on-demand index is internal DualView state. Rebuild it from HEAD
        // so pre-staged paths outside this accepted set cannot leak.
        gitExecSyncOrThrow(
          ["reset", "--mixed", "--quiet", "HEAD"],
          git.humanGit,
          "resetting Human shadow index",
        );
        stageFileSnapshots(humanSnapshots, git.humanGit);
        dualviewHumanCommitFor(git.humanGit, {
          files: safeFiles,
          promotedSymbols: allPromoted,
        });
      } else {
        // Publish only if the user's branch still points to the snapshot this
        // reconciliation read.
        publishedHumanCommit = publishFixedHumanCommit(
          git.humanGit,
          humanHead,
          humanSnapshots,
          safeFiles,
          allPromoted,
        );
        const currentHumanHead = gitExecSyncOrThrow(
          ["rev-parse", "HEAD"],
          git.humanGit,
          "checking fixed-mode Human branch after publish",
        ).stdout.trim();
        if (currentHumanHead !== publishedHumanCommit) {
          addPendingPaths(
            git.pendingPath,
            committedChangedPaths(
              git,
              publishedHumanCommit,
              currentHumanHead,
              pathFilter,
            ),
          );
          throw new Error(
            "Human branch advanced after reconciliation commit; committed paths require another reconciliation pass",
          );
        }

        withLockedGitIndex(git.humanGit, (lockedIndexGit) => {
          const lockedHead = gitExecSyncOrThrow(
            ["rev-parse", "HEAD"],
            git.humanGit,
            "checking fixed-mode Human branch while refreshing the index",
          ).stdout.trim();
          if (lockedHead !== publishedHumanCommit) {
            addPendingPaths(
              git.pendingPath,
              committedChangedPaths(
                git,
                publishedHumanCommit!,
                lockedHead,
                pathFilter,
              ),
            );
            throw new Error(
              "Human branch advanced while refreshing the user index",
            );
          }

          const refreshable = safeFiles.filter((filePath) => {
            const before = fixedIndexBefore.get(filePath)!;
            const current = readGitIndexEntrySnapshot(filePath, lockedIndexGit);
            return gitIndexEntrySnapshotsEqual(before, current)
              && gitIndexEntrySnapshotsEqual(
                before,
                fixedHeadEntries.get(filePath)!,
              );
          });
          if (refreshable.length > 0) {
            gitExecSyncOrThrow(
              ["reset", "--quiet", publishedHumanCommit!, "--", ...refreshable],
              lockedIndexGit,
              "refreshing reconciled paths in the user index",
            );
          }
        });

        const headAfterIndexRefresh = gitExecSyncOrThrow(
          ["rev-parse", "HEAD"],
          git.humanGit,
          "checking fixed-mode Human branch after index refresh",
        ).stdout.trim();
        if (headAfterIndexRefresh !== publishedHumanCommit) {
          addPendingPaths(
            git.pendingPath,
            committedChangedPaths(
              git,
              publishedHumanCommit,
              headAfterIndexRefresh,
              pathFilter,
            ),
          );
          throw new Error(
            "Human branch advanced after index refresh; committed paths require another reconciliation pass",
          );
        }
      }
    } catch (err) {
      const rollbackErrors: string[] = [];
      let preservePublishedState = false;
      const rollback = (label: string, action: () => void) => {
        try {
          action();
        } catch (rollbackErr) {
          rollbackErrors.push(`${label}: ${(rollbackErr as Error).message}`);
        }
      };

      if (!git.humanIndexIsShadow && !publishedHumanCommit) {
        rollback("pending committed paths", () => {
          const currentHead = gitExecSyncOrThrow(
            ["rev-parse", "HEAD"],
            git.humanGit,
            "checking Human branch after publish conflict",
          ).stdout.trim();
          if (currentHead !== humanHead) {
            addPendingPaths(
              git.pendingPath,
              committedChangedPaths(git, humanHead, currentHead, pathFilter),
            );
          }
        });
      }

      rollback("Human branch", () => {
        if (git.humanIndexIsShadow) {
          gitExecSyncOrThrow(
            ["reset", "--mixed", "--quiet", humanHead],
            git.humanGit,
            "rolling back Human branch",
          );
        } else if (publishedHumanCommit) {
          const result = gitExecSync(
            ["update-ref", "HEAD", humanHead, publishedHumanCommit],
            git.humanGit,
          );
          if (result.code !== 0) {
            preservePublishedState = true;
            const currentHead = gitExecSyncOrThrow(
              ["rev-parse", "HEAD"],
              git.humanGit,
              "checking advanced Human branch during rollback",
            ).stdout.trim();
            addPendingPaths(
              git.pendingPath,
              committedChangedPaths(
                git,
                publishedHumanCommit!,
                currentHead,
                pathFilter,
              ),
            );
            rollbackErrors.push(
              `Human branch advanced after ${publishedHumanCommit}; not rewinding it`,
            );
          }
        }
      });
      if (!preservePublishedState) {
        rollback("trusted branch", () => {
          gitExecSyncOrThrow(
            ["reset", "--mixed", "--quiet", trustedHead],
            git.trustedGit,
            "rolling back trusted branch",
          );
          for (const filePath of safeFiles) {
            writeFilesystemSnapshot(
              join(git.trustedPath, filePath),
              trustedBefore.get(filePath)!,
            );
          }
        });
        rollback("symbol table", () => {
          rollbackSymbolMapChanges(symbolJournal, dbPath);
          for (const symName of symbolJournal.inserted.keys()) {
            symbolMap.symbols.delete(symName);
          }
          for (const [symName, change] of symbolJournal.updated) {
            symbolMap.symbols.set(symName, { ...change.before });
          }
        });
      }

      if (rollbackErrors.length > 0) {
        throw new Error(
          `${(err as Error).message}; reconciliation rollback failed: ${rollbackErrors.join("; ")}`,
        );
      }
      throw err;
    }

    const pendingAfter = readPendingPaths(git.pendingPath)
      .filter((filePath) => !safeFiles.includes(filePath));
    writePendingPaths(git.pendingPath, pendingAfter);

    if (log) {
      log.info(`[DualView-human-edit] Reconciled ${safeFiles.length} file(s), promoted ${allPromoted.length} symbol(s)`);
    }

    if (auditWrite) {
      auditWrite({
        hook: "human_edit_reconcile",
        files: safeFiles,
        promotedSymbols: allPromoted,
      });
    }

    return {
      files: safeFiles,
      promotedSymbols: allPromoted,
      committed: true,
    };
  } finally {
    git.release();
  }
}

/**
 * Reconcile a single file: build line map, detect edits within symbol
 * ranges, split symbols as needed, rewrite the trusted worktree file.
 *
 * Returns list of promoted (obsoleted) symbol names.
 */
function reconcileFile(
  trustedContent: string,
  humanContent: string,
  symbolMap: SymbolMap,
  dbPath?: string,
  log?: Logger,
  symbolJournal?: SymbolMutationJournal,
): { content: string; promotedSymbols: string[] } {
  const segments = buildLineMap(trustedContent, symbolMap);
  const humanLines = humanContent.split("\n");
  const promoted: string[] = [];

  // For each symbol segment, check if the human edited any of its lines
  // by comparing the human-view content against the symbol's resolved value.
  const trustedLines = trustedContent.split("\n");
  const newTrustedLines: string[] = [];

  for (const seg of segments) {
    if (seg.type === "literal") {
      // Literal line: use the human's version (may have been edited)
      const humanIdx = seg.humanStart - 1;
      if (humanIdx < humanLines.length) {
        newTrustedLines.push(humanLines[humanIdx]);
      } else {
        newTrustedLines.push(trustedLines[seg.trustedLine - 1]);
      }
      continue;
    }

    // Symbol segment: compare resolved value to human-view content
    const symName = seg.symName!;
    const entry = symbolMap.symbols.get(symName);
    if (!entry) {
      // Unknown symbol — keep as-is
      newTrustedLines.push(trustedLines[seg.trustedLine - 1]);
      continue;
    }

    const resolvedLines = entry.value.split("\n");
    const humanSlice = humanLines.slice(seg.humanStart - 1, seg.humanEnd);

    // Check if human content matches resolved value exactly
    if (linesEqual(resolvedLines, humanSlice)) {
      // No change to this symbol block — keep the symbol
      newTrustedLines.push(trustedLines[seg.trustedLine - 1]);
      continue;
    }

    // Human edited something within this symbol's range.
    // Find which line ranges within the symbol were changed.
    const editRanges = findEditRanges(resolvedLines, humanSlice);

    if (editRanges.length === 0) {
      // Shouldn't happen if linesEqual returned false, but guard
      newTrustedLines.push(trustedLines[seg.trustedLine - 1]);
      continue;
    }

    // Check if ALL lines were edited (full promotion, no splitting needed)
    const totalEdited = editRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    if (totalEdited >= resolvedLines.length) {
      // Full promotion: replace symbol with all human lines
      for (const line of humanSlice) {
        newTrustedLines.push(line);
      }
      obsoleteSymbol(symbolMap, symName, "human", dbPath, symbolJournal);
      promoted.push(symName);
      if (log) log.info(`[DualView-human-edit] Full promotion: ${symName}`);
      continue;
    }

    // Partial edit: split the symbol
    const pieces = splitSymbol(symbolMap, symName, editRanges, dbPath, symbolJournal);
    promoted.push(symName);

    for (const piece of pieces) {
      if (piece.type === "symbol") {
        newTrustedLines.push(piece.symName!);
      } else if (piece.lines) {
        for (const line of piece.lines) {
          newTrustedLines.push(line);
        }
      }
    }

    if (log) {
      log.info(`[DualView-human-edit] Split ${symName} into ${pieces.length} piece(s)`);
    }
  }

  return {
    content: newTrustedLines.join("\n"),
    promotedSymbols: promoted,
  };
}

/**
 * Compare two line arrays for equality.
 */
function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Find edit ranges by comparing the original resolved lines to the human's
 * version. Returns 0-indexed ranges within the original value that differ.
 *
 * When the human-view has a different number of lines than the resolved
 * value (insertions/deletions), we use a simple LCS-based diff to identify
 * which original lines were kept vs changed.
 */
function findEditRanges(resolvedLines: string[], humanLines: string[]): EditRange[] {
  if (resolvedLines.length === humanLines.length) {
    // Same line count: simple per-line comparison
    return findEditRangesSameLength(resolvedLines, humanLines);
  }
  // Different line count: treat the entire block as edited
  // (a more sophisticated LCS diff could be added later)
  return [{
    start: 0,
    end: resolvedLines.length - 1,
    humanLines: [...humanLines],
  }];
}

/**
 * Find edit ranges when line counts match (simple case).
 * Groups consecutive changed lines into ranges.
 */
function findEditRangesSameLength(resolvedLines: string[], humanLines: string[]): EditRange[] {
  const ranges: EditRange[] = [];
  let rangeStart: number | null = null;

  for (let i = 0; i < resolvedLines.length; i++) {
    if (resolvedLines[i] !== humanLines[i]) {
      if (rangeStart === null) rangeStart = i;
    } else {
      if (rangeStart !== null) {
        ranges.push({
          start: rangeStart,
          end: i - 1,
          humanLines: humanLines.slice(rangeStart, i),
        });
        rangeStart = null;
      }
    }
  }

  // Close trailing range
  if (rangeStart !== null) {
    ranges.push({
      start: rangeStart,
      end: resolvedLines.length - 1,
      humanLines: humanLines.slice(rangeStart),
    });
  }

  return ranges;
}
