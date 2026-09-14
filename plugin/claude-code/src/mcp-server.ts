import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createInspectSymbolTool } from "dualview/dualview-inspect-symbol.js";
import { loadSymbolMap } from "dualview/dualview-symbol-table.js";
import { dualviewAgentViewPathFor } from "dualview/dualview-paths.js";
import { z } from "zod";

import {
  appendAuditRecord,
  createFilesystemRuntime,
  log,
  runArgv,
  runShell,
  symbolDbPathFor,
  toolRequest,
  workspaceFor,
} from "./runtime.js";

const execFileAsync = promisify(execFile);
const workspace = workspaceFor();
const sessionKey = process.env.DUALVIEW_SESSION_KEY
  ?? `claude-mcp-${process.pid}-${randomUUID()}`;
const symbolDbPath = symbolDbPathFor(workspace);
const symbols = loadSymbolMap(symbolDbPath);
const filesystem = createFilesystemRuntime(workspace, sessionKey);
const agentView = dualviewAgentViewPathFor(workspace);
await SandboxManager.initialize({
  filesystem: {
    denyRead: [homedir(), workspace],
    allowRead: [agentView],
    denyWrite: [homedir(), workspace],
    allowWrite: [agentView, tmpdir()],
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
});

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function callId(requestId: string | number): string {
  return `claude-mcp-${requestId}`;
}

async function executeBash(
  id: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const original = toolRequest(id, "bash", args);
  try {
    const raw = await filesystem.wrapToolCall(
      original,
      (rewritten) => {
        const command = rewritten.toolCall.args.command;
        const workdir = rewritten.toolCall.args.workdir;
        const env = rewritten.toolCall.args.env;
        if (typeof command !== "string" || typeof workdir !== "string") {
          throw new Error("DualView bash requires command and workdir");
        }
        const normalizedEnv = env && typeof env === "object" && !Array.isArray(env)
            ? Object.fromEntries(
                Object.entries(env).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : undefined;
        if (normalizedEnv?.RESTRICTED === "1") {
          return SandboxManager.wrapWithSandboxArgv(
            command,
            "/bin/sh",
            undefined,
            undefined,
            workdir,
            { commandId: id, commandText: command },
          ).then((wrapped) => runArgv(wrapped.argv, workdir, normalizedEnv));
        }
        return runShell(command, workdir, normalizedEnv);
      },
    );
    return textResult(raw);
  } catch (error) {
    log.error(
      `Claude MCP bash failed (${error instanceof Error ? error.name : typeof error})`,
    );
    return textResult(
      "Error: DualView bash failed before producing a mediated result.",
      true,
    );
  }
}

async function fetchBounded(
  url: string,
  maxChars: number,
): Promise<Record<string, unknown>> {
  const fixtureMap = process.env.DUALVIEW_FETCH_URL_MAP
    ? JSON.parse(process.env.DUALVIEW_FETCH_URL_MAP) as Record<string, string>
    : {};
  const requestUrl = fixtureMap[url] ?? url;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.DUALVIEW_FETCH_TIMEOUT_MS ?? 30_000),
  );
  try {
    const response = await fetch(requestUrl, {
      redirect: "follow",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    if (reader) {
      while (text.length <= maxChars) {
        const chunk = await reader.read();
        if (chunk.done) {
          text += decoder.decode();
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > maxChars) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    const declared = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );
    return {
      url,
      finalUrl: fixtureMap[url] ? url : response.url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      truncated,
      length: Math.min(text.length, maxChars),
      rawLength: Number.isFinite(declared) ? declared : text.length,
      text: text.slice(0, maxChars),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeInspectLLM(prompt: string, model: string): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  const { stdout } = await execFileAsync("claude", args, {
    env: { ...process.env, DUALVIEW_INSPECT_CHILD: "1" },
    timeout: Number(process.env.DUALVIEW_INSPECT_TIMEOUT_MS ?? 60_000),
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { result?: string };
  if (typeof parsed.result !== "string") {
    throw new Error("Claude inspect session returned no result");
  }
  return parsed.result;
}

const inspect = createInspectSymbolTool({
  api: {},
  globalSymbols: symbols,
  sessionKey,
  log,
  subagent: "cli",
  model: process.env.DUALVIEW_INSPECT_MODEL ?? "haiku",
  scalarTaintMode: process.env.DUALVIEW_SCALAR_TAINT_MODE === "inline"
    ? "inline"
    : "symbolize",
  dbPath: symbolDbPath,
  auditWrite: (auditSessionKey, entry) => appendAuditRecord({
    sessionKey: auditSessionKey,
    ...entry,
  }),
  _invokeLLM: invokeInspectLLM,
});

const server = new McpServer({ name: "dualview", version: "0.2.0" });

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

server.registerTool(
  "edit_file",
  {
    description: "Replace text through the DualView Agent File System.",
    inputSchema: {
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
  },
  async (args, extra) => {
    const id = callId(extra.requestId);
    const original = toolRequest(id, "edit_file", args);
    try {
      const result = await filesystem.wrapToolCall(original, async (
        rewritten,
        context,
      ) => {
        const {
          path,
          old_string: oldString,
          new_string: newString,
          replace_all: replaceAll,
        } = rewritten.toolCall.args;
        if (
          typeof path !== "string"
          || typeof oldString !== "string"
          || typeof newString !== "string"
        ) {
          throw new Error("edit_file requires path, old_string, and new_string");
        }
        const handle = await open(
          path,
          constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const [actualPath, actualRoot, descriptorStat] = await Promise.all([
            realpath(path),
            realpath(context.trustedRoot),
            handle.stat(),
          ]);
          if (!isWithin(actualRoot, actualPath)) {
            throw new Error(`DualView edit path escapes Agent File System: ${path}`);
          }
          const pathStat = await stat(actualPath);
          if (
            descriptorStat.dev !== pathStat.dev
            || descriptorStat.ino !== pathStat.ino
          ) {
            throw new Error(`DualView edit path changed during validation: ${path}`);
          }
          if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) {
            throw new Error(
              `DualView edit requires a regular file with one hard link: ${path}`,
            );
          }

          const current = await handle.readFile("utf8");
          if (!current.includes(oldString)) {
            throw new Error("edit_file old_string was not found");
          }
          const updated = replaceAll
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString);
          const content = Buffer.from(updated, "utf8");
          await handle.write(content, 0, content.length, 0);
          await handle.truncate(content.length);
          await handle.sync();
          return `Edited ${path}`;
        } finally {
          await handle.close();
        }
      });
      return textResult(result);
    } catch (error) {
      log.error(
        `Claude MCP edit_file failed (${
          error instanceof Error ? error.name : typeof error
        })`,
      );
      return textResult(
        "Error: DualView edit_file failed before completing the edit.",
        true,
      );
    }
  },
);

server.registerTool(
  "bash",
  {
    description:
      "Run a command through DualView. Set env.RESTRICTED=1 for trusted, sandboxed local execution.",
    inputSchema: {
      command: z.string(),
      workdir: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    },
  },
  (args, extra) => executeBash(callId(extra.requestId), args),
);

server.registerTool(
  "web_fetch",
  {
    description: "Fetch bounded web content through DualView.",
    inputSchema: {
      url: z.string().url(),
      max_chars: z.number().int().positive().max(1_000_000).optional(),
    },
  },
  async (args, extra) => {
    const id = callId(extra.requestId);
    const original = toolRequest(id, "web_fetch", args);
    try {
      const url = original.toolCall.args.url;
      if (typeof url !== "string") throw new Error("web_fetch requires url");
      const value = await fetchBounded(
        url,
        typeof args.max_chars === "number" ? args.max_chars : 100_000,
      );
      const raw = JSON.stringify(value);
      return textResult(raw);
    } catch (error) {
      log.error(
        `Claude MCP web_fetch failed (${
          error instanceof Error ? error.name : typeof error
        })`,
      );
      return textResult(
        "Error: DualView web_fetch failed before producing a mediated result.",
        true,
      );
    }
  },
);

server.registerTool(
  "inspect_symbol",
  {
    description: inspect.description,
    inputSchema: {
      symbols: z.array(z.string()),
      outputSchema: z.record(z.string(), z.string()),
      prompt: z.string(),
    },
  },
  async (args, extra) => {
    const result = await inspect.execute(callId(extra.requestId), args);
    return result as CallToolResult;
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const close = (): void => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
