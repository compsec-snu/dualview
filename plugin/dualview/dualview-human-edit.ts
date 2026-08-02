import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import {
  gitExecSync,
  getWorktreePath,
  acquireLock,
  releaseLock,
  writeConflictLog,
  ensureGitignoreExcludes,
  type ChangedFile,
  type ConflictLogEntry,
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
  type SymbolMap,
  type SymbolEntry,
} from "./dualview-symbol-table.js";

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
      }, dbPath);
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
    }, dbPath);
    pieces.push({ type: "symbol", symName: derivedSym });
  }

  // Obsolete the original
  obsoleteSymbol(symbolMap, symName, "human", dbPath);

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
}

interface ReconcileGitContext {
  humanPath: string;
  trustedPath: string;
  humanGit: GitExecOpts;
  trustedGit: GitExecOpts;
  acquire: () => void;
  release: () => void;
  writeConflict: (entry: ConflictLogEntry) => void;
}

const ONDEMAND_LOCK_STALE_MS = 30_000;

function getChangedFilesFor(opts: GitExecOpts): ChangedFile[] {
  const { stdout } = gitExecSync(["status", "--porcelain"], opts);
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line[2] === " " ? line.slice(3) : line.slice(2),
    }));
}

function stageFilesFor(opts: GitExecOpts, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  gitExecSync(["add", "--", ...filePaths], opts);
}

function dualviewHumanCommitFor(
  opts: GitExecOpts,
  { files, promotedSymbols }: { files: string[]; promotedSymbols: string[] },
): void {
  const filesList = files.join(",");
  const promoted = promotedSymbols.length > 0 ? promotedSymbols.join(",") : "none";
  const msg = `[DUALVIEW-HUMAN] dualview: source=human files=${filesList} promoted=${promoted}`;
  const { stderr } = gitExecSync(["commit", "-m", msg, "--allow-empty"], opts);
  if (stderr && (stderr.includes("fatal:") || stderr.includes("error:"))) {
    throw new Error(`git commit failed: ${stderr.trim()}`);
  }
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
  const { dbPath, log, auditWrite } = opts;
  const git = buildGitContext(opts);

  // 1. Detect uncommitted changes in human-view
  const changed = getChangedFilesFor(git.humanGit);
  if (changed.length === 0) return null;

  if (!existsSync(git.trustedPath)) return null;

  if (log) log.info(`[DualView-human-edit] Detected ${changed.length} uncommitted change(s) in human-view`);

  git.acquire();
  try {
    const symbolMap = loadSymbolMap(dbPath);
    const reconciledFiles: string[] = [];
    const allPromoted: string[] = [];
    // Pre-reconcile hashes of the human-view file contents (issue #213 R1).
    // A concurrent human save between read and commit would invalidate the
    // reconcile we computed against the pre-save content; before staging we
    // re-hash and drop any file whose disk content has since changed.
    const preHashes = new Map<string, string | null>();

    for (const file of changed) {
      // Only process modified files (not deleted/untracked without content)
      if (file.status === "D") {
        // Deletion: remove from trusted worktree too
        const trustedFile = join(git.trustedPath, file.path);
        if (existsSync(trustedFile)) {
          gitExecSync(["rm", "-f", "--", file.path], git.trustedGit);
          reconciledFiles.push(file.path);
          preHashes.set(file.path, null); // expected absent after commit
        }
        continue;
      }

      const humanFilePath = join(git.humanPath, file.path);
      const trustedFilePath = join(git.trustedPath, file.path);

      if (!existsSync(humanFilePath)) continue;
      if (statSync(humanFilePath).isDirectory()) continue;

      // Capture the human-view content *now*, use this buffer for every
      // downstream decision, and key the post-commit hash recheck off it.
      const humanContent = readFileSync(humanFilePath);
      const preHash = hashBuffer(humanContent);

      // For new files (status ??, A): copy to trusted worktree as-is
      if (file.status === "??" || file.status === "A") {
        const parentDir = dirname(trustedFilePath);
        if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
        writeFileSync(trustedFilePath, humanContent);
        reconciledFiles.push(file.path);
        preHashes.set(file.path, preHash);
        continue;
      }

      // Modified file: check if trusted worktree version has symbols
      if (!existsSync(trustedFilePath)) {
        // File exists in human-view but not trusted — copy as-is
        const parentDir = dirname(trustedFilePath);
        if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
        writeFileSync(trustedFilePath, humanContent);
        reconciledFiles.push(file.path);
        preHashes.set(file.path, preHash);
        continue;
      }

      // Skip binary files
      if (humanContent.subarray(0, 8192).includes(0)) continue;

      const trustedContent = readFileSync(trustedFilePath, "utf8");

      // If trusted file has no symbols, simple case: just copy
      if (!hasSymbols(trustedContent)) {
        writeFileSync(trustedFilePath, humanContent);
        reconciledFiles.push(file.path);
        preHashes.set(file.path, preHash);
        continue;
      }

      // Build line map and reconcile
      const humanText = humanContent.toString("utf8");
      const promoted = reconcileFile(
        trustedContent,
        humanText,
        trustedFilePath,
        symbolMap,
        dbPath,
        log,
      );

      allPromoted.push(...promoted);
      reconciledFiles.push(file.path);
      preHashes.set(file.path, preHash);
    }

    // Race guard (issue #213 R1): the lock serialises DualView processes but not
    // the human's editor. Between the initial read and the commit below, the
    // human could have saved again; that new content would be staged under
    // a commit whose reconcile logic never saw it. Re-hash every file we're
    // about to stage and drop any whose on-disk content has shifted.
    const safeFiles: string[] = [];
    for (const path of reconciledFiles) {
      const expected = preHashes.get(path) ?? null;
      const onDisk = existsSync(join(git.humanPath, path))
        ? hashBuffer(readFileSync(join(git.humanPath, path)))
        : null;
      if (expected === onDisk) {
        safeFiles.push(path);
        continue;
      }
      git.writeConflict({
        race: "R1",
        source: "reconcileHumanEdits",
        target: path,
        reason: "human-view content changed during reconcile window",
        extra: { expectedHash: expected, observedHash: onDisk },
      });
      if (log) {
        log.warn(
          `[DualView-human-edit] R1 race: dropping ${path} (pre=${expected ?? "absent"} post=${onDisk ?? "absent"})`,
        );
      }
    }

    if (safeFiles.length === 0) {
      return null;
    }

    // Commit human-view as [DUALVIEW-HUMAN]
    stageFilesFor(git.humanGit, safeFiles);
    dualviewHumanCommitFor(git.humanGit, {
      files: safeFiles,
      promotedSymbols: allPromoted,
    });

    // Commit trusted worktree
    const trustedChanged = getChangedFilesFor(git.trustedGit);
    if (trustedChanged.length > 0) {
      stageFilesFor(git.trustedGit, trustedChanged.map((f) => f.path));
      dualviewHumanCommitFor(git.trustedGit, {
        files: safeFiles,
        promotedSymbols: allPromoted,
      });
    }

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
  trustedFilePath: string,
  symbolMap: SymbolMap,
  dbPath?: string,
  log?: Logger,
): string[] {
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
      obsoleteSymbol(symbolMap, symName, "human", dbPath);
      promoted.push(symName);
      if (log) log.info(`[DualView-human-edit] Full promotion: ${symName}`);
      continue;
    }

    // Partial edit: split the symbol
    const pieces = splitSymbol(symbolMap, symName, editRanges, dbPath);
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

  // Write the updated trusted file
  writeFileSync(trustedFilePath, newTrustedLines.join("\n"));

  return promoted;
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
