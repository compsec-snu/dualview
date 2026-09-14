import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AIMessage } from "@langchain/core/messages";
import { createMiddleware, tool } from "langchain";
import * as z from "zod";

import {
  AdfiLangChainRuntime,
  type AdfiAuditRecord,
  type InspectSymbolLangChainOptions,
} from "./adfi-runtime.js";
import {
  createBraveWebSearchTool,
  type BraveWebSearchOptions,
} from "./brave-search.js";
import { createOnDemandFileCommitHandler } from "../dualview/dualview-filecommit-ondemand.js";
import { reconcileHumanEdits } from "../dualview/dualview-human-edit.js";
import {
  restorePolicyDirPathsInOnDemand,
  syncPolicyDirPathsToOnDemand,
} from "../dualview/dualview-policy-dir-sync-ondemand.js";
import {
  cleanupOrphans,
  dualviewGitOpts,
  findContainingRoot,
  loadRegistry,
  resolveTrackingRoot,
  type TrackedRoot,
} from "../dualview/dualview-ondemand.js";
import {
  canonicalWorkspacePath,
  dualviewWorkspaceDirFor,
} from "../dualview/dualview-paths.js";
import {
  allocateSymbol,
  loadSymbolMap,
  type SymbolMap,
} from "../dualview/dualview-symbol-table.js";
import { sanitizeHostExecEnv } from "../../openclaw/src/infra/host-env-security.js";
import {
  buildLinuxAgentShellCommand,
  buildLinuxConcreteShellCommand,
  buildMacOsAgentShellCommand,
  buildMacOsConcreteShellCommand,
  type RestrictedExecMount,
} from "../dualview/dualview-restricted-exec.js";
import { isSymbolicExec } from "../dualview/policy/exec-identifier.js";
import {
  getExplicitUntrustedDirPolicyPaths,
  loadPolicyFile,
} from "../dualview/policy/load-policy.js";
import { createDataTrustPolicyRuntimeManager } from "../dualview/policy/runtime-policy-manager.js";

export {
  AdfiLangChainRuntime,
  type AdfiAuditRecord,
};
export {
  DualViewDataflowRuntime,
  type DataflowAuditRecord,
  type ProcessedToolResult,
} from "../dualview/dualview-dataflow-runtime.js";
export {
  CopilotChatModel,
  parseCopilotResponse,
  type CopilotChatModelOptions,
  type ModelResponse,
} from "./copilot-chat-model.js";

export type DualViewToolOperation = "read" | "write" | "bash";

export interface DualViewLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface DualViewLangChainOptions {
  /** Human File System directory exposed through DualView. */
  workspacePath: string;
  /** SQLite symbol database used when resolving symbols into the human view. */
  symbolDbPath?: string;
  /** Shared in-memory symbol map used by filesystem and dataflow runtimes. */
  symbolMap?: SymbolMap;
  /** Shared Data Trust Policy YAML used for inbound and outbound decisions. */
  policyPath?: string;
  /** Stable session identifier used for symbol ownership and audit records. */
  sessionKey?: string;
  /** Trust fallback for tools absent from the shared inbound policy. */
  inboundDefault?: "TRUSTED" | "UNTRUSTED";
  /** Resolution fallback for tools absent from the shared outbound policy. */
  outboundDefault?: "resolve" | "not_resolve";
  /** Override the shared per-tool outbound symbol-resolution decision. */
  toolInputResolve?: Record<string, boolean>;
  /** Resolve the currently active explicit untrusted-directory policy paths. */
  policyDirPaths?: () => string[];
  /** Receive real middleware audit records without coupling to OpenClaw paths. */
  onAudit?: (record: AdfiAuditRecord) => void;
  /** Enable inspect_symbol with an isolated untrusted-model invocation. */
  inspectSymbol?: InspectSymbolLangChainOptions;
  /** Enable Brave web_search. Auto-enables when a supported API key is present. */
  braveSearch?: boolean | BraveWebSearchOptions;
  /** Add the prototype read_file, write_file, and bash tools to the middleware. */
  includeTools?: boolean;
  /** Extend or override the default LangChain tool-name mapping. */
  toolOperations?: Record<string, DualViewToolOperation>;
  /** Rename bundled tools to match an application's existing tool names. */
  toolNames?: Partial<{
    read: string;
    write: string;
    edit: string;
    bash: string;
  }>;
  /** Maximum runtime for the bundled bash tool. */
  bashTimeoutMs?: number;
  /** Wrap restricted commands with the built-in AgentShell. Defaults to true. */
  wrapRestrictedExec?: boolean;
  log?: DualViewLogger;
}

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DualViewToolCallRequest {
  toolCall: ToolCall;
}

export type DualViewToolCallHandler<TRequest extends DualViewToolCallRequest, TResult> = (
  request: TRequest,
) => TResult | Promise<TResult>;

const DEFAULT_TOOL_OPERATIONS: Readonly<Record<string, DualViewToolOperation>> = {
  read_file: "read",
  write_file: "write",
  edit_file: "write",
  bash: "bash",
};

const FILE_PATH_KEYS = ["file_path", "path", "filepath", "file"] as const;
const WORKDIR_KEYS = ["workdir", "cwd"] as const;

interface ResolvedToolNames {
  read: string;
  write: string;
  edit: string;
  bash: string;
}

function resolveToolNames(options: DualViewLangChainOptions): ResolvedToolNames {
  return {
    read: options.toolNames?.read ?? "read_file",
    write: options.toolNames?.write ?? "write_file",
    edit: options.toolNames?.edit ?? "edit_file",
    bash: options.toolNames?.bash ?? "bash",
  };
}

function expandHome(filePath: string): string {
  return filePath === "~"
    ? homedir()
    : filePath.startsWith("~/")
      ? join(homedir(), filePath.slice(2))
      : filePath;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findStringKey(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (typeof args[key] === "string") return key;
  }
  return null;
}

export class DualViewLangChainRuntime {
  readonly workspacePath: string;

  private readonly options: DualViewLangChainOptions;
  private readonly toolOperations: Readonly<Record<string, DualViewToolOperation>>;
  private readonly restrictedToolNames: ReadonlySet<string>;
  private policyDirPaths: string[];
  private policyDirPathsInitialized = false;
  private root: TrackedRoot | null = null;
  private queue: Promise<void> = Promise.resolve();
  private untrustedCaptureFailed = false;

  constructor(options: DualViewLangChainOptions) {
    this.workspacePath = canonicalWorkspacePath(expandHome(options.workspacePath));
    this.options = {
      ...options,
      symbolDbPath: options.symbolDbPath
        ?? join(dualviewWorkspaceDirFor(this.workspacePath), "symbols.db"),
    };
    const toolNames = resolveToolNames(options);
    this.toolOperations = {
      ...DEFAULT_TOOL_OPERATIONS,
      [toolNames.read]: "read",
      [toolNames.write]: "write",
      [toolNames.edit]: "write",
      [toolNames.bash]: "bash",
      ...options.toolOperations,
    };
    this.restrictedToolNames = new Set(
      options.includeTools === false ? [] : [toolNames.bash],
    );
    this.policyDirPaths = getExplicitUntrustedDirPolicyPaths(
      loadPolicyFile(options.policyPath, this.workspacePath, options.log ?? {
        info: () => undefined,
        warn: () => undefined,
      }),
    );
  }

  operationFor(toolName: string): DualViewToolOperation | null {
    return this.toolOperations[toolName] ?? null;
  }

  restrictedExecToolNames(): string[] {
    return [...this.restrictedToolNames];
  }

  async wrapToolCall<TRequest extends DualViewToolCallRequest, TResult>(
    request: TRequest,
    handler: DualViewToolCallHandler<TRequest, TResult>,
  ): Promise<TResult> {
    const operation = this.operationFor(request.toolCall.name);
    if (!operation) return handler(request);

    return this.runExclusive(async () => {
      if (this.untrustedCaptureFailed) {
        throw new Error(
          "DualView blocked tool execution after an unrestricted shell write capture failure",
        );
      }
      const root = this.ensureRoot();
      const policyDirPaths = this.options.policyDirPaths?.() ?? this.policyDirPaths;
      const activePaths = new Set(policyDirPaths.map((path) =>
        resolve(this.workspacePath, path)
      ));
      const removedPaths = this.policyDirPaths.filter((path) =>
        !activePaths.has(resolve(this.workspacePath, path))
      );
      if (removedPaths.length > 0) {
        restorePolicyDirPathsInOnDemand({
          policyPaths: removedPaths,
          basePath: this.workspacePath,
        });
      }
      const addedPaths = this.policyDirPathsInitialized
        ? policyDirPaths.filter((path) => !this.policyDirPaths.some((previous) =>
          resolve(this.workspacePath, previous) === resolve(this.workspacePath, path)
        ))
        : policyDirPaths;
      if (addedPaths.length > 0) {
        syncPolicyDirPathsToOnDemand({
          policyPaths: addedPaths,
          basePath: this.workspacePath,
          dbPath: this.options.symbolDbPath,
          log: this.options.log,
          symbolMap: this.options.symbolMap,
        });
      }
      this.policyDirPaths = [...policyDirPaths];
      this.policyDirPathsInitialized = true;
      reconcileHumanEdits({
        trackedRoot: root,
        dbPath: this.options.symbolDbPath,
        log: this.options.log,
        symbolMap: this.options.symbolMap,
        isPolicyUntrusted: policyDirPaths.length > 0
          ? (absolutePath) => policyDirPaths.some((policyPath) => {
            const normalized = policyPath.endsWith("/*") || policyPath.endsWith("\\*")
              ? policyPath.slice(0, -2)
              : policyPath;
            const policyRoot = resolve(this.workspacePath, normalized);
            const rel = relative(policyRoot, absolutePath);
            return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
          })
          : undefined,
      });

      const rewritten = this.rewriteRequest(request, operation, root);
      const restrictedExec = operation === "bash" && isSymbolicExec(request.toolCall.args);
      const preExecSnapshot = operation === "bash" && !restrictedExec
        ? this.snapshotWorkspace(root.workTree)
        : null;
      let result: TResult;
      try {
        result = await handler(rewritten);
      } catch (error) {
        if (operation === "bash" && !restrictedExec) {
          try {
            await this.captureUnrestrictedExecWrites(root, request, preExecSnapshot!);
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

      if (operation === "bash" && !restrictedExec) {
        try {
          await this.captureUnrestrictedExecWrites(root, request, preExecSnapshot!);
        } catch (error) {
          this.untrustedCaptureFailed = true;
          throw error;
        }
      } else if (operation === "write" || restrictedExec) {
        const commit = createOnDemandFileCommitHandler({
          dbPath: this.options.symbolDbPath,
          log: this.options.log,
          roots: () => [root],
        });
        await commit({
          toolName: request.toolCall.name,
          toolCallId: request.toolCall.id,
        }, {});
      }

      return result;
    });
  }

  private async captureUnrestrictedExecWrites<TRequest extends DualViewToolCallRequest>(
    root: TrackedRoot,
    request: TRequest,
    beforeSnapshot: ReadonlyMap<string, string>,
  ): Promise<void> {
    const stdout = this.strictGit(root, [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const gitChanges = stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({
        status: entry.slice(0, 2).trim(),
        path: entry.slice(3),
      }));
    const changesByPath = new Map(gitChanges.map((change) => [change.path, change]));
    const afterSnapshot = this.snapshotWorkspace(root.workTree);
    const snapshotPaths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
    for (const path of snapshotPaths) {
      if (beforeSnapshot.get(path) === afterSnapshot.get(path)) continue;
      if (!changesByPath.has(path)) {
        changesByPath.set(path, {
          status: afterSnapshot.has(path) ? "??" : "D",
          path,
        });
      }
    }
    const changes = [...changesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (changes.length === 0) return;

    const binaryFiles: Array<{ path: string; content: Buffer }> = [];
    const symbolMap = loadSymbolMap(this.options.symbolDbPath);
    for (const [index, change] of changes.entries()) {
      const humanPath = join(root.workTree, change.path);
      const trustedPath = join(root.trustedPath, change.path);
      if (change.status.includes("D") || !existsSync(humanPath)) {
        rmSync(trustedPath, { force: true });
        continue;
      }

      if (!lstatSync(humanPath).isFile()) {
        throw new Error(`DualView cannot safely capture non-regular exec output: ${change.path}`);
      }
      const content = readFileSync(humanPath);
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (content.subarray(0, 8192).includes(0)) throw new Error("NUL byte");
      } catch {
        binaryFiles.push({ path: change.path, content });
        value = `[untrusted binary content withheld: ${change.path}]`;
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
      mkdirSync(dirname(trustedPath), { recursive: true });
      writeFileSync(trustedPath, symbol, "utf8");
    }

    const stagePaths = changes
      .map((change) => change.path)
      .filter((path) =>
        existsSync(join(root.workTree, path)) || existsSync(join(root.trustedPath, path)),
      );
    if (stagePaths.length > 0) {
      this.strictGit(root, ["add", "-f", "--", ...stagePaths]);
      this.strictGit(root, ["add", "-f", "--", ...stagePaths], root.trustedPath);
    }

    const commit = createOnDemandFileCommitHandler({
      dbPath: this.options.symbolDbPath,
      log: this.options.log,
      roots: () => [root],
      allowedHumanChanges: stagePaths,
    });
    await commit({
      toolName: request.toolCall.name,
      toolCallId: request.toolCall.id,
    }, {});

    if (binaryFiles.length > 0) {
      for (const binary of binaryFiles) {
        mkdirSync(dirname(join(root.workTree, binary.path)), { recursive: true });
        writeFileSync(join(root.workTree, binary.path), binary.content);
      }
      const binaryPaths = binaryFiles.map((binary) => binary.path);
      this.strictGit(root, ["add", "-f", "--", ...binaryPaths]);
      this.strictGit(root, [
        "commit",
        "-m",
        `[DUALVIEW-UNTRUSTED] dualview: tool=${request.toolCall.name} ` +
          `callId=${request.toolCall.id ?? "none"} run=none files=${binaryPaths.join(",")}`,
        "--no-verify",
      ]);
    }

    const humanStatus = this.strictGit(root, ["status", "--porcelain"]);
    const trustedStatus = this.strictGit(root, ["status", "--porcelain"], root.trustedPath);
    if (humanStatus.trim() || trustedStatus.trim()) {
      throw new Error(
        `DualView exec capture left dirty state (human=${JSON.stringify(humanStatus.trim())}, ` +
          `trusted=${JSON.stringify(trustedStatus.trim())})`,
      );
    }
  }

  private strictGit(root: TrackedRoot, args: string[], workTree = root.workTree): string {
    const git = dualviewGitOpts(root, workTree);
    return execFileSync("git", args, {
      cwd: git.cwd,
      env: { ...process.env, ...git.env },
      encoding: "utf8",
    });
  }

  private snapshotWorkspace(rootPath: string): Map<string, string> {
    const snapshot = new Map<string, string>();
    const visit = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absolutePath, relativePath);
        } else if (entry.isFile()) {
          snapshot.set(
            relativePath,
            createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
          );
        } else if (entry.isSymbolicLink()) {
          snapshot.set(relativePath, "symlink");
        }
      }
    };
    visit(rootPath, "");
    return snapshot;
  }

  private ensureRoot(): TrackedRoot {
    if (this.root) return this.root;

    loadRegistry();
    cleanupOrphans();

    const existing = findContainingRoot(this.workspacePath);
    const root = existing ?? resolveTrackingRoot(
      join(this.workspacePath, ".dualview-langchain-seed"),
      { allowTemporary: true },
    );
    if (!root) {
      throw new Error(`DualView cannot track workspace: ${this.workspacePath}`);
    }

    this.root = root;
    return root;
  }

  private rewriteRequest<TRequest extends DualViewToolCallRequest>(
    request: TRequest,
    operation: DualViewToolOperation,
    root: TrackedRoot,
  ): TRequest {
    const args = request.toolCall.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`DualView tool ${request.toolCall.name} requires object arguments`);
    }

    if (operation === "bash") {
      const key = findStringKey(args, WORKDIR_KEYS) ?? "workdir";
      const requested = typeof args[key] === "string" ? args[key] : this.workspacePath;
      const restricted = isSymbolicExec(args);
      if (restricted && !this.restrictedToolNames.has(request.toolCall.name)) {
        throw new Error(
          `DualView restricted exec requires the bundled shell tool; ` +
          `${request.toolCall.name} is an external bash mapping`,
        );
      }
      const workdir = restricted
        ? this.toAgentView(requested, root)
        : this.toHumanView(requested);
      let rewritten = this.withRewrittenArg(request, key, workdir);
      const mounts: RestrictedExecMount[] = [{
        trustedPath: root.trustedPath,
        workTree: root.workTree,
        protectedDirs: [root.gitDir],
        protectedFiles: [this.options.symbolDbPath!],
      }];
      if (restricted) {
        const command = args.command;
        if (typeof command !== "string" || command.length === 0) {
          throw new Error(`DualView tool ${request.toolCall.name} requires a command`);
        }
        if (this.options.wrapRestrictedExec !== false) {
          const wrappedCommand = process.platform === "linux"
            ? buildLinuxAgentShellCommand(command, mounts)
            : process.platform === "darwin"
              ? buildMacOsAgentShellCommand(command, mounts)
              : null;
          if (!wrappedCommand) {
            throw new Error(
              `DualView restricted exec is unsupported on ${process.platform}; Linux is required`,
            );
          }
          rewritten = this.withRewrittenArg(rewritten, "command", wrappedCommand);
        }
        rewritten = this.withRewrittenArg(
          rewritten,
          "env",
          sanitizeHostExecEnv({
            baseEnv: {},
            overrides: args.env as Record<string, string> | undefined,
          }),
        );
      } else if (typeof args.command === "string") {
        const wrappedCommand = process.platform === "linux"
          ? buildLinuxConcreteShellCommand(args.command, mounts)
          : process.platform === "darwin"
            ? buildMacOsConcreteShellCommand(args.command, mounts)
            : args.command;
        rewritten = this.withRewrittenArg(rewritten, "command", wrappedCommand);
      }
      return rewritten;
    }

    const key = findStringKey(args, FILE_PATH_KEYS);
    if (!key) {
      if (operation === "read") return request;
      throw new Error(
        `DualView tool ${request.toolCall.name} requires one of: ${FILE_PATH_KEYS.join(", ")}`,
      );
    }
    return this.withRewrittenArg(request, key, this.toAgentView(args[key] as string, root));
  }

  private toAgentView(inputPath: string, root: TrackedRoot): string {
    const absolute = this.toHumanView(inputPath);
    return join(root.trustedPath, relative(root.workTree, absolute));
  }

  private toHumanView(inputPath: string): string {
    const expanded = expandHome(inputPath);
    const absolute = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.workspacePath, expanded);

    if (!isWithin(this.workspacePath, absolute)) {
      throw new Error(
        `DualView path escapes configured workspace: ${inputPath} (workspace: ${this.workspacePath})`,
      );
    }

    return absolute;
  }

  private withRewrittenArg<TRequest extends DualViewToolCallRequest>(
    request: TRequest,
    key: string,
    value: unknown,
  ): TRequest {
    return {
      ...request,
      toolCall: {
        ...request.toolCall,
        args: {
          ...request.toolCall.args,
          [key]: value,
        },
      },
    };
  }

  private async runExclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<string> {
  const restricted = env?.RESTRICTED === "1";
  const baseEnv = restricted
    ? Object.fromEntries(
        ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "TERM", "TMPDIR", "TZ", "USER"]
          .flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []),
      )
    : process.env;
  return new Promise((resolvePromise) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        env: sanitizeHostExecEnv({ baseEnv, overrides: env }),
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise(`Error: ${stderr.trim() || error.message}`);
          return;
        }
        resolvePromise([stdout, stderr].filter(Boolean).join(""));
      },
    );
  });
}

function createDualViewTools(options: DualViewLangChainOptions) {
  const timeoutMs = options.bashTimeoutMs ?? 30_000;
  const toolNames = resolveToolNames(options);

  const readFileTool = tool(
    async ({ path }) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: toolNames.read,
      description: "Read a UTF-8 file from the configured DualView workspace.",
      schema: z.object({ path: z.string() }),
    },
  );

  const writeFileTool = tool(
    async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes.`;
    },
    {
      name: toolNames.write,
      description: "Write a UTF-8 file in the configured DualView workspace.",
      schema: z.object({
        path: z.string(),
        content: z.string(),
      }),
    },
  );

  const editFileTool = tool(
    async ({ path, old_string, new_string }) => {
      const content = await readFile(path, "utf8");
      if (!content.includes(old_string)) {
        return `Error: edit target text was not found in ${path}`;
      }
      await writeFile(path, content.replace(old_string, new_string), "utf8");
      return `Edited ${path}.`;
    },
    {
      name: toolNames.edit,
      description: "Replace one exact text occurrence in a UTF-8 workspace file.",
      schema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
    },
  );

  const bashTool = tool(
    async ({ command, workdir, env }) => {
      if (!workdir) {
        throw new Error("DualView middleware did not inject a bash working directory");
      }
      return runBash(command, workdir, timeoutMs, env);
    },
    {
      name: toolNames.bash,
      description: "Run a shell command in the configured DualView Agent File System.",
      schema: z.object({
        command: z.string(),
        workdir: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    },
  );

  return [readFileTool, writeFileTool, editFileTool, bashTool];
}

function createOptionalTools(
  options: DualViewLangChainOptions,
  adfiRuntime: AdfiLangChainRuntime,
  policyManager: ReturnType<typeof createDataTrustPolicyRuntimeManager>,
) {
  const inspectSymbolTool = adfiRuntime.createInspectSymbolTool();
  const braveOptions = options.braveSearch === false
    ? null
    : typeof options.braveSearch === "object"
      ? options.braveSearch
      : {};
  const braveSearchTool = braveOptions ? createBraveWebSearchTool(braveOptions) : null;
  return [
    inspectSymbolTool,
    braveSearchTool,
    ...adfiRuntime.createPolicyTools(policyManager),
  ].filter((candidate) => candidate !== null);
}

export function createDualViewMiddleware(
  options: DualViewLangChainOptions,
): ReturnType<typeof createMiddleware> {
  return createDualViewIntegration(options).middleware;
}

export interface DualViewLangChainIntegration {
  middleware: ReturnType<typeof createMiddleware>;
  resolveFinalResponse: (message: AIMessage) => AIMessage;
  closeSession: () => void;
}

export function createDualViewIntegration(
  options: DualViewLangChainOptions,
): DualViewLangChainIntegration {
  const workspacePath = canonicalWorkspacePath(expandHome(options.workspacePath));
  const runtimeOptions = {
    ...options,
    workspacePath,
    symbolDbPath: options.symbolDbPath
      ?? join(dualviewWorkspaceDirFor(workspacePath), "symbols.db"),
    symbolMap: options.symbolMap ?? loadSymbolMap(
      options.symbolDbPath ?? join(dualviewWorkspaceDirFor(workspacePath), "symbols.db"),
    ),
  };
  const log = options.log ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const policyManager = createDataTrustPolicyRuntimeManager({
    policyPath: runtimeOptions.policyPath,
    basePath: runtimeOptions.workspacePath,
    log,
  });
  const dualViewRuntime = new DualViewLangChainRuntime({
    ...runtimeOptions,
    policyDirPaths: () => policyManager.getExplicitUntrustedDirPolicyPaths(),
  });
  const adfiRuntime = new AdfiLangChainRuntime({
    ...runtimeOptions,
    policyEngine: () => policyManager.getEngine(),
    activatePolicy: () => policyManager.activate(),
    restrictedExecToolNames: dualViewRuntime.restrictedExecToolNames(),
  });
  const optionalTools = createOptionalTools(runtimeOptions, adfiRuntime, policyManager);
  const tools = runtimeOptions.includeTools === false
    ? optionalTools
    : [...createDualViewTools(runtimeOptions), ...optionalTools];

  const middleware = createMiddleware({
    name: "DualViewMiddleware",
    tools,
    wrapModelCall: (request, handler) => handler({
      ...request,
      systemPrompt: adfiRuntime.prepareModelInput(request.systemPrompt),
    }),
    wrapToolCall: (request, handler) => adfiRuntime.wrapToolCall(
      request,
      (prepared) => dualViewRuntime.wrapToolCall(prepared, handler),
    ),
  });

  return {
    middleware,
    resolveFinalResponse: (message) => adfiRuntime.processFinalResponse(message),
    closeSession: () => {
      adfiRuntime.closeSession();
      policyManager.clearSessionOverlay();
    },
  };
}
