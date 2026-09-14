import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolRunnableConfig } from "@langchain/core/tools";
import { tool } from "langchain";
import * as z from "zod";

import {
  DualViewDataflowRuntime,
  type DataflowAuditRecord,
  type DualViewDataflowRuntimeOptions,
} from "../dualview/dualview-dataflow-runtime.js";
import {
  createInspectSymbolTool,
  type InspectLLMResult,
  type MissingFieldsMode,
} from "../dualview/dualview-inspect-symbol.js";
import { createDataTrustPolicyTools } from "../dualview/dualview-policy-tools.js";
import type { DataTrustPolicyRuntimeManager } from "../dualview/policy/runtime-policy-manager.js";

import type {
  DualViewToolCallHandler,
  DualViewToolCallRequest,
} from "./index.js";

export type AdfiAuditRecord = DataflowAuditRecord;

export interface InspectSymbolLangChainOptions {
  invokeLLM: (
    prompt: string,
    model: string,
  ) => string | InspectLLMResult | Promise<string | InspectLLMResult>;
  model?: string;
  timeoutMs?: number;
  missingFieldsMode?: MissingFieldsMode;
  scalarTaintMode?: "symbolize" | "inline";
}

export interface AdfiLangChainRuntimeOptions extends DualViewDataflowRuntimeOptions {
  inspectSymbol?: InspectSymbolLangChainOptions;
}

function toolMessageWithContent(message: ToolMessage, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: message.tool_call_id,
    name: message.name,
    id: message.id,
    artifact: message.artifact,
    status: message.status,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

export class AdfiLangChainRuntime extends DualViewDataflowRuntime {
  private readonly inspectSymbolOptions: InspectSymbolLangChainOptions | undefined;

  constructor(options: AdfiLangChainRuntimeOptions) {
    super(options);
    this.inspectSymbolOptions = options.inspectSymbol;
  }

  createInspectSymbolTool() {
    if (!this.inspectSymbolOptions) return null;
    const inspect = createInspectSymbolTool({
      globalSymbols: this.symbols,
      sessionKey: this.sessionKey,
      log: this.options.log ?? {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      auditWrite: (_sessionKey, entry) => this.audit(
        "inspect_symbol",
        entry.toolName ?? "inspect_symbol",
        entry.toolCallId,
        entry.taintAction,
        entry.originalText ?? "",
        entry.modifiedText ?? "",
        entry.extra,
      ),
      model: this.inspectSymbolOptions.model,
      timeoutMs: this.inspectSymbolOptions.timeoutMs,
      missingFieldsMode: this.inspectSymbolOptions.missingFieldsMode,
      scalarTaintMode: this.inspectSymbolOptions.scalarTaintMode,
      dbPath: this.options.symbolDbPath,
      _invokeLLM: this.inspectSymbolOptions.invokeLLM,
    });

    return tool(
      async (params, config?: ToolRunnableConfig) => {
        const toolCallId = config?.toolCall?.id ?? `inspect_${randomUUID()}`;
        const result = await inspect.execute(toolCallId, params);
        const content = result.content;
        if (typeof content === "string") return content;
        return content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
      },
      {
        name: "inspect_symbol",
        description: inspect.description,
        schema: z.object({
          symbols: z.array(z.string()),
          outputSchema: z.record(z.string(), z.string()),
          prompt: z.string(),
        }),
      },
    );
  }

  createPolicyTools(manager: DataTrustPolicyRuntimeManager) {
    const canonicalTools = createDataTrustPolicyTools({
      manager,
      sessionKey: this.sessionKey,
      log: this.options.log ?? {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      auditWrite: (_sessionKey, entry) => this.audit(
        entry.hookType as "policy_add" | "policy_del",
        entry.toolName ?? null,
        entry.toolCallId,
        entry.taintAction,
        entry.originalText ?? "",
        entry.modifiedText ?? "",
        entry.extra,
      ),
    });

    const schemas = [
      z.object({}),
      z.object({
        policyKind: z.literal("category"),
        category: z.enum(["URL", "CHANNEL", "DIR"]),
        list: z.enum(["trusted", "untrusted", "allowlist", "blocklist"]),
        entry: z.string(),
        persist: z.boolean().optional(),
        confirmedByUser: z.boolean(),
      }),
      z.object({
        policyKind: z.literal("category"),
        category: z.enum(["URL", "CHANNEL", "DIR"]),
        list: z.enum(["trusted", "untrusted", "allowlist", "blocklist"]),
        entry: z.string(),
        persist: z.boolean().optional(),
        confirmedByUser: z.boolean(),
      }),
    ] as const;

    return canonicalTools.map((canonical, index) => tool(
      async (params, config?: ToolRunnableConfig) => {
        const toolCallId = config?.toolCall?.id ?? `${canonical.name}_${randomUUID()}`;
        const result = await canonical.execute(toolCallId, params);
        return result.content.map((item) => item.text).join("\n");
      },
      {
        name: canonical.name,
        description: canonical.description,
        schema: schemas[index],
      },
    ));
  }

  processFinalResponse(message: AIMessage): AIMessage {
    if (typeof message.content !== "string") return message;
    return new AIMessage({
      content: this.processFinalText(message.content),
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      id: message.id,
      name: message.name,
      usage_metadata: message.usage_metadata,
    });
  }

  async wrapToolCall<TRequest extends DualViewToolCallRequest, TResult>(
    request: TRequest,
    handler: DualViewToolCallHandler<TRequest, TResult>,
  ): Promise<TResult> {
    const prepared = this.prepareToolCall(request);
    const result = await handler(prepared);
    if (!(result instanceof ToolMessage)) return result;

    const original = typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
    const processed = this.processToolResult(
      request.toolCall.name,
      request.toolCall.id,
      request.toolCall.args,
      original,
    );
    return toolMessageWithContent(result, processed.content) as TResult;
  }
}
