import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { buildSymbolSystemPrompt, getActiveFormat, unescapeSymbols } from "./dualview-symbol-format.js";
import {
  allocateSymbol,
  hasSymbols,
  loadSymbolMap,
  type SymbolMap,
} from "./dualview-symbol-table.js";
import { createPolicyEngine, type PolicyEngine } from "./policy/policy-engine.js";
import { isSymbolicExec } from "./policy/exec-identifier.js";
import {
  prepareExecArgvSymbolResolution,
  type ExecArgvSymbolResolution,
} from "./policy/exec-argv-mode.js";
import { expandScriptFileCommandForDetection } from "./policy/script-file-command-expansion.js";
import { shellSingleQuote } from "./policy/shell-symbol-resolution.js";
import {
  detectUntrustedCommandExecutionPatterns,
  detectUntrustedCommandExecutionPatternsFromExecArgvResolution,
  type UntrustedCommandExecutionMatch,
} from "./policy/untrusted-command-execution.js";
import { dualviewWorkspaceDirFor } from "./dualview-paths.js";
import { selectSchemaBranch, summarizeToolTrust, walkSchema } from "./policy/resolve-schema.js";
import { getToolInboundSpec } from "./policy/tool-inbound.js";
import { TOOL_INPUT_FIELD_POLICY, TOOL_INPUT_RESOLVE } from "./policy/tool-outbound.js";

export interface DataflowLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface DataflowToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DataflowToolCallRequest {
  toolCall: DataflowToolCall;
}

export interface DataflowAuditRecord {
  ts: string;
  hookType:
    | "before_model"
    | "before_tool_call"
    | "transform_tool_result"
    | "after_agent"
    | "inspect_symbol"
    | "policy_add"
    | "policy_del";
  sessionKey: string;
  toolName: string | null;
  toolCallId: string | null;
  taintAction: string;
  originalLen: number;
  modifiedLen: number;
  originalHead: string;
  modifiedHead: string;
  [key: string]: unknown;
}

export interface DualViewDataflowRuntimeOptions {
  workspacePath: string;
  symbolDbPath?: string;
  policyPath?: string;
  sessionKey?: string;
  inboundDefault?: "TRUSTED" | "UNTRUSTED";
  outboundDefault?: "resolve" | "not_resolve";
  toolInputResolve?: Record<string, boolean>;
  log?: DataflowLogger;
  onAudit?: (record: DataflowAuditRecord) => void;
  symbolMap?: SymbolMap;
  policyEngine?: PolicyEngine | (() => PolicyEngine);
  restrictedExecToolNames?: readonly string[];
  auditToolNames?: Readonly<Record<string, string>>;
  policyToolNames?: Readonly<Record<string, string>>;
  activatePolicy?: () => void;
}

export interface ProcessedToolResult {
  content: string;
  action: "classify_trusted" | "symbolize";
  symbolCount: number;
}

const NOOP_LOGGER: DataflowLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function deepResolveSymbols(value: unknown, symbols: Map<string, { value: string }>): unknown {
  if (typeof value === "string") {
    const normalized = unescapeSymbols(value);
    const pattern = getActiveFormat().pattern;
    pattern.lastIndex = 0;
    return normalized.replace(pattern, (match) => symbols.get(match)?.value ?? match);
  }
  if (Array.isArray(value)) return value.map((item) => deepResolveSymbols(item, symbols));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepResolveSymbols(item, symbols)]),
    );
  }
  return value;
}

function writeExecArgvRunnerSpec(
  resolution: ExecArgvSymbolResolution,
  env: unknown,
): string {
  const specPath = join(
    tmpdir(),
    `dualview-langchain-exec-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.json`,
  );
  const normalizedEnv = env && typeof env === "object" && !Array.isArray(env)
    ? Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  writeFileSync(specPath, JSON.stringify({
    command: resolution.argv[0] ?? "",
    args: resolution.argv.slice(1),
    program: resolution.program,
    env: normalizedEnv,
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return specPath;
}

function execArgvRunnerCommand(specPath: string): string {
  return [
    shellSingleQuote(process.execPath),
    shellSingleQuote(join(import.meta.dirname, "exec-argv-runner.mjs")),
    shellSingleQuote(specPath),
  ].join(" ");
}

function parsePath(path: string): Array<string | number> {
  if (!path) return [];
  const parts: Array<string | number> = [];
  for (const match of path.matchAll(/([^.[]+)|\[(\d+)\]/g)) {
    parts.push(match[1] ?? Number(match[2]));
  }
  return parts;
}

function setPath(root: unknown, path: string, value: unknown): unknown {
  const parts = parsePath(path);
  if (parts.length === 0) return value;
  let cursor = root as Record<string | number, unknown>;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string | number, unknown>;
  }
  cursor[parts.at(-1)!] = value;
  return root;
}

export class DualViewDataflowRuntime {
  readonly sessionKey: string;

  protected readonly options: DualViewDataflowRuntimeOptions;
  protected readonly symbols: SymbolMap;
  private readonly policySource: PolicyEngine | (() => PolicyEngine);
  private readonly restrictedExecToolNames: ReadonlySet<string>;

  constructor(options: DualViewDataflowRuntimeOptions) {
    this.options = options;
    const log = options.log ?? NOOP_LOGGER;
    this.sessionKey = options.sessionKey ?? `dualview:${randomUUID()}`;
    this.policySource = options.policyEngine ?? createPolicyEngine(
      options.policyPath,
      options.workspacePath,
      log,
    );
    this.symbols = options.symbolMap
      ?? (options.symbolDbPath ? loadSymbolMap(options.symbolDbPath) : { symbols: new Map() });
      this.restrictedExecToolNames = new Set(options.restrictedExecToolNames ?? []);
  }

  private isRestrictedExec(toolName: string, args: Record<string, unknown>): boolean {
      return this.restrictedExecToolNames.has(toolName) && isSymbolicExec(args);
  }

  private policyToolName(toolName: string): string {
      if (this.restrictedExecToolNames.has(toolName)) return "exec";
      return this.options.policyToolNames?.[toolName] ?? toolName;
  }

  private auditToolName(toolName: string): string {
      return this.options.auditToolNames?.[toolName] ?? toolName;
  }

  prepareModelInput(systemPrompt: string | undefined): string {
    const guidance = buildSymbolSystemPrompt(getActiveFormat(), {
      restrictedExec: this.restrictedExecToolNames.size > 0,
      restrictedExecToolName: this.restrictedExecToolNames.values().next().value,
    });
    const prepared = systemPrompt ? `${systemPrompt}\n\n${guidance}` : guidance;
    this.audit("before_model", null, null, "append_symbol_guidance", systemPrompt ?? "", prepared);
    return prepared;
  }

  prepareToolCall<TRequest extends DataflowToolCallRequest>(request: TRequest): TRequest {
    this.options.activatePolicy?.();
    const { name, args, id } = request.toolCall;
    if (this.options.symbolDbPath && hasSymbols(JSON.stringify(args))) {
      const persisted = loadSymbolMap(this.options.symbolDbPath);
      for (const [symbol, entry] of persisted.symbols) {
        if (!this.symbols.symbols.has(symbol)) this.symbols.symbols.set(symbol, entry);
      }
    }
    const restrictedExec = this.isRestrictedExec(name, args);
    const baseAuditToolName = this.auditToolName(name);
    const auditToolName = restrictedExec ? `${baseAuditToolName}_sym` : baseAuditToolName;
    const policyToolName = this.policyToolName(name);
    const resolveMap = { ...TOOL_INPUT_RESOLVE, ...this.options.toolInputResolve };
    const isSpecified = Object.prototype.hasOwnProperty.call(resolveMap, policyToolName)
      || Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELD_POLICY, policyToolName);
    const shouldResolve = !restrictedExec && (isSpecified
      ? resolveMap[policyToolName] === true
      : this.options.outboundDefault === "resolve");

    this.audit("before_tool_call", auditToolName, id, "tool_observed", JSON.stringify(args), JSON.stringify(args));
    if (!restrictedExec && policyToolName === "exec" && typeof args.command === "string") {
      const workspace = resolve(this.options.workspacePath);
      const requestedWorkdir = typeof args.workdir === "string"
        ? resolve(workspace, args.workdir)
        : workspace;
      const expansion = expandScriptFileCommandForDetection({
        command: args.command,
        workdir: requestedWorkdir,
        trustedPathFor: (scriptPath) => {
          const rel = relative(workspace, scriptPath);
          if (rel.startsWith("..") || isAbsolute(rel)) return null;
          const trusted = join(dualviewWorkspaceDirFor(workspace), "agentview", rel);
          return existsSync(trusted) ? trusted : null;
        },
      });
      if (expansion) {
        const matches = detectUntrustedCommandExecutionPatterns(
          expansion.normalizedCommand,
          { action: "audit" },
        );
        this.auditUntrustedCommand(
          auditToolName,
          id,
          args.command,
          matches,
          {
            commandAnalysisSource: "script_file",
            scriptFileExecution: expansion,
          },
        );
      }

      const argvResolution = shouldResolve
        ? prepareExecArgvSymbolResolution(args.command, this.symbols.symbols, {
            resolveSymbols: true,
          })
        : null;
      if (argvResolution) {
        const matches = detectUntrustedCommandExecutionPatternsFromExecArgvResolution(
          argvResolution,
          { action: "audit" },
        );
        this.auditUntrustedCommand(auditToolName, id, args.command, matches, {
          commandAnalysisSource: "exec_argv",
          executionMode: "argv",
          mode: argvResolution.mode,
        });
        const specPath = writeExecArgvRunnerSpec(argvResolution, args.env);
        const runnerCommand = execArgvRunnerCommand(specPath);
        const modified = { ...args, command: runnerCommand };
        this.audit(
          "before_tool_call",
          auditToolName,
          id,
          "exec_argv_symbol_resolution",
          JSON.stringify({ command: args.command }),
          JSON.stringify({ command: runnerCommand }),
          {
            executionMode: "argv",
            mode: argvResolution.mode,
            specPath,
          },
        );
        this.audit(
          "before_tool_call",
          auditToolName,
          id,
          "resolve_symbol",
          JSON.stringify({ command: args.command }),
          JSON.stringify({ command: runnerCommand }),
          {
            symbolCount: argvResolution.decisions.filter((decision) =>
              decision.action === "resolved"
            ).length,
            executionMode: "argv",
            mode: argvResolution.mode,
          },
        );
        return {
          ...request,
          toolCall: {
            ...request.toolCall,
            args: modified,
          },
        };
      }
    }
    if (!shouldResolve || this.symbols.symbols.size === 0) return request;

    const resolved = deepResolveSymbols(args, this.symbols.symbols) as Record<string, unknown>;
    if (JSON.stringify(resolved) === JSON.stringify(args)) return request;

    this.audit(
      "before_tool_call",
      auditToolName,
      id,
      "resolve_symbol",
      JSON.stringify(args),
      JSON.stringify(resolved),
    );
    return {
      ...request,
      toolCall: {
        ...request.toolCall,
        args: resolved,
      },
    };
  }

  private auditUntrustedCommand(
    toolName: string,
    toolCallId: string | undefined,
    command: string,
    matches: UntrustedCommandExecutionMatch[],
    extra: Record<string, unknown>,
  ): void {
    if (matches.length === 0) return;
    this.audit(
      "before_tool_call",
      toolName,
      toolCallId,
      "untrusted_command_execution_pattern",
      JSON.stringify({ command }),
      JSON.stringify({ command }),
      {
        patterns: [...new Set(matches.map((match) => match.patternId))],
        symbols: [...new Set(matches.flatMap((match) => match.symbols))],
        action: "audit",
        userApproval: {
          status: "human_approved",
          assumed: true,
          interactive: false,
          note: "Audit-only untrusted command execution pattern.",
        },
        ...extra,
        matches,
      },
    );
  }

  processToolResult(
    toolName: string,
    toolCallId: string | undefined,
    params: Record<string, unknown>,
    content: string,
  ): ProcessedToolResult {
    this.options.activatePolicy?.();
    const restrictedExec = this.isRestrictedExec(toolName, params);
    const baseAuditToolName = this.auditToolName(toolName);
    const auditToolName = restrictedExec ? `${baseAuditToolName}_sym` : baseAuditToolName;
    if (restrictedExec) {
      this.audit(
        "transform_tool_result",
        auditToolName,
        toolCallId,
        "classify_trusted",
        content,
        content,
        {
          trust: "TRUSTED",
          taintMode: "symbolize",
          hadSchema: true,
        },
      );
      return { content, action: "classify_trusted", symbolCount: 0 };
    }

    const spec = getToolInboundSpec(this.policyToolName(toolName));
    if (!spec) {
      if (this.options.inboundDefault !== "UNTRUSTED") {
        return { content, action: "classify_trusted", symbolCount: 0 };
      }
      return this.symbolizeWholeResult(toolName, toolCallId, content);
    }

    const schema = selectSchemaBranch(spec, params);
    if (!schema || summarizeToolTrust(spec, params, this.policyEngine()) === "TRUSTED") {
      this.audit(
        "transform_tool_result",
        auditToolName,
        toolCallId,
        "classify_trusted",
        content,
        content,
      );
      return { content, action: "classify_trusted", symbolCount: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.symbolizeWholeResult(toolName, toolCallId, content);
    }

    let transformed = structuredClone(parsed);
    let symbolCount = 0;
    const symbolsCreated: Array<{ name: string; field: string | null; value: string }> = [];
    walkSchema(schema, parsed, params, this.policyEngine(), {
      onLeaf: ({ path, value, decision }) => {
        if (decision.trust !== "UNTRUSTED") return;
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        const symbol = allocateSymbol(
          this.symbols,
          {
            tool: toolName,
            field: path || undefined,
            value: raw,
            sessionKey: this.sessionKey,
            callId: toolCallId,
          },
          this.options.symbolDbPath,
        );
        transformed = setPath(transformed, path, symbol);
        symbolCount += 1;
        symbolsCreated.push({
          name: symbol,
          field: path || null,
          value: raw,
        });
      },
    });

    const modified = JSON.stringify(transformed, null, 2);
    const action = symbolCount > 0 ? "symbolize" : "classify_trusted";
    this.audit("transform_tool_result", auditToolName, toolCallId, action, content, modified, {
      symbolCount,
      trust: symbolCount > 0 ? "UNTRUSTED" : "TRUSTED",
      taintMode: "symbolize",
      hadSchema: true,
      ...(toolName === "web_fetch" && params.url ? { origin: `url:${params.url}` } : {}),
      ...(symbolsCreated.length > 0 ? { symbolsCreated } : {}),
    });
    return { content: symbolCount > 0 ? modified : content, action, symbolCount };
  }

  processFinalText(content: string): string {
    let persistedResolved = content;
    if (
      this.options.symbolDbPath
      && (hasSymbols(content) || hasSymbols(unescapeSymbols(content)))
    ) {
      const persisted = loadSymbolMap(this.options.symbolDbPath);
      persistedResolved = deepResolveSymbols(content, persisted.symbols) as string;
      for (const [symbol, entry] of persisted.symbols) {
        if (!this.symbols.symbols.has(symbol)) this.symbols.symbols.set(symbol, entry);
      }
    }
    const resolved = this.resolveText(persistedResolved);
    this.audit("after_agent", null, null, "resolve_symbol", content, resolved);
    return resolved;
  }

  closeSession(): void {
    for (const [name, entry] of this.symbols.symbols) {
      if (entry.session_key === this.sessionKey) this.symbols.symbols.delete(name);
    }
  }

  private policyEngine(): PolicyEngine {
    return typeof this.policySource === "function" ? this.policySource() : this.policySource;
  }

  private resolveText(content: string): string {
    if (!hasSymbols(content) && !hasSymbols(unescapeSymbols(content))) return content;
    let resolved = deepResolveSymbols(content, this.symbols.symbols) as string;
    if (resolved !== content || !this.options.symbolDbPath) return resolved;

    const persisted = loadSymbolMap(this.options.symbolDbPath);
    for (const [name, entry] of persisted.symbols) {
      if (!this.symbols.symbols.has(name)) this.symbols.symbols.set(name, entry);
    }
    resolved = deepResolveSymbols(content, this.symbols.symbols) as string;
    return resolved;
  }

  private symbolizeWholeResult(
    toolName: string,
    toolCallId: string | undefined,
    content: string,
  ): ProcessedToolResult {
    const symbol = allocateSymbol(
      this.symbols,
      {
        tool: toolName,
        value: content,
        sessionKey: this.sessionKey,
        callId: toolCallId,
      },
      this.options.symbolDbPath,
    );
    this.audit(
      "transform_tool_result",
      this.auditToolName(toolName),
      toolCallId,
      "symbolize",
      content,
      symbol,
      {
      symbolCount: 1,
      trust: "UNTRUSTED",
      taintMode: "symbolize",
      hadSchema: false,
      symbolsCreated: [{ name: symbol, field: null, value: content }],
      },
    );
    return { content: symbol, action: "symbolize", symbolCount: 1 };
  }

  protected audit(
    hookType: DataflowAuditRecord["hookType"],
    toolName: string | null,
    toolCallId: string | null | undefined,
    taintAction: string,
    original: string,
    modified: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.options.onAudit?.({
      ts: new Date().toISOString(),
      hookType,
      sessionKey: this.sessionKey,
      toolName,
      toolCallId: toolCallId ?? null,
      taintAction,
      originalLen: original.length,
      modifiedLen: modified.length,
      originalHead: original,
      modifiedHead: modified,
      ...extra,
    });
  }
}
