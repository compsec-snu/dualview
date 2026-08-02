import * as fs from "node:fs";
import * as path from "node:path";

const AGENTVIEW_SUBDIR = "agentview";

/** Resolve the Agent File System root for archived workspace directories. */
export function resolveTrustedViewRoot(wsDir: string): string | null {
  const workspacesDir = path.join(wsDir, "dualview", "workspaces");
  if (!fs.existsSync(workspacesDir)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentview = path.join(workspacesDir, entry.name, AGENTVIEW_SUBDIR);
    if (fs.existsSync(agentview)) return agentview;
  }
  return null;
}

/** Resolve the git worktree directory for dashboard git APIs. */
export function resolveGitDirForSubdir(wsDir: string, subdir: string): string {
  const requested = subdir ? path.join(wsDir, subdir) : wsDir;
  if (fs.existsSync(requested)) return requested;

  if (normalizeSubdir(subdir) !== AGENTVIEW_SUBDIR) return requested;

  return resolveTrustedViewRoot(wsDir) ?? requested;
}

function normalizeSubdir(subdir: string): string {
  return subdir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}
