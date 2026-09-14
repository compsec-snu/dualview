#!/usr/bin/env tsx

import {
  commitNativeFileWrite,
  createDataflowRuntime,
  ensureAgentView,
  type HookInput,
  rewriteNativeFileInput,
  toolRequest,
  workspaceFor,
} from "./runtime.js";

const MCP_TOOL_PREFIX = "mcp__plugin_dualview_dualview__";

function transformTextToolResponse(
  response: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof response === "string") return transform(response);

  const transformContent = (content: unknown[]): unknown[] => {
    const textIndexes = content.flatMap((item, index) =>
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && (item as Record<string, unknown>).type === "text"
      && typeof (item as Record<string, unknown>).text === "string"
        ? [index]
        : []
    );
    if (textIndexes.length !== 1) {
      throw new Error(
        `DualView expected one text block in MCP result, found ${textIndexes.length}`,
      );
    }
    const textIndex = textIndexes[0]!;
    return content.map((item, index) => {
      if (index !== textIndex) return item;
      const block = item as Record<string, unknown>;
      return { ...block, text: transform(block.text as string) };
    });
  };

  if (Array.isArray(response)) return transformContent(response);
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return { ...record, content: transformContent(record.content) };
    }
  }
  throw new Error("DualView received an unsupported MCP result shape");
}

const input = JSON.parse(await new Promise<string>((resolvePromise) => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
})) as HookInput;

const event = input.hook_event_name;
const workspace = workspaceFor(input);
const sessionKey = input.session_id ?? `claude-hook-${process.pid}`;
let output: Record<string, unknown> = {};

try {
  const dataflow = createDataflowRuntime(workspace, sessionKey);
  if (event === "SessionStart") {
    ensureAgentView(workspace);
    output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          dataflow.prepareModelInput(undefined),
          "DualView tool mapping:",
          "- Use native Read and Write for file reads and writes.",
          "- Use edit_file instead of native Edit.",
          "- Use the DualView bash, web_fetch, and inspect_symbol MCP tools.",
          "- Do not use native Edit, Bash, WebFetch, or other native tools.",
        ].join("\n"),
      },
    };
  } else if (event === "PreToolUse") {
    const toolName = input.tool_name ?? "";
    if (["Read", "Write"].includes(toolName)) {
      const policyToolName = toolName.toLowerCase();
      const prepared = dataflow.prepareToolCall(toolRequest(
        input.tool_use_id ?? `${policyToolName}-${process.pid}`,
        policyToolName,
        input.tool_input ?? {},
      ));
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            "DualView rewrote the native file path into the Agent File System.",
          updatedInput: rewriteNativeFileInput(
            workspace,
            prepared.toolCall.args,
          ),
        },
      };
    } else if (toolName === "Edit") {
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Use the DualView edit_file MCP tool instead of native Edit.",
        },
      };
    } else if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      const mcpToolName = toolName.slice(MCP_TOOL_PREFIX.length);
      const prepared = dataflow.prepareToolCall(toolRequest(
        input.tool_use_id ?? `${mcpToolName}-${process.pid}`,
        mcpToolName,
        input.tool_input ?? {},
      ));
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            "DualView applied the protected MCP tool input policy.",
          updatedInput: prepared.toolCall.args,
        },
      };
    } else {
      output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "DualView permits native Read/Write and its protected MCP tools only.",
        },
      };
    }
  } else if (event === "PostToolUse") {
    const toolName = input.tool_name ?? "";
    if (toolName === "Read") {
      const response = input.tool_response;
      if (
        response
        && typeof response === "object"
        && !Array.isArray(response)
        && "file" in response
        && response.file
        && typeof response.file === "object"
        && !Array.isArray(response.file)
        && "content" in response.file
        && typeof response.file.content === "string"
      ) {
        dataflow.processToolResult(
          "read",
          input.tool_use_id,
          input.tool_input ?? {},
          response.file.content,
        );
      }
    } else if (toolName === "Write") {
      await commitNativeFileWrite(workspace, toolName, input.tool_use_id);
    } else if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      const mcpToolName = toolName.slice(MCP_TOOL_PREFIX.length);
      if (mcpToolName === "bash" || mcpToolName === "web_fetch") {
        output = {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            updatedToolOutput: transformTextToolResponse(
              input.tool_response,
              (content) => dataflow.processToolResult(
                mcpToolName,
                input.tool_use_id,
                input.tool_input ?? {},
                content,
              ).content,
            ),
          },
        };
      }
    }
  } else if (event === "MessageDisplay") {
    const text = input.message ?? input.text ?? input.delta ?? input.content;
    if (typeof text === "string") {
      output = {
        hookSpecificOutput: {
          hookEventName: "MessageDisplay",
          displayContent: dataflow.processFinalText(text),
        },
      };
    }
  }
} catch (error) {
  const reason = `DualView hook failed closed: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (event === "PreToolUse") {
    output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  } else if (event === "PostToolUse") {
    output = { decision: "block", reason };
  } else {
    output = { systemMessage: reason };
  }
}

process.stdout.write(JSON.stringify(output));
