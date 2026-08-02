import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import {
  acquireLock,
  dualviewCommit,
  getChangedFiles,
  initWorktree,
  releaseLock,
  stageFiles,
} from "./dualview-git.js";
import { allocateSymbol, hasSymbols, loadSymbolMap, resolveAllSymbols, type SymbolMap } from "./dualview-symbol-table.js";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface PolicyDirSyncResult {
  trustedPath: string;
  seededPaths: string[];
  trustedChanged: string[];
  mainChanged: string[];
}

interface PolicyDirSyncOptions {
  gitRoot: string;
  policyPaths: string[];
  basePath: string;
  dbPath?: string;
  log?: Logger;
  /**
   * In-memory symbol map to accumulate newly-allocated `policy_file` symbols
   * into. The DB is always updated; this parameter additionally writes to
   * an existing in-memory map (e.g. the plugin's `globalSymbols`) so the
   * `message_sending` resolver can de-symbolize tokens at output time
   * without an extra DB read. When omitted, a fresh map is loaded from the
   * DB and discarded after the call.
   */
  symbolMap?: SymbolMap;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeRelPath(gitRoot: string, basePath: string, policyPath: string): string | null {
  const normalizedPolicyPath = policyPath.endsWith("/*") || policyPath.endsWith("\\*")
    ? policyPath.slice(0, -2)
    : policyPath;
  const abs = isAbsolute(normalizedPolicyPath)
    ? normalizedPolicyPath
    : resolve(basePath, normalizedPolicyPath);
  if (!isInside(gitRoot, abs)) return null;
  const rel = relative(gitRoot, abs);
  if (
    !rel
    || rel.startsWith(".git" + sep) || rel === ".git"
  ) {
    return null;
  }
  return rel;
}

function collectFiles(root: string, relPath: string): string[] {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) return [];
  const stat = statSync(fullPath);
  if (stat.isFile()) return [relPath];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const entries = readdirSync(fullPath);
  for (const entry of entries) {
    if (entry === ".git") continue;
    files.push(...collectFiles(root, join(relPath, entry)));
  }
  return files;
}

function pathIsManaged(path: string, managedRoots: string[]): boolean {
  return managedRoots.some((root) => path === root || path.startsWith(root + sep));
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

/**
 * Seed explicit policy-untrusted DIR paths into the trusted worktree.
 *
 * This creates/updates trusted baseline commits only. It does not create an
 * [DUALVIEW-UNTRUSTED] twin because policy-path seeding is not importing external
 * tool output; it is establishing the current human/workspace state as the
 * trusted baseline before read-time provenance checks begin.
 */
export function syncPolicyDirPathsToWorktree({
  gitRoot,
  policyPaths,
  basePath,
  dbPath,
  log,
  symbolMap: externalSymbolMap,
}: PolicyDirSyncOptions): PolicyDirSyncResult {
  const trustedPath = initWorktree(gitRoot);
  const managedRoots = Array.from(new Set(
    policyPaths
      .map((p) => normalizeRelPath(gitRoot, basePath, p))
      .filter((p): p is string => p !== null),
  ));

  const result: PolicyDirSyncResult = {
    trustedPath,
    seededPaths: managedRoots,
    trustedChanged: [],
    mainChanged: [],
  };

  if (managedRoots.length === 0) return result;

  acquireLock(gitRoot);
  try {
    const managedFiles = new Set<string>();
    for (const relRoot of managedRoots) {
      const mainFiles = collectFiles(gitRoot, relRoot);
      const trustedFiles = collectFiles(trustedPath, relRoot);
      for (const file of mainFiles) managedFiles.add(file);
      for (const file of trustedFiles) managedFiles.add(file);
    }

    // When a caller-owned in-memory map is supplied (e.g. globalSymbols),
    // refresh it from the DB first so resolveAllSymbols sees prior entries
    // for the no-op-on-unchanged check, and so newly-allocated symbols
    // accumulate into the caller's map (allocateSymbol mutates whatever
    // map it's handed). Without this, two side-by-side maps drift apart
    // and outbound resolution at message_sending fails to find newly
    // seeded policy_file symbols.
    let symbolMap: SymbolMap;
    if (externalSymbolMap) {
      const fresh = loadSymbolMap(dbPath);
      for (const [name, entry] of fresh.symbols) {
        if (!externalSymbolMap.symbols.has(name)) {
          externalSymbolMap.symbols.set(name, entry);
        }
      }
      symbolMap = externalSymbolMap;
    } else {
      symbolMap = loadSymbolMap(dbPath);
    }
    for (const file of managedFiles) {
      const mainFile = join(gitRoot, file);
      const trustedFile = join(trustedPath, file);

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

    const trustedChanged = getChangedFiles(trustedPath)
      .map((f) => f.path)
      .filter((p) => pathIsManaged(p, managedRoots));
    if (trustedChanged.length > 0) {
      stageFiles(trustedPath, trustedChanged);
      dualviewCommit(trustedPath, {
        trusted: true,
        toolName: "policy_load",
        callId: "policy-load",
        runId: "startup",
        files: trustedChanged,
      });
      result.trustedChanged = trustedChanged;
    }

    const mainChanged = getChangedFiles(gitRoot)
      .map((f) => f.path)
      .filter((p) => pathIsManaged(p, managedRoots));
    if (mainChanged.length > 0) {
      stageFiles(gitRoot, mainChanged);
      dualviewCommit(gitRoot, {
        trusted: true,
        toolName: "policy_load",
        callId: "policy-load",
        runId: "startup",
        files: mainChanged,
      });
      result.mainChanged = mainChanged;
    }

    if (log) {
      log.info(
        `[DualView-policy-dir-sync] seeded ${managedRoots.length} policy path(s); ` +
        `trustedChanged=${result.trustedChanged.length} mainChanged=${result.mainChanged.length}`,
      );
    }
  } finally {
    releaseLock(gitRoot);
  }

  return result;
}
