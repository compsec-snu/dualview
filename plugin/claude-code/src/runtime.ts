import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import { DualViewDataflowRuntime } from "dualview/dualview-dataflow-runtime.js";
import { DualViewFilesystemRuntime } from "dualview/dualview-filesystem-runtime.js";
import { createOnDemandFileCommitHandler } from "dualview/dualview-filecommit-ondemand.js";
import { reconcileHumanEdits } from "dualview/dualview-human-edit.js";
import {
  cleanupOrphans,
  findContainingRoot,
  loadRegistry,
  resolveTrackingRoot,
  type TrackedRoot,
} from "dualview/dualview-ondemand.js";
import {
  canonicalWorkspacePath,
  dualviewWorkspaceDirFor,
} from "dualview/dualview-paths.js";
import { loadSymbolMap } from "dualview/dualview-symbol-table.js";
import { syncPolicyDirPathsToOnDemand } from "dualview/dualview-policy-dir-sync-ondemand.js";
import { createDataTrustPolicyRuntimeManager } from "dualview/policy/runtime-policy-manager.js";

const execFileAsync = promisify(execFile);

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  message?: string;
  text?: string;
  delta?: string;
  content?: string;
}

export const log = {
  info: (message: string) => console.error(`[dualview] ${message}`),
  warn: (message: string) => console.error(`[dualview] WARN ${message}`),
  error: (message: string) => console.error(`[dualview] ERROR ${message}`),
};

export function appendAuditRecord(record: unknown): void {
  const normalized = record && typeof record === "object" && !Array.isArray(record)
    ? (() => {
        const entry = record as Record<string, unknown>;
        const extra = entry.extra;
        return {
        ts: new Date().toISOString(),
        ...entry,
        ...(extra && typeof extra === "object" && !Array.isArray(extra)
          ? extra as Record<string, unknown>
          : {}),
        originalHead: entry.originalHead ?? entry.originalText ?? "",
        modifiedHead: entry.modifiedHead ?? entry.modifiedText ?? "",
        originalLen: entry.originalLen
          ?? (typeof entry.originalText === "string" ? entry.originalText.length : 0),
        modifiedLen: entry.modifiedLen
          ?? (typeof entry.modifiedText === "string" ? entry.modifiedText.length : 0),
      };
      })()
    : record;
  const paths = [
    process.env.DUALVIEW_AUDIT_LOG,
    process.env.DUALVIEW_AUDIT_MIRROR_LOG,
  ].filter((path): path is string => Boolean(path));
  for (const path of new Set(paths)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export function workspaceFor(input?: HookInput): string {
  const workspace = process.env.DUALVIEW_WORKSPACE
    ?? process.env.CLAUDE_PROJECT_DIR
    ?? input?.cwd
    ?? process.cwd();
  return canonicalWorkspacePath(
    workspace === "~"
      ? homedir()
      : workspace.startsWith("~/")
        ? join(homedir(), workspace.slice(2))
        : workspace,
  );
}

export function symbolDbPathFor(workspace: string): string {
  return join(dualviewWorkspaceDirFor(workspace), "symbols.db");
}

function trackedRootFor(workspace: string): TrackedRoot {
  loadRegistry();
  cleanupOrphans();
  const existing = findContainingRoot(workspace);
  const root = existing ?? resolveTrackingRoot(
    join(workspace, ".dualview-claude-seed"),
    { allowTemporary: true },
  );
  if (!root || root.workTree !== workspace) {
    throw new Error(`DualView cannot initialize workspace: ${workspace}`);
  }
  return root;
}

export function ensureAgentView(workspace: string): TrackedRoot {
  const root = trackedRootFor(workspace);
  reconcileHumanEdits({
    trackedRoot: root,
    dbPath: symbolDbPathFor(workspace),
    log,
  });
  return root;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function humanPath(workspace: string, filePath: string): string {
  const expanded = filePath === "~"
    ? homedir()
    : filePath.startsWith("~/")
      ? join(homedir(), filePath.slice(2))
      : filePath;
  const requested = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(workspace, expanded);
  const missing: string[] = [];
  let existing = requested;
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..");
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  const absolute = join(canonicalWorkspacePath(existing), ...missing);
  if (!isWithin(workspace, absolute)) {
    throw new Error(`DualView path escapes workspace: ${filePath}`);
  }
  return absolute;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  let current = root;
  for (const component of relative(root, target).split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`DualView rejects symbolic-link path: ${target}`);
    }
  }
}

export function rewriteNativeFileInput(
  workspace: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof input.file_path !== "string") {
    throw new Error("DualView native file tool requires file_path");
  }
  const root = ensureAgentView(workspace);
  const source = humanPath(workspace, input.file_path);
  const rewritten = join(root.trustedPath, relative(root.workTree, source));
  assertNoSymlinkComponents(root.trustedPath, rewritten);
  return { ...input, file_path: rewritten };
}

export async function commitNativeFileWrite(
  workspace: string,
  toolName: string,
  toolCallId?: string,
): Promise<void> {
  const root = trackedRootFor(workspace);
  const commit = createOnDemandFileCommitHandler({
    dbPath: symbolDbPathFor(workspace),
    log,
    roots: () => [root],
    throwOnError: true,
  });
  await commit({ toolName, toolCallId }, {});
}

export function createDataflowRuntime(
  workspace: string,
  sessionKey = `claude:${randomUUID()}`,
): DualViewDataflowRuntime {
  const symbolDbPath = symbolDbPathFor(workspace);
  const policyManager = createDataTrustPolicyRuntimeManager({
    basePath: workspace,
    policyPath: process.env.DUALVIEW_POLICY_PATH,
    log,
  });
  const symbolMap = loadSymbolMap(symbolDbPath);
  return new DualViewDataflowRuntime({
    workspacePath: workspace,
    symbolDbPath,
    symbolMap,
    sessionKey,
    inboundDefault: "UNTRUSTED",
    outboundDefault: "resolve",
    restrictedExecToolNames: ["bash"],
    auditToolNames: {
      bash: "exec",
      edit_file: "edit",
      read_file: "read",
    },
    policyToolNames: {
      edit_file: "edit",
    },
    policyEngine: () => policyManager.getEngine(),
    activatePolicy: () => {
      policyManager.activate();
      const policyPaths = policyManager.getExplicitUntrustedDirPolicyPaths();
      if (policyPaths.length > 0) {
        ensureAgentView(workspace);
        syncPolicyDirPathsToOnDemand({
          policyPaths,
          basePath: workspace,
          dbPath: symbolDbPath,
          symbolMap,
          log,
        });
      }
    },
    onAudit: appendAuditRecord,
    log,
  });
}

export function createFilesystemRuntime(
  workspace: string,
  sessionKey: string,
): DualViewFilesystemRuntime {
  return new DualViewFilesystemRuntime({
    workspacePath: workspace,
    symbolDbPath: symbolDbPathFor(workspace),
    sessionKey,
    toolOperations: { bash: "bash", edit_file: "write" },
    log,
  });
}

export function toolRequest(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return { toolCall: { id, name, args } };
}

export async function runShell(
  command: string,
  workdir: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/sh",
      ["-c", command],
      {
        cwd: workdir,
        env: env ? { ...process.env, ...env } : process.env,
        timeout: Number(process.env.DUALVIEW_BASH_TIMEOUT_MS ?? 30_000),
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return [stdout, stderr].filter(Boolean).join("");
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return `Error: ${failure.stderr?.trim() || failure.stdout?.trim() || failure.message}`;
  }
}

export async function runArgv(
  argv: string[],
  workdir: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      argv[0]!,
      argv.slice(1),
      {
        cwd: workdir,
        env: env ? { ...process.env, ...env } : process.env,
        timeout: Number(process.env.DUALVIEW_BASH_TIMEOUT_MS ?? 30_000),
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return [stdout, stderr].filter(Boolean).join("");
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return `Error: ${failure.stderr?.trim() || failure.stdout?.trim() || failure.message}`;
  }
}

export function toolResponseText(response: unknown): string {
  if (typeof response === "string") return response;
  return JSON.stringify(response);
}
