import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { gitExecSync } from "./dualview-git.js";
import {
  dualviewGitOpts,
  resolveTrackingRoot,
  type TrackedRoot,
} from "./dualview-ondemand.js";
import { allocateSymbol, hasSymbols, loadSymbolMap, resolveAllSymbols, type SymbolMap } from "./dualview-symbol-table.js";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface OnDemandPolicyDirSyncRootResult {
  workTree: string;
  trustedPath: string;
  policyPaths: string[];
  managedPaths: string[];
  trustedChanged: string[];
  mainChanged: string[];
}

export interface OnDemandPolicyDirSyncResult {
  seededPaths: string[];
  trustedChanged: string[];
  mainChanged: string[];
  roots: OnDemandPolicyDirSyncRootResult[];
}

interface OnDemandPolicyDirSyncOptions {
  policyPaths: string[];
  basePath: string;
  dbPath?: string;
  log?: Logger;
  /**
   * Optional caller-owned in-memory symbol map. Newly allocated policy_file
   * symbols are written to the DB and to this map so outbound resolution can
   * de-symbolize policy-seeded tokens without an extra reload.
   */
  symbolMap?: SymbolMap;
}

interface ManagedPolicyPath {
  root: TrackedRoot;
  absPath: string;
  managedRel: string;
}

interface RootGroup {
  root: TrackedRoot;
  policyPaths: Set<string>;
  managedPaths: Set<string>;
}

interface ChangedFile {
  status: string;
  path: string;
}

const LOCK_STALE_MS = 30_000;

function isMetadataPath(path: string): boolean {
  const parts = path.split(sep).filter(Boolean);
  return parts.includes(".git");
}

function collectFiles(root: string, relPath: string): string[] {
  const fullPath = relPath ? join(root, relPath) : root;
  if (!existsSync(fullPath)) return [];
  const stat = statSync(fullPath);
  if (stat.isFile()) return [relPath];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const entries = readdirSync(fullPath);
  for (const entry of entries) {
    if (entry === ".git") continue;
    const childRel = relPath ? join(relPath, entry) : entry;
    files.push(...collectFiles(root, childRel));
  }
  return files;
}

function pathIsManaged(path: string, managedRoots: string[]): boolean {
  return managedRoots.some((root) => {
    if (root === "") return true;
    return path === root || path.startsWith(root + sep);
  });
}

function symbolFieldForFile(file: string): string {
  return file.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "content";
}

function policyFileSymbolValue(file: string, content: Buffer): string {
  const sample = content.subarray(0, 8192);
  if (!sample.includes(0)) return content.toString("utf8");

  const sha256 = createHash("sha256").update(content).digest("hex");
  return `[binary policy file: ${file}; bytes=${content.length}; sha256=${sha256}]`;
}

function getChangedFilesOd(root: TrackedRoot, worktree: string): ChangedFile[] {
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

function commitOd(root: TrackedRoot, worktree: string, files: string[]): void {
  const filesMeta = files.length > 0 ? ` files=${files.join(",")}` : "";
  const msg = `[DUALVIEW-TRUSTED] dualview: tool=policy_load callId=policy-load run=startup${filesMeta}`;
  const { stderr } = gitExecSync(["commit", "-m", msg, "--allow-empty"], dualviewGitOpts(root, worktree));
  if (stderr && (stderr.includes("fatal:") || stderr.includes("error:"))) {
    throw new Error(`git commit failed: ${stderr.trim()}`);
  }
}

function acquireLockOd(root: TrackedRoot): void {
  const shadowDir = dirname(root.gitDir);
  const lockDir = join(shadowDir, "policy-sync.lock");
  if (!existsSync(shadowDir)) mkdirSync(shadowDir, { recursive: true });

  if (existsSync(lockDir)) {
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) rmdirSync(lockDir);
    } catch { /* ignore */ }
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`[DualView-policy-dir-sync-od] lock held by another process: ${lockDir}`);
    }
    throw err;
  }
}

function releaseLockOd(root: TrackedRoot): void {
  const lockDir = join(dirname(root.gitDir), "policy-sync.lock");
  try { rmdirSync(lockDir); } catch { /* ignore */ }
}

function preparePolicyPath(policyPath: string, basePath: string): ManagedPolicyPath | null {
  const normalizedPolicyPath = policyPath.endsWith("/*") || policyPath.endsWith("\\*")
    ? policyPath.slice(0, -2)
    : policyPath;
  const absPath = isAbsolute(normalizedPolicyPath)
    ? resolve(normalizedPolicyPath)
    : resolve(basePath, normalizedPolicyPath);
  if (isMetadataPath(absPath)) return null;
  if (!existsSync(absPath)) return null;

  const stat = statSync(absPath);
  if (!stat.isFile() && !stat.isDirectory()) return null;

  const seedPath = stat.isDirectory() ? join(absPath, ".dualview-policy-seed") : absPath;
  const root = resolveTrackingRoot(seedPath, { allowTemporary: true });
  if (!root) return null;

  const managedRel = relative(root.workTree, absPath);
  if (managedRel.startsWith("..") || isAbsolute(managedRel) || isMetadataPath(managedRel)) return null;

  return { root, absPath, managedRel };
}

function loadCallerAwareSymbolMap(externalSymbolMap: SymbolMap | undefined, dbPath: string | undefined): SymbolMap {
  if (!externalSymbolMap) return loadSymbolMap(dbPath);

  const fresh = loadSymbolMap(dbPath);
  for (const [name, entry] of fresh.symbols) {
    if (!externalSymbolMap.symbols.has(name)) {
      externalSymbolMap.symbols.set(name, entry);
    }
  }
  return externalSymbolMap;
}

function syncRoot({
  root,
  policyPaths,
  managedPaths,
  dbPath,
  log,
  symbolMap: externalSymbolMap,
}: {
  root: TrackedRoot;
  policyPaths: string[];
  managedPaths: string[];
  dbPath?: string;
  log?: Logger;
  symbolMap?: SymbolMap;
}): OnDemandPolicyDirSyncRootResult {
  const result: OnDemandPolicyDirSyncRootResult = {
    workTree: root.workTree,
    trustedPath: root.trustedPath,
    policyPaths,
    managedPaths,
    trustedChanged: [],
    mainChanged: [],
  };

  acquireLockOd(root);
  try {
    const managedFiles = new Set<string>();
    for (const relRoot of managedPaths) {
      const mainFiles = collectFiles(root.workTree, relRoot);
      const trustedFiles = collectFiles(root.trustedPath, relRoot);
      for (const file of mainFiles) managedFiles.add(file);
      for (const file of trustedFiles) managedFiles.add(file);
    }

    const symbolMap = loadCallerAwareSymbolMap(externalSymbolMap, dbPath);
    for (const file of managedFiles) {
      const mainFile = join(root.workTree, file);
      const trustedFile = join(root.trustedPath, file);

      if (!existsSync(mainFile)) {
        rmSync(trustedFile, { force: true });
        continue;
      }

      const parent = dirname(trustedFile);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

      const content = readFileSync(mainFile);
      const text = policyFileSymbolValue(file, content);
      let shouldRegisterAsUntrusted = true;
      if (existsSync(trustedFile)) {
        const trustedText = readFileSync(trustedFile, "utf8");
        if (hasSymbols(trustedText)) {
          shouldRegisterAsUntrusted = resolveAllSymbols(trustedText, symbolMap) !== text;
        }
      }

      if (shouldRegisterAsUntrusted) {
        const sym = allocateSymbol(symbolMap, {
          tool: "policy_file",
          field: symbolFieldForFile(file),
          value: text,
          origin: `file:${file}`,
          callId: "policy-load",
        }, dbPath);
        writeFileSync(trustedFile, sym);
      }
    }

    const trustedChanged = getChangedFilesOd(root, root.trustedPath)
      .map((f) => f.path)
      .filter((p) => pathIsManaged(p, managedPaths));
    if (trustedChanged.length > 0) {
      stageFilesOd(root, root.trustedPath, trustedChanged);
      commitOd(root, root.trustedPath, trustedChanged);
      result.trustedChanged = trustedChanged;
    }

    const mainChanged = getChangedFilesOd(root, root.workTree)
      .map((f) => f.path)
      .filter((p) => pathIsManaged(p, managedPaths));
    if (mainChanged.length > 0) {
      stageFilesOd(root, root.workTree, mainChanged);
      commitOd(root, root.workTree, mainChanged);
      result.mainChanged = mainChanged;
    }
  } finally {
    releaseLockOd(root);
  }

  return result;
}

/**
 * Seed explicit policy-untrusted DIR paths into on-demand trusted worktrees.
 *
 * Real worktree files keep their raw bytes. The trusted on-demand view stores
 * text files as policy_file symbols so later reads return symbols instead of
 * raw untrusted content.
 */
export function syncPolicyDirPathsToOnDemand({
  policyPaths,
  basePath,
  dbPath,
  log,
  symbolMap,
}: OnDemandPolicyDirSyncOptions): OnDemandPolicyDirSyncResult {
  const prepared = policyPaths
    .map((p) => ({ original: p, abs: isAbsolute(p) ? resolve(p) : resolve(basePath, p) }))
    .sort((a, b) => a.abs.length - b.abs.length)
    .map(({ original }) => preparePolicyPath(original, basePath))
    .filter((p): p is ManagedPolicyPath => p !== null);

  const groups = new Map<string, RootGroup>();
  for (const item of prepared) {
    let group = groups.get(item.root.workTree);
    if (!group) {
      group = {
        root: item.root,
        policyPaths: new Set(),
        managedPaths: new Set(),
      };
      groups.set(item.root.workTree, group);
    }
    group.policyPaths.add(item.absPath);
    group.managedPaths.add(item.managedRel);
  }

  const result: OnDemandPolicyDirSyncResult = {
    seededPaths: [],
    trustedChanged: [],
    mainChanged: [],
    roots: [],
  };

  for (const group of groups.values()) {
    const rootResult = syncRoot({
      root: group.root,
      policyPaths: [...group.policyPaths],
      managedPaths: [...group.managedPaths],
      dbPath,
      log,
      symbolMap,
    });
    result.roots.push(rootResult);
    result.seededPaths.push(...rootResult.policyPaths);
    result.trustedChanged.push(...rootResult.trustedChanged);
    result.mainChanged.push(...rootResult.mainChanged);
  }

  if (log) {
    log.info(
      `[DualView-policy-dir-sync-od] seeded ${result.seededPaths.length} policy path(s); ` +
      `trustedChanged=${result.trustedChanged.length} mainChanged=${result.mainChanged.length}`,
    );
  }

  return result;
}
