/**
 * On-demand non-nested DualView git tracking with shadow directory storage.
 *
 * All canonical DualView state lives under:
 *
 *   ~/.dualview/workspaces/<encodeURIComponent(canonical-workspace-path)>/
 *     repo.git/
 *     agentview/
 *     workspace.json
 *
 * New runs create no workspace-local file-tracking state.
 *
 * See docs/design/on-demand-tracking.md for the full design.
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import {
  canonicalWorkspacePath,
  dualviewAgentViewPathFor,
  dualviewGitDirFor,
  dualviewWorkspaceDirFor,
  dualviewWorkspaceMetadataFor,
  dualviewWorkspacesBase,
  workspaceIdFor,
} from "./dualview-paths.js";
import { gitExecSync } from "./dualview-git.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackedRoot {
  /** Canonical absolute path of the tracked directory */
  workTree: string;
  /** Path to DualView's bare git database (~/.dualview/workspaces/<id>/repo.git) */
  gitDir: string;
  /** Path to the Agent File System (~/.dualview/workspaces/<id>/agentview) */
  trustedPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const trackedRoots = new Map<string, TrackedRoot>();

/** Get all currently registered tracking roots. */
export function getTrackedRoots(): Map<string, TrackedRoot> {
  return trackedRoots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow path helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deprecated compatibility alias for the canonical DualView workspace dir.
 *
 * New callers should prefer dualviewWorkspaceDirFor().
 */
export function trackingDirFor(workTree: string): string {
  return dualviewWorkspaceDirFor(workTree);
}

export function gitDirFor(workTree: string): string {
  return dualviewGitDirFor(workTree);
}

/** Deprecated compatibility alias for the canonical Agent File System path. */
export function trustedPathFor(workTree: string): string {
  return dualviewAgentViewPathFor(workTree);
}

export {
  workspaceIdFor,
  dualviewWorkspaceDirFor,
  dualviewGitDirFor,
  dualviewAgentViewPathFor,
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the tracking root that contains the given absolute path.
 * Walks upward from the path checking each ancestor against the registry.
 */
export function findContainingRoot(absPath: string): TrackedRoot | null {
  let candidate = absPath;
  while (candidate !== "/" && candidate !== ".") {
    if (trackedRoots.has(candidate)) return trackedRoots.get(candidate)!;
    candidate = dirname(candidate);
  }
  if (trackedRoots.has("/")) return trackedRoots.get("/")!;
  return null;
}

/**
 * Find all registered tracking roots that are children of the given directory.
 */
export function findChildRoots(dirPath: string): TrackedRoot[] {
  const results: TrackedRoot[] = [];
  const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
  for (const [workTree, root] of trackedRoots) {
    if (workTree.startsWith(prefix)) results.push(root);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize on-demand tracking for a directory.
 * Creates the shadow directory structure and a bare git repo with a trusted worktree.
 */
export function initTracking(workTree: string): TrackedRoot {
  const canonical = canonicalWorkspacePath(workTree);
  const shadowDir = dualviewWorkspaceDirFor(canonical);
  const gitDir = dualviewGitDirFor(canonical);
  const trustedPath = dualviewAgentViewPathFor(canonical);

  mkdirSync(shadowDir, { recursive: true });

  if (!existsSync(canonical)) {
    mkdirSync(canonical, { recursive: true });
  }
  writeFileSync(
    join(shadowDir, "workspace.json"),
    JSON.stringify(dualviewWorkspaceMetadataFor(canonical), null, 2) + "\n",
  );

  // Init bare git repo, then unset core.bare so core.worktree works
  gitExecSync(["init", "--bare", gitDir], { cwd: canonical });
  gitExecSync(["config", "--unset", "core.bare"], {
    cwd: canonical,
    env: { GIT_DIR: gitDir },
  });

  // Configure work tree
  gitExecSync(["config", "core.worktree", canonical], {
    cwd: canonical,
    env: { GIT_DIR: gitDir },
  });
  gitExecSync(["config", "user.email", "dualview@agent"], {
    cwd: canonical,
    env: { GIT_DIR: gitDir },
  });
  gitExecSync(["config", "user.name", "DualView Agent"], {
    cwd: canonical,
    env: { GIT_DIR: gitDir },
  });

  // Initial empty commit. This keeps the shadow repo born clean without
  // creating a .gitkeep file in the user's work tree, which otherwise causes
  // dirty-state warnings or merge collisions during root migration.
  gitExecSync(["commit", "--allow-empty", "-m", "init (DualView on-demand tracking)"], {
    cwd: canonical,
    env: { GIT_DIR: gitDir },
  });

  // Create dualview-trusted branch
  gitExecSync(["branch", "dualview-trusted"], { cwd: canonical, env: { GIT_DIR: gitDir } });

  // Add trusted worktree
  // Note: gitExecSync spreads process.env, so GIT_WORK_TREE may leak from
  // the parent. We override it to the canonical path to avoid conflicts.
  gitExecSync(["worktree", "add", trustedPath, "dualview-trusted"], {
    cwd: canonical,
    env: { GIT_DIR: gitDir, GIT_WORK_TREE: canonical },
  });

  const root: TrackedRoot = { workTree: canonical, gitDir, trustedPath };
  trackedRoots.set(canonical, root);
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// On-demand resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Directories where tracking should never be initialized. */
const ALWAYS_EXCLUDED_PREFIXES = ["/proc", "/sys", "/dev", "/run"];
const TEMPORARY_EXCLUDED_PREFIXES = ["/tmp"];

export interface ResolveTrackingRootOptions {
  /**
   * Allows explicitly configured temporary workspaces, e.g. policy-seeded
   * benchmark roots under /tmp. Pseudo/system filesystems stay excluded.
   */
  allowTemporary?: boolean;
}

function pathHasPrefix(absPath: string, prefix: string): boolean {
  return absPath.startsWith(prefix + "/") || absPath === prefix;
}

function isExcludedTrackingPath(absPath: string, options: ResolveTrackingRootOptions = {}): boolean {
  if (ALWAYS_EXCLUDED_PREFIXES.some((prefix) => pathHasPrefix(absPath, prefix))) return true;
  if (!options.allowTemporary && TEMPORARY_EXCLUDED_PREFIXES.some((prefix) => pathHasPrefix(absPath, prefix))) return true;
  return false;
}

/**
 * Resolve a tracking root for a file path, initializing on demand if needed.
 * Implements the non-nested algorithm from issue #98.
 *
 * Returns null if the path is in an excluded directory.
 */
export function resolveTrackingRoot(
  filePath: string,
  options: ResolveTrackingRootOptions = {},
): TrackedRoot | null {
  let absPath: string;
  try {
    absPath = filePath.startsWith("~/")
      ? join(homedir(), filePath.slice(2))
      : resolve(filePath);
  } catch {
    return null;
  }

  // Check exclusions
  if (isExcludedTrackingPath(absPath, options)) return null;

  // Step 1: Ancestry check — already tracked?
  const existing = findContainingRoot(absPath);
  if (existing) return existing;

  // Step 2: Parent identification
  const D = canonicalWorkspacePath(dirname(absPath));

  // Step 3: Child root check
  const children = findChildRoots(D);

  if (children.length === 0) {
    // Case A: no child roots — fresh init
    return initTracking(D);
  } else if (children.length === 1) {
    // Case B: one child root — migrate upward
    migrateRootUpward(children[0]!, D);
    return trackedRoots.get(D) ?? null;
  } else {
    // Case C: multiple child roots — merge
    mergeRootsInto(children, D);
    return trackedRoots.get(D) ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration (blame-preserving root promotion)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Migrate a tracking root from a child directory to a parent directory.
 * Rewrites git history so that file paths gain the appropriate prefix,
 * preserving line history across the migration.
 */
export function migrateRootUpward(child: TrackedRoot, newWorkTree: string): void {
  const canonical = canonicalWorkspacePath(newWorkTree);
  const prefix = child.workTree.slice(canonical.length + 1); // e.g., "react" or "projects/react"

  // Create new tracking entry
  const newRoot = initTracking(canonical);

  // Import child history into new root under the prefixed path. We use
  // `git subtree add` instead of the previous filter-branch tree rewrite
  // because the old rewrite often became a no-op (`tmp-migrate` unchanged),
  // which lost the child content in the promoted root's HEAD.
  const remoteName = `migrate-${Date.now()}`;
  gitExecSync(["remote", "add", remoteName, child.gitDir], {
    cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
  });
  gitExecSync(["fetch", remoteName], {
    cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
  });

  gitExecSync(["checkout", "master"], {
    cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
  });
  gitExecSync([
    "subtree", "add",
    `--prefix=${prefix}`,
    remoteName,
    "master",
    "-m",
    `[DualView-MIGRATE] root promoted: ${child.workTree} → ${canonical} (prefix: ${prefix})`,
  ], { cwd: canonical, env: { GIT_DIR: newRoot.gitDir, GIT_WORK_TREE: canonical } });

  // Mirror the trusted branch separately so the trusted worktree preserves the
  // same prefixed content without inheriting UNTRUSTED commits. We must run the
  // subtree import inside the trusted worktree because `dualview-trusted` is checked
  // out there, not in the canonical work tree.
  gitExecSync([
    "subtree", "add",
    `--prefix=${prefix}`,
    remoteName,
    "dualview-trusted",
    "-m",
    `[DualView-MIGRATE] trusted root promoted: ${child.workTree} → ${canonical} (prefix: ${prefix})`,
  ], dualviewGitOpts(newRoot, newRoot.trustedPath));
  gitExecSync(["remote", "remove", remoteName], {
    cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
  });

  // Reset trusted worktree
  gitExecSync(["reset", "--hard", "dualview-trusted"], { cwd: newRoot.trustedPath });

  // Remove old tracking entry
  const oldShadow = dirname(child.gitDir);
  trackedRoots.delete(child.workTree);
  try { rmSync(oldShadow, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Merge multiple child roots into a common parent directory.
 */
export function mergeRootsInto(children: TrackedRoot[], newWorkTree: string): void {
  if (children.length === 0) return;

  // Pick the child with the most commits as primary
  let primary = children[0]!;
  let maxCount = 0;
  for (const child of children) {
    const { stdout } = gitExecSync(["rev-list", "--count", "HEAD"], {
      cwd: child.workTree, env: { GIT_DIR: child.gitDir },
    });
    const count = parseInt(stdout.trim()) || 0;
    if (count > maxCount) {
      maxCount = count;
      primary = child;
    }
  }

  // Migrate primary upward first
  migrateRootUpward(primary, newWorkTree);

  // Import remaining children under their own prefixes using subtree add.
  for (const child of children) {
    if (child.workTree === primary.workTree) continue;

    const canonical = canonicalWorkspacePath(newWorkTree);
    const newRoot = trackedRoots.get(canonical);
    if (!newRoot) continue;

    const prefix = child.workTree.slice(canonical.length + 1);
    const remoteName = `merge-${Date.now()}`;

    gitExecSync(["remote", "add", remoteName, child.gitDir], {
      cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
    });
    gitExecSync(["fetch", remoteName], {
      cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
    });

    gitExecSync(["checkout", "master"], {
      cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
    });
    gitExecSync([
      "subtree", "add",
      `--prefix=${prefix}`,
      remoteName,
      "master",
      "-m",
      `[DualView-MIGRATE] merged root: ${child.workTree} → ${canonical} (prefix: ${prefix})`,
    ], { cwd: canonical, env: { GIT_DIR: newRoot.gitDir, GIT_WORK_TREE: canonical } });

    gitExecSync([
      "subtree", "add",
      `--prefix=${prefix}`,
      remoteName,
      "dualview-trusted",
      "-m",
      `[DualView-MIGRATE] trusted merged root: ${child.workTree} → ${canonical} (prefix: ${prefix})`,
    ], dualviewGitOpts(newRoot, newRoot.trustedPath));
    gitExecSync(["remote", "remove", remoteName], {
      cwd: canonical, env: { GIT_DIR: newRoot.gitDir },
    });

    // Remove old child tracking
    const oldShadow = dirname(child.gitDir);
    trackedRoots.delete(child.workTree);
    try { rmSync(oldShadow, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

function readWorkspacePathFromMetadata(dir: string, fallbackId: string): string | null {
  const metaPath = join(dir, "workspace.json");
  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { workspacePath?: unknown };
      if (typeof parsed.workspacePath === "string" && parsed.workspacePath.length > 0) {
        return canonicalWorkspacePath(parsed.workspacePath);
      }
    } catch {
      // Fall through to directory-name decoding.
    }
  }

  try {
    return canonicalWorkspacePath(decodeURIComponent(fallbackId));
  } catch {
    return null;
  }
}

function loadCanonicalRegistry(): void {
  const base = dualviewWorkspacesBase();
  if (!existsSync(base)) return;

  let entries: string[];
  try { entries = readdirSync(base); } catch { return; }

  for (const entry of entries) {
    const dir = join(base, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const gitDir = join(dir, "repo.git");
    const agentview = join(dir, "agentview");
    if (!existsSync(gitDir) || !existsSync(agentview)) continue;

    const workTree = readWorkspacePathFromMetadata(dir, entry);
    if (!workTree || !existsSync(workTree)) continue;

    trackedRoots.set(workTree, {
      workTree,
      gitDir,
      trustedPath: agentview,
    });
  }
}

/**
 * Scan canonical DualView state into memory.
 */
export function loadRegistry(): void {
  loadCanonicalRegistry();
}

/**
 * Remove tracking entries whose work tree no longer exists.
 */
export function cleanupOrphans(): void {
  for (const [workTree, _root] of trackedRoots) {
    if (!existsSync(workTree)) {
      const shadowDir = dirname(_root.gitDir);
      try { rmSync(shadowDir, { recursive: true, force: true }); } catch { /* ignore */ }
      trackedRoots.delete(workTree);
    }
  }
}

/**
 * Verify the non-nested invariant holds for all registered roots.
 * Throws if any two roots are nested.
 */
export function verifyNonNested(): void {
  const roots = [...trackedRoots.keys()].sort();
  for (let i = 0; i < roots.length - 1; i++) {
    if (roots[i + 1]!.startsWith(roots[i]! + "/")) {
      throw new Error(`Nested DualView tracking roots detected: ${roots[i]} contains ${roots[i + 1]}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git options adapter (design step 5 — dualviewGitOpts)
// ─────────────────────────────────────────────────────────────────────────────

export interface DualViewGitOpts {
  cwd: string;
  env: Record<string, string>;
}

function linkedWorktreeGitDir(worktree: string): string {
  const gitFile = join(worktree, ".git");
  const raw = readFileSync(gitFile, "utf8");
  const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    throw new Error(`[DualView-ondemand] trusted worktree gitdir missing: ${gitFile}`);
  }
  const gitDir = match[1].trim();
  return gitDir.startsWith("/") ? gitDir : resolve(worktree, gitDir);
}

/**
 * Build git exec options for a tracked root.
 * Passes GIT_DIR + GIT_WORK_TREE so git uses the external shadow database.
 */
export function dualviewGitOpts(root: TrackedRoot, worktree?: string): DualViewGitOpts {
  const wt = worktree ?? root.workTree;
  const gitDir = resolve(wt) === resolve(root.trustedPath) ? linkedWorktreeGitDir(root.trustedPath) : root.gitDir;
  return {
    cwd: wt,
    env: { GIT_DIR: gitDir, GIT_WORK_TREE: wt },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Path rewriting for on-demand trusted worktree
// ─────────────────────────────────────────────────────────────────────────────

export function inferOnDemandRelativeBase(configuredBasePath?: string): string {
  if (configuredBasePath) return configuredBasePath;
  const roots = [...trackedRoots.values()];
  return roots.length === 1 ? roots[0]!.workTree : process.cwd();
}

/**
 * Rewrite a file path to the on-demand trusted worktree.
 *
 * @param createIfMissing  true for write/edit (creates tracking root on demand),
 *                         false for read (only rewrites if already tracked).
 */
export function rewriteToOnDemandTrusted(
  filePath: string,
  createIfMissing: boolean,
  basePath?: string,
): { rewritten: string; root: TrackedRoot } | null {
  let absPath: string;
  try {
    absPath = filePath.startsWith("~/")
      ? join(homedir(), filePath.slice(2))
      : filePath.startsWith("/")
        ? resolve(filePath)
        : resolve(inferOnDemandRelativeBase(basePath), filePath);
  } catch {
    return null;
  }

  // Try existing root first
  const existing = findContainingRoot(absPath);
  if (existing) {
    if (absPath.startsWith(existing.trustedPath + "/") || absPath === existing.trustedPath) {
      return { rewritten: absPath, root: existing };
    }
    const relative = absPath.slice(existing.workTree.length);
    return { rewritten: existing.trustedPath + relative, root: existing };
  }

  if (isExcludedTrackingPath(absPath)) return null;

  if (!createIfMissing) return null;

  // Resolve on demand (may create new tracking root)
  const root = resolveTrackingRoot(absPath);
  if (!root) return null;

  if (absPath.startsWith(root.trustedPath + "/") || absPath === root.trustedPath) {
    return { rewritten: absPath, root };
  }

  const relative = absPath.slice(root.workTree.length);
  return { rewritten: root.trustedPath + relative, root };
}

/**
 * Clear the in-memory registry (for testing).
 */
export function clearRegistry(): void {
  trackedRoots.clear();
}
