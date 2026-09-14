import { execFile, execFileSync } from "child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import {
  dualviewAgentViewPathFor,
  dualviewWorkspaceDirFor,
  dualviewWorkspaceMetadataFor,
} from "./dualview-paths.js";

// ─────────────────────────────────────────────────────────────────────────────
// Git operation wrappers for DualView file tracking
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangedFile {
  status: string;
  path: string;
}

export interface DualViewCommitOpts {
  trusted: boolean;
  toolName: string;
  callId?: string;
  runId?: string;
  files?: string[];
}

export interface ParsedDualViewCommit {
  trusted: boolean;
  toolName: string;
  callId: string;
  runId: string;
  /** True if this is a human-edit commit ([DUALVIEW-HUMAN]). */
  human?: boolean;
  /** Symbols promoted (obsoleted) by this human edit. */
  promotedSymbols?: string[];
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitExecSyncResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitExecOpts {
  cwd: string;
  env?: Record<string, string>;
}

export interface GitFileSnapshot {
  path: string;
  content: Buffer | null;
  mode?: "100644" | "100755" | "120000";
}

export interface GitIndexEntrySnapshot {
  path: string;
  entries: Buffer;
  flags: string[];
}

const GIT_SNAPSHOT_MAX_BUFFER = 1024 * 1024 * 1024;

function isMissingPathError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export function readFilesystemSnapshot(
  targetPath: string,
  filePath: string,
): GitFileSnapshot {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(targetPath);
  } catch (err) {
    if (isMissingPathError(err)) return { path: filePath, content: null };
    throw err;
  }

  if (stat.isDirectory()) {
    throw new Error(`cannot snapshot directory: ${targetPath}`);
  }
  if (stat.isSymbolicLink()) {
    return {
      path: filePath,
      content: Buffer.from(readlinkSync(targetPath)),
      mode: "120000",
    };
  }
  return {
    path: filePath,
    content: readFileSync(targetPath),
    mode: stat.mode & 0o111 ? "100755" : "100644",
  };
}

export function readWorktreeSnapshot(
  rootPath: string,
  filePath: string,
): GitFileSnapshot {
  return readFilesystemSnapshot(join(rootPath, filePath), filePath);
}

export function writeFilesystemSnapshot(
  targetPath: string,
  snapshot: GitFileSnapshot,
): void {
  rmSync(targetPath, { recursive: true, force: true });
  if (snapshot.content === null) return;

  const parentDir = dirname(targetPath);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  if (snapshot.mode === "120000") {
    symlinkSync(snapshot.content.toString(), targetPath);
    return;
  }

  const mode = snapshot.mode === "100755" ? 0o755 : 0o644;
  writeFileSync(targetPath, snapshot.content, { mode });
  chmodSync(targetPath, mode);
}

export function fileSnapshotsEqual(
  left: GitFileSnapshot,
  right: GitFileSnapshot,
): boolean {
  if (left.content === null || right.content === null) {
    return left.content === right.content;
  }
  return left.mode === right.mode && left.content.equals(right.content);
}

/**
 * Run a git command asynchronously.
 */
export function gitExec(args: string[], { cwd, env }: GitExecOpts = { cwd: "." }): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: (err as NodeJS.ErrnoException)?.code as unknown as number ?? 0 });
    });
  });
}

/**
 * Run a git command synchronously.
 */
export function gitExecSync(args: string[], { cwd, env }: GitExecOpts = { cwd: "." }): GitExecSyncResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: stdout ?? "", stderr: "", code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
    };
    return {
      stdout: Buffer.isBuffer(e.stdout) ? e.stdout.toString() : e.stdout ?? "",
      stderr: Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr ?? "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

export function gitExecSyncOrThrow(
  args: string[],
  opts: GitExecOpts,
  action = `git ${args[0] ?? "command"}`,
): GitExecSyncResult {
  const result = gitExecSync(args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${action} failed: ${detail}`);
  }
  return result;
}

export function withTemporaryGitIndex<T>(
  opts: GitExecOpts,
  treeish: string,
  action: (temporaryOpts: GitExecOpts) => T,
): T {
  const tempDir = mkdtempSync(join(os.tmpdir(), "dualview-index-"));
  const temporaryOpts: GitExecOpts = {
    cwd: opts.cwd,
    env: {
      ...opts.env,
      GIT_INDEX_FILE: join(tempDir, "index"),
    },
  };
  try {
    gitExecSyncOrThrow(
      ["read-tree", treeish],
      temporaryOpts,
      "initializing temporary Git index",
    );
    return action(temporaryOpts);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function withLockedGitIndex<T>(
  opts: GitExecOpts,
  action: (lockedIndexOpts: GitExecOpts) => T,
): T {
  const rawIndexPath = gitExecSyncOrThrow(
    ["rev-parse", "--git-path", "index"],
    opts,
    "locating Git index",
  ).stdout.trim();
  const indexPath = isAbsolute(rawIndexPath)
    ? rawIndexPath
    : resolve(opts.cwd, rawIndexPath);
  const lockPath = `${indexPath}.lock`;
  const tempDir = mkdtempSync(join(os.tmpdir(), "dualview-locked-index-"));
  const tempIndexPath = join(tempDir, "index");
  let lockHeld = false;

  try {
    const lockFd = openSync(lockPath, "wx");
    closeSync(lockFd);
    lockHeld = true;
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, tempIndexPath);
    } else {
      gitExecSyncOrThrow(
        ["read-tree", "HEAD"],
        {
          cwd: opts.cwd,
          env: { ...opts.env, GIT_INDEX_FILE: tempIndexPath },
        },
        "initializing locked Git index",
      );
    }

    const lockedIndexOpts: GitExecOpts = {
      cwd: opts.cwd,
      env: {
        ...opts.env,
        GIT_INDEX_FILE: tempIndexPath,
      },
    };
    const result = action(lockedIndexOpts);
    copyFileSync(tempIndexPath, lockPath);
    renameSync(lockPath, indexPath);
    lockHeld = false;
    return result;
  } finally {
    if (lockHeld) rmSync(lockPath, { force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function readGitIndexSnapshot(
  filePath: string,
  { cwd, env }: GitExecOpts,
): GitFileSnapshot {
  const childEnv = { ...process.env, ...env };
  const modeOutput = execFileSync("git", ["ls-files", "-s", "--", filePath], {
    cwd,
    env: childEnv,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!modeOutput) return { path: filePath, content: null };

  const mode = modeOutput.slice(0, 6);
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`unsupported Git mode ${mode} for ${filePath}`);
  }

  const objectSpec = `:${filePath}`;
  const content = execFileSync(
    "git",
    mode === "120000"
      ? ["show", objectSpec]
      : ["cat-file", "--filters", `--path=${filePath}`, objectSpec],
    {
      cwd,
      env: childEnv,
      maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { path: filePath, content, mode };
}

export function readGitIndexEntrySnapshot(
  filePath: string,
  { cwd, env }: GitExecOpts,
): GitIndexEntrySnapshot {
  const childEnv = { ...process.env, ...env };
  const entries = execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "ls-files",
      "--stage",
      "--no-abbrev",
      "-z",
      "--",
      filePath,
    ],
    {
      cwd,
      env: childEnv,
      maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const debugOutput = execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "ls-files",
      "--debug",
      "--format=",
      "--",
      filePath,
    ],
    {
      cwd,
      env: childEnv,
      maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const flags = [...debugOutput.matchAll(/\tflags: ([0-9a-f]+)$/gim)]
    .map((match) => match[1]);
  const entryCount = entries.reduce(
    (count, byte) => count + (byte === 0 ? 1 : 0),
    0,
  );
  if (flags.length !== entryCount) {
    throw new Error(`unable to read complete Git index metadata for ${filePath}`);
  }
  return { path: filePath, entries, flags };
}

export function gitIndexEntrySnapshotsEqual(
  left: GitIndexEntrySnapshot,
  right: GitIndexEntrySnapshot,
): boolean {
  return left.path === right.path
    && left.entries.equals(right.entries)
    && left.flags.length === right.flags.length
    && left.flags.every((flag, index) => flag === right.flags[index]);
}

export function stageFileSnapshots(
  snapshots: readonly GitFileSnapshot[],
  { cwd, env }: GitExecOpts,
): void {
  for (const snapshot of snapshots) {
    if (snapshot.content === null) {
      gitExecSyncOrThrow(
        ["update-index", "--force-remove", "--", snapshot.path],
        { cwd, env },
        `staging deletion for ${snapshot.path}`,
      );
      continue;
    }

    const hashArgs = ["hash-object", "-w"];
    if (snapshot.mode !== "120000") hashArgs.push(`--path=${snapshot.path}`);
    hashArgs.push("--stdin");
    const hash = execFileSync("git", hashArgs, {
      cwd,
      env: { ...process.env, ...env },
      input: snapshot.content,
      maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
      encoding: "utf8",
    }).trim();
    gitExecSyncOrThrow(
      ["update-index", "--add", "--cacheinfo", snapshot.mode ?? "100644", hash, snapshot.path],
      { cwd, env },
      `staging ${snapshot.path}`,
    );
  }
}

/**
 * Discover the git root from a starting directory.
 */
export function findGitRoot(startDir: string): string {
  const { stdout } = gitExecSync(["rev-parse", "--show-toplevel"], { cwd: startDir });
  const root = stdout.trim();
  if (!root) throw new Error(`Not a git repository: ${startDir}`);
  return root;
}

/**
 * Get changed files via git status --porcelain.
 */
export function getChangedFiles(gitRoot: string): ChangedFile[] {
  const { stdout } = gitExecSync(["status", "--porcelain"], { cwd: gitRoot });
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      // Standard porcelain: XY PATH (path at pos 3). Some worktree states
      // emit a single status char: X PATH (path at pos 2).
      path: line[2] === " " ? line.slice(3) : line.slice(2),
    }));
}

/**
 * Stage specific files.
 */
export function stageFiles(gitRoot: string, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  gitExecSync(["add", "--", ...filePaths], { cwd: gitRoot });
}

/**
 * Commit with DualView file tracking metadata.
 */
export function dualviewCommit(gitRoot: string, { trusted, toolName, callId, runId, files }: DualViewCommitOpts): void {
  const tag = trusted ? "[DUALVIEW-TRUSTED]" : "[DUALVIEW-UNTRUSTED]";
  const filesMeta = files && files.length > 0 ? ` files=${files.join(",")}` : "";
  const msg = `${tag} dualview: tool=${toolName || "unknown"} callId=${callId || "none"} run=${runId || "none"}${filesMeta}`;
  const flags = trusted ? [] : ["--no-verify"];
  const { stderr } = gitExecSync(["commit", "-m", msg, "--allow-empty", ...flags], { cwd: gitRoot });
  if (stderr && (stderr.includes("fatal:") || stderr.includes("error:"))) {
    throw new Error(`git commit failed: ${stderr.trim()}`);
  }
}

/**
 * Get the commit message for a given commit hash.
 */
export function getCommitMessage(gitRoot: string, commitHash: string): string {
  const { stdout } = gitExecSync(["log", "-1", "--format=%B", commitHash], { cwd: gitRoot });
  return stdout.trim();
}

/**
 * Parse an DualView file tracking commit message.
 * Recognizes [DUALVIEW-TRUSTED], [DUALVIEW-UNTRUSTED], and [DUALVIEW-HUMAN] commits.
 */
export function parseDualViewCommitMessage(message: string): ParsedDualViewCommit | null {
  // Standard agent commit: [DUALVIEW-TRUSTED] or [DUALVIEW-UNTRUSTED]
  const agentMatch = message.match(/^\[(DUALVIEW-TRUSTED|DUALVIEW-UNTRUSTED)\]\s+dualview:\s+tool=(\S+)\s+callId=(\S+)\s+run=(\S+)/);
  if (agentMatch) {
    return {
      trusted: agentMatch[1] === "DUALVIEW-TRUSTED",
      toolName: agentMatch[2],
      callId: agentMatch[3],
      runId: agentMatch[4],
    };
  }

  // Human edit commit: [DUALVIEW-HUMAN]
  const humanMatch = message.match(/^\[DUALVIEW-HUMAN\]\s+dualview:\s+source=human\s+files=(\S+)\s+promoted=(\S+)/);
  if (humanMatch) {
    const promoted = humanMatch[2] === "none" ? [] : humanMatch[2].split(",");
    return {
      trusted: true,
      human: true,
      toolName: "human",
      callId: "none",
      runId: "none",
      promotedSymbols: promoted,
    };
  }

  return null;
}

/**
 * Create a human-edit commit in the given worktree/repo.
 */
export function dualviewHumanCommit(
  gitRoot: string,
  { files, promotedSymbols }: { files: string[]; promotedSymbols: string[] },
): void {
  const filesList = files.join(",");
  const promoted = promotedSymbols.length > 0 ? promotedSymbols.join(",") : "none";
  const msg = `[DUALVIEW-HUMAN] dualview: source=human files=${filesList} promoted=${promoted}`;
  const { stderr } = gitExecSync(["commit", "-m", msg, "--allow-empty"], { cwd: gitRoot });
  if (stderr && (stderr.includes("fatal:") || stderr.includes("error:"))) {
    throw new Error(`git commit failed: ${stderr.trim()}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File lock for serializing concurrent git operations
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 30_000;

/**
 * Acquire a mkdir-based file lock.
 */
export function acquireLock(gitRoot: string): void {
  const dualviewDir = dualviewWorkspaceDirFor(gitRoot);
  const lockDir = join(dualviewDir, "commit.lock");
  if (!existsSync(dualviewDir)) mkdirSync(dualviewDir, { recursive: true });

  // Check staleness
  if (existsSync(lockDir)) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lockDir);
      }
    } catch {}
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("DualView commit lock is held by another process");
    }
    throw err;
  }
}

/**
 * Release the file lock.
 */
export function releaseLock(gitRoot: string): void {
  const lockDir = join(dualviewWorkspaceDirFor(gitRoot), "commit.lock");
  try {
    rmdirSync(lockDir);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Git worktree management for filesystem isolation (issue #10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the trusted worktree path for a git root.
 */
export function getWorktreePath(gitRoot: string): string {
  return dualviewAgentViewPathFor(gitRoot);
}

function getWorktreeAdminDir(wtPath: string): string | null {
  const gitEntry = join(wtPath, ".git");
  if (!existsSync(gitEntry)) return null;
  try {
    const raw = readFileSync(gitEntry, "utf8");
    const match = raw.match(/gitdir:\s*(.+)/i);
    if (!match?.[1]) return null;
    const gitdirRaw = match[1].trim();
    return gitdirRaw.startsWith("/") ? gitdirRaw : join(wtPath, gitdirRaw);
  } catch {
    return null;
  }
}

/**
 * Check if the trusted worktree is initialized and valid.
 * Validates both the .git marker file AND the gitdir target it points to.
 */
export function isWorktreeInitialized(gitRoot: string): boolean {
  const wtPath = getWorktreePath(gitRoot);
  try {
    if (!existsSync(wtPath)) return false;
    const gitEntry = join(wtPath, ".git");
    if (!existsSync(gitEntry)) return false;
    // A worktree .git is a file (not directory) containing a gitdir pointer
    const stat = statSync(gitEntry);
    if (!stat.isFile()) return false;
    // Validate the gitdir target actually exists (prevents stale worktree refs)
    const gitdir = getWorktreeAdminDir(wtPath);
    if (!gitdir) return false;
    return existsSync(join(gitdir, "HEAD"));
  } catch {
    return false;
  }
}

/**
 * Initialize the trusted worktree at the canonical DualView agentview path.
 * Creates an 'dualview-trusted' branch from current HEAD and adds it as a worktree.
 * Returns the worktree path.
 */
/**
 * Ensure git's info directory exists.
 *
 * Idempotent. The workspace can be re-initialized with a fresh `.git`
 * directory while the trusted worktree still exists. Hook handlers call this
 * defensively before any `git status`.
 */
export function ensureGitignoreExcludes(gitRoot: string): void {
  const infoDir = join(gitRoot, ".git", "info");
  try {
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
  } catch {
    // Best-effort. If we can't write this directory, downstream git commands
    // can still operate; conflict logs will capture any resulting skips.
  }
}

export function initWorktree(gitRoot: string): string {
  const wtPath = getWorktreePath(gitRoot);

  // Always run before the worktree-initialized early return because `.git/`
  // can be recreated while the worktree itself still exists.
  ensureGitignoreExcludes(gitRoot);

  if (isWorktreeInitialized(gitRoot)) return wtPath;

  const dualviewDir = dualviewWorkspaceDirFor(gitRoot);
  if (!existsSync(dualviewDir)) mkdirSync(dualviewDir, { recursive: true });
  writeFileSync(
    join(dualviewDir, "workspace.json"),
    JSON.stringify(dualviewWorkspaceMetadataFor(gitRoot), null, 2) + "\n",
  );

  // Create the dualview-trusted branch from current HEAD if it doesn't exist
  const { stdout: branchList } = gitExecSync(
    ["branch", "--list", "dualview-trusted"],
    { cwd: gitRoot },
  );
  if (!branchList.trim()) {
    const { stderr: branchErr } = gitExecSync(["branch", "dualview-trusted"], { cwd: gitRoot });
    if (branchErr && branchErr.includes("fatal:")) {
      throw new Error(`Failed to create dualview-trusted branch: ${branchErr.trim()}`);
    }
  }

  // Clean up stale worktree state if the .git marker exists but the admin dir is missing
  const staleGitFile = join(wtPath, ".git");
  if (existsSync(staleGitFile)) {
    if (isWorktreeInitialized(gitRoot)) {
      // A legacy worktree may have been moved into place. Continue below to
      // normalize relative gitdir pointers, then validate and return.
    } else {
      try {
        gitExecSync(["worktree", "remove", "--force", wtPath], { cwd: gitRoot });
      } catch {
        // Best-effort: manually remove the stale directory
        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      // Also prune any stale worktree refs in .git/worktrees/
      gitExecSync(["worktree", "prune"], { cwd: gitRoot });
    }
  }

  if (!existsSync(join(wtPath, ".git"))) {
    // Add worktree
    const { stderr: wtErr } = gitExecSync(["worktree", "add", wtPath, "dualview-trusted"], { cwd: gitRoot });
    if (wtErr && wtErr.includes("fatal:")) {
      throw new Error(`Failed to add worktree: ${wtErr.trim()}`);
    }
  }

  // Rewrite absolute gitdir paths to relative so the worktree works when
  // the workspace is accessed from a different mount point (e.g. host-side
  // access to a Docker container's bind-mounted state dir).
  const wtGitFile = join(wtPath, ".git");
  const adminDir = getWorktreeAdminDir(wtPath);
  const adminGitdir = adminDir ? join(adminDir, "gitdir") : null;
  if (existsSync(wtGitFile)) {
    if (!adminDir) {
      throw new Error(`Worktree gitdir missing for ${wtPath}`);
    }
    writeFileSync(wtGitFile, `gitdir: ${relative(wtPath, adminDir)}\n`);
  }
  if (adminGitdir && existsSync(adminGitdir)) {
    writeFileSync(adminGitdir, `${relative(adminDir!, wtGitFile)}\n`);
  }

  // Post-condition: verify the worktree was actually created
  if (!isWorktreeInitialized(gitRoot)) {
    throw new Error(`Worktree creation appeared to succeed but validation failed (${wtPath})`);
  }

  return wtPath;
}

/**
 * Create a new commit on the dualview-trusted branch with the same tree as HEAD (the
 * latest [DUALVIEW-TRUSTED] commit on master), but parented to the previous dualview-trusted
 * commit.  This keeps the dualview-trusted history free of [DUALVIEW-UNTRUSTED] ancestors.
 */
export function updateTrustedRef(gitRoot: string): void {
  // Tree of HEAD (the TRUSTED commit just made on master)
  const { stdout: treeOut } = gitExecSync(["rev-parse", "HEAD^{tree}"], { cwd: gitRoot });
  const tree = treeOut.trim();

  // Commit message of the TRUSTED commit (reuse for the trusted-branch copy)
  const { stdout: msgOut } = gitExecSync(["log", "-1", "--format=%B"], { cwd: gitRoot });
  const msg = msgOut.trim();

  // Create a new commit on dualview-trusted with the same tree, parented to dualview-trusted
  const { stdout: commitOut } = gitExecSync(
    ["commit-tree", tree, "-p", "dualview-trusted", "-m", msg],
    { cwd: gitRoot },
  );
  const newCommit = commitOut.trim();
  if (!newCommit) {
    throw new Error("git commit-tree returned empty hash");
  }

  gitExecSync(["update-ref", "refs/heads/dualview-trusted", newCommit], { cwd: gitRoot });
}

/**
 * Reset the trusted worktree to the dualview-trusted ref.
 * Called after both commits are done so the worktree sits at the symbolized state.
 */
export function resetTrustedWorktree(gitRoot: string): void {
  const wtPath = getWorktreePath(gitRoot);
  gitExecSync(["reset", "--hard", "dualview-trusted"], { cwd: wtPath });
}

/**
 * Remove the trusted worktree.
 * Uses manual cleanup instead of `git worktree remove` because we rewrite
 * gitdir pointers to relative paths (for cross-mount portability), and some
 * git versions can't resolve relative gitdir in `worktree remove`.
 */
export function removeWorktree(gitRoot: string): void {
  if (!isWorktreeInitialized(gitRoot)) return;
  const wtPath = getWorktreePath(gitRoot);
  const adminDir = getWorktreeAdminDir(wtPath);
  try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best effort */ }
  if (adminDir) {
    try { rmSync(adminDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  gitExecSync(["worktree", "prune"], { cwd: gitRoot });
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict log (issue #213 DualFS race detection)
//
// When a filesystem race is detected (human write during sync window, dirty
// main worktree at copy time, etc.), we append a JSONL entry to the
// per-DualView-workspace log at conflicts.log so the human can inspect what was
// skipped and why. This is intentionally append-only and best-effort; log
// write failures do not block the host handler.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConflictLogEntry {
  /** Race identifier: R1 human→agent, R2 agent→human, R3 symbol alloc. */
  race: "R1" | "R2" | "R3";
  /** Hook or handler name that detected the race. */
  source: string;
  /** Affected file path (relative to gitRoot) or symbol name. */
  target: string;
  /** Short human-readable reason describing the skipped action. */
  reason: string;
  /** Optional extra fields (hashes, tool name, call id, etc.). */
  extra?: Record<string, unknown>;
}

/**
 * Append a race-detection event to DualView `conflicts.log` as JSONL.
 * Best-effort: write errors are swallowed so the caller can keep going.
 */
export function writeConflictLog(gitRoot: string, entry: ConflictLogEntry): void {
  try {
    const dualviewDir = dualviewWorkspaceDirFor(gitRoot);
    if (!existsSync(dualviewDir)) mkdirSync(dualviewDir, { recursive: true });
    const logPath = join(dualviewDir, "conflicts.log");
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    appendFileSync(logPath, record + "\n");
  } catch {
    // Swallow — conflict logging must never wedge the caller.
  }
}

/**
 * Rewrite a file path from the main worktree to the trusted worktree.
 * Returns null if the path is not within the git root.
 * Returns the path unchanged if already in the trusted worktree.
 */
export function rewriteToWorktree(gitRoot: string, filePath: string): string | null {
  const wtPath = getWorktreePath(gitRoot);
  const resolvedPath = filePath.startsWith("~/")
    ? join(os.homedir(), filePath.slice(2))
    : filePath;

  // Already in trusted worktree
  if (resolvedPath.startsWith(wtPath + "/") || resolvedPath === wtPath) return resolvedPath;

  // Must be within gitRoot (trailing slash prevents partial prefix matches)
  if (!resolvedPath.startsWith(gitRoot + "/") && resolvedPath !== gitRoot) return null;

  // Rewrite: replace gitRoot prefix with wtPath
  return wtPath + resolvedPath.slice(gitRoot.length);
}
