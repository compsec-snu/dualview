import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

export const DUALVIEW_SCHEMA_VERSION = 1;

export interface DualViewWorkspaceMetadata {
  schemaVersion: number;
  workspacePath: string;
  workspaceId: string;
}

/** Return the canonical absolute workspace path used for DualView identity. */
export function canonicalWorkspacePath(workspacePath: string): string {
  const resolved = resolve(workspacePath);
  let existingAncestor = resolved;
  const missingParts: string[] = [];

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return resolved;
    missingParts.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  try {
    return resolve(realpathSync(existingAncestor), ...missingParts);
  } catch {
    return resolved;
  }
}

/** Encode a canonical workspace path as a single filesystem-safe directory name. */
export function workspaceIdFor(workspacePath: string): string {
  return encodeURIComponent(canonicalWorkspacePath(workspacePath));
}

export function dualviewWorkspacesBase(): string {
  return join(homedir(), ".dualview", "workspaces");
}

export function dualviewSymbolDbPath(): string {
  return join(homedir(), ".dualview", "symbols.db");
}

export function dualviewWorkspaceDirFor(workspacePath: string): string {
  return join(dualviewWorkspacesBase(), workspaceIdFor(workspacePath));
}

export function dualviewGitDirFor(workspacePath: string): string {
  return join(dualviewWorkspaceDirFor(workspacePath), "repo.git");
}

export function dualviewAgentViewPathFor(workspacePath: string): string {
  return join(dualviewWorkspaceDirFor(workspacePath), "agentview");
}

export function dualviewWorkspaceMetadataFor(workspacePath: string): DualViewWorkspaceMetadata {
  const canonical = canonicalWorkspacePath(workspacePath);
  return {
    schemaVersion: DUALVIEW_SCHEMA_VERSION,
    workspacePath: canonical,
    workspaceId: workspaceIdFor(canonical),
  };
}

export function isDualViewWorkspaceDir(dir: string): boolean {
  return existsSync(join(dir, "repo.git"));
}
