import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { sanitizeHostExecEnv } from "../../openclaw/src/infra/host-env-security.js";
import { createOnDemandFileCommitHandler } from "./dualview-filecommit-ondemand.js";
import { reconcileHumanEdits } from "./dualview-human-edit.js";
import {
  cleanupOrphans,
  dualviewGitOpts,
  findContainingRoot,
  loadRegistry,
  resolveTrackingRoot,
  type TrackedRoot,
} from "./dualview-ondemand.js";
import {
  canonicalWorkspacePath,
  dualviewWorkspaceDirFor,
} from "./dualview-paths.js";
import {
  allocateSymbol,
  loadSymbolMap,
  type SymbolMap,
} from "./dualview-symbol-table.js";
import {
  buildLinuxConcreteShellCommand,
  buildMacOsConcreteShellCommand,
  type RestrictedExecMount,
} from "./dualview-restricted-exec.js";
import { isSymbolicExec } from "./policy/exec-identifier.js";

export interface FilesystemLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface FilesystemToolRequest {
  toolCall: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
}

export interface FilesystemToolContext {
  trustedRoot: string;
}

export interface DualViewFilesystemOptions {
  workspacePath: string;
  symbolDbPath?: string;
  symbolMap?: SymbolMap;
  sessionKey?: string;
  toolOperations: Record<string, "write" | "bash">;
  log?: FilesystemLogger;
}

const FILE_PATH_KEYS = ["file_path", "path", "filepath", "file"] as const;
const WORKDIR_KEYS = ["workdir", "cwd"] as const;

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteRestrictedWritePaths(
  command: string,
  humanRoot: string,
  agentRoot: string,
): string {
  const destination = new RegExp(
    `(>{1,2}\\s*)(["']?)${escapeRegExp(humanRoot)}(?=/|["'\\s]|$)`,
    "g",
  );
  return command.replace(
    destination,
    (_match, redirect: string, quote: string) =>
      `${redirect}${quote}${agentRoot}`,
  );
}

function findStringKey(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  return keys.find((key) => typeof args[key] === "string") ?? null;
}

export class DualViewFilesystemRuntime {
  readonly workspacePath: string;

  private readonly options: DualViewFilesystemOptions;
  private root: TrackedRoot | null = null;
  private queue: Promise<void> = Promise.resolve();
  private untrustedCaptureFailed = false;

  constructor(options: DualViewFilesystemOptions) {
    this.workspacePath = canonicalWorkspacePath(expandHome(options.workspacePath));
    this.options = {
      ...options,
      workspacePath: this.workspacePath,
      symbolDbPath: options.symbolDbPath
        ?? join(dualviewWorkspaceDirFor(this.workspacePath), "symbols.db"),
    };
  }

  async wrapToolCall<TRequest extends FilesystemToolRequest, TResult>(
    request: TRequest,
    handler: (
      request: TRequest,
      context: FilesystemToolContext,
    ) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const operation = this.options.toolOperations[request.toolCall.name];
    if (!operation) {
      throw new Error(
        `DualView filesystem runtime has no operation for ${request.toolCall.name}`,
      );
    }

    return this.runExclusive(async () => {
      if (this.untrustedCaptureFailed) {
        throw new Error(
          "DualView blocked tool execution after an unrestricted shell write capture failure",
        );
      }
      const root = this.ensureRoot();
      reconcileHumanEdits({
        trackedRoot: root,
        dbPath: this.options.symbolDbPath,
        log: this.options.log,
      });
      const rewritten = this.rewriteRequest(request, operation, root);
      const restricted = operation === "bash" && isSymbolicExec(request.toolCall.args);
      const snapshot = operation === "bash" && !restricted
        ? this.snapshotWorkspace(root.workTree)
        : null;

      let result: TResult;
      try {
        result = await handler(rewritten, { trustedRoot: root.trustedPath });
      } catch (error) {
        if (operation === "bash" && !restricted) {
          try {
            await this.captureUnrestrictedWrites(root, request, snapshot!);
          } catch (captureError) {
            this.untrustedCaptureFailed = true;
            throw new AggregateError(
              [error, captureError],
              "Unrestricted shell failed and DualView could not capture its filesystem side effects",
            );
          }
        }
        throw error;
      }

      if (operation === "bash" && !restricted) {
        try {
          await this.captureUnrestrictedWrites(root, request, snapshot!);
        } catch (error) {
          this.untrustedCaptureFailed = true;
          throw error;
        }
      } else {
        const commit = createOnDemandFileCommitHandler({
          dbPath: this.options.symbolDbPath,
          log: this.options.log,
          roots: () => [root],
          throwOnError: true,
        });
        await commit({
          toolName: request.toolCall.name,
          toolCallId: request.toolCall.id,
        }, {});
      }
      return result;
    });
  }

  private ensureRoot(): TrackedRoot {
    if (this.root) return this.root;
    loadRegistry();
    cleanupOrphans();
    const existing = findContainingRoot(this.workspacePath);
    const root = existing ?? resolveTrackingRoot(
      join(this.workspacePath, ".dualview-filesystem-seed"),
      { allowTemporary: true },
    );
    if (!root || root.workTree !== this.workspacePath) {
      throw new Error(`DualView cannot track workspace: ${this.workspacePath}`);
    }
    this.root = root;
    return root;
  }

  private rewriteRequest<TRequest extends FilesystemToolRequest>(
    request: TRequest,
    operation: "write" | "bash",
    root: TrackedRoot,
  ): TRequest {
    const args = request.toolCall.args;
    if (operation === "write") {
      const key = findStringKey(args, FILE_PATH_KEYS);
      if (!key) throw new Error("DualView write tool requires a file path");
      const rewritten = this.toAgentView(args[key] as string, root);
      this.assertNoSymlinkComponents(root.trustedPath, rewritten);
      return this.withArg(request, key, rewritten);
    }

    const key = findStringKey(args, WORKDIR_KEYS) ?? "workdir";
    const requested = typeof args[key] === "string" ? args[key] : this.workspacePath;
    const restricted = isSymbolicExec(args);
    const workdir = restricted
      ? this.toAgentView(requested, root)
      : this.toHumanView(requested);
    if (restricted) this.assertNoSymlinkComponents(root.trustedPath, workdir);
    let rewritten = this.withArg(
      request,
      key,
      workdir,
    );
    const command = args.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("DualView bash requires a command");
    }
    if (restricted) {
      rewritten = this.withArg(
        rewritten,
        "command",
        rewriteRestrictedWritePaths(
          command,
          this.workspacePath,
          root.trustedPath,
        ),
      );
      rewritten = this.withArg(
        rewritten,
        "env",
        sanitizeHostExecEnv({
          baseEnv: {},
          overrides: args.env as Record<string, string> | undefined,
        }),
      );
      return rewritten;
    }

    const mounts: RestrictedExecMount[] = [{
      trustedPath: root.trustedPath,
      workTree: root.workTree,
      protectedDirs: [root.gitDir],
      protectedFiles: [this.options.symbolDbPath!],
    }];
    const wrapped = process.platform === "linux"
      ? buildLinuxConcreteShellCommand(command, mounts)
      : process.platform === "darwin"
        ? buildMacOsConcreteShellCommand(command, mounts)
        : command;
    return this.withArg(rewritten, "command", wrapped);
  }

  private toAgentView(path: string, root: TrackedRoot): string {
    const human = this.toHumanView(path);
    return join(root.trustedPath, relative(root.workTree, human));
  }

  private toHumanView(path: string): string {
    const expanded = expandHome(path);
    const requested = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.workspacePath, expanded);
    const missing: string[] = [];
    let existing = requested;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }

    const absolute = join(canonicalWorkspacePath(existing), ...missing);
    if (!isWithin(this.workspacePath, absolute)) {
      throw new Error(
        `DualView path escapes configured workspace: ${path} ` +
          `(workspace: ${this.workspacePath})`,
      );
    }
    return absolute;
  }

  private assertNoSymlinkComponents(root: string, target: string): void {
    let current = root;
    for (const component of relative(root, target).split("/").filter(Boolean)) {
      current = join(current, component);
      if (!existsSync(current)) return;
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`DualView rejects symbolic-link path: ${target}`);
      }
    }
  }

  private withArg<TRequest extends FilesystemToolRequest>(
    request: TRequest,
    key: string,
    value: unknown,
  ): TRequest {
    return {
      ...request,
      toolCall: {
        ...request.toolCall,
        args: { ...request.toolCall.args, [key]: value },
      },
    };
  }

  private snapshotWorkspace(rootPath: string): Map<string, string> {
    const snapshot = new Map<string, string>();
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolute, rel);
        } else if (entry.isFile()) {
          snapshot.set(
            rel,
            createHash("sha256").update(readFileSync(absolute)).digest("hex"),
          );
        } else if (entry.isSymbolicLink()) {
          snapshot.set(rel, "symlink");
        }
      }
    };
    visit(rootPath, "");
    return snapshot;
  }

  private async captureUnrestrictedWrites<TRequest extends FilesystemToolRequest>(
    root: TrackedRoot,
    request: TRequest,
    before: ReadonlyMap<string, string>,
  ): Promise<void> {
    const after = this.snapshotWorkspace(root.workTree);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changed = [...paths]
      .filter((path) => before.get(path) !== after.get(path))
      .sort();
    if (changed.length === 0) return;

    const symbolMap = loadSymbolMap(this.options.symbolDbPath);
    const binaryFiles: Array<{ path: string; content: Buffer }> = [];
    for (const [index, path] of changed.entries()) {
      const humanPath = join(root.workTree, path);
      const agentPath = join(root.trustedPath, path);
      if (!existsSync(humanPath)) {
        rmSync(agentPath, { force: true });
        continue;
      }
      if (!lstatSync(humanPath).isFile()) {
        this.untrustedCaptureFailed = true;
        throw new Error(`DualView cannot capture non-regular shell output: ${path}`);
      }
      const content = readFileSync(humanPath);
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (content.subarray(0, 8192).includes(0)) throw new Error("binary");
      } catch {
        binaryFiles.push({ path, content });
        value = `[untrusted binary content withheld: ${path}]`;
      }
      const symbol = allocateSymbol(
        symbolMap,
        {
          tool: request.toolCall.name,
          field: `file_${index + 1}`,
          value,
          sessionKey: this.options.sessionKey,
          callId: request.toolCall.id,
        },
        this.options.symbolDbPath,
      );
      mkdirSync(dirname(agentPath), { recursive: true });
      writeFileSync(agentPath, symbol, "utf8");
    }

    const git = (args: string[], workTree = root.workTree): void => {
      const options = dualviewGitOpts(root, workTree);
      execFileSync("git", args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: "ignore",
      });
    };
    git(["add", "-f", "--", ...changed]);
    git(["add", "-f", "--", ...changed], root.trustedPath);
    const commit = createOnDemandFileCommitHandler({
      dbPath: this.options.symbolDbPath,
      log: this.options.log,
      roots: () => [root],
      allowedHumanChanges: changed,
      throwOnError: true,
    });
    await commit({
      toolName: request.toolCall.name,
      toolCallId: request.toolCall.id,
    }, {});

    if (binaryFiles.length > 0) {
      for (const binary of binaryFiles) {
        const path = join(root.workTree, binary.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, binary.content);
      }
      const binaryPaths = binaryFiles.map((binary) => binary.path);
      git(["add", "-f", "--", ...binaryPaths]);
      const options = dualviewGitOpts(root);
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          `[DUALVIEW-UNTRUSTED] dualview: tool=${request.toolCall.name} ` +
            `callId=${request.toolCall.id ?? "none"} run=none files=${binaryPaths.join(",")}`,
          "--no-verify",
        ],
        {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: "ignore",
        },
      );
    }
  }

  private async runExclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
