import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CopilotClient,
  type ModelInfo,
} from "@github/copilot-sdk";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import * as z from "zod";

export interface CopilotChatModelOptions {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  workingDirectory?: string;
}

interface ToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface CopilotModelCall {
  messages: BaseMessage[];
  prompt: string;
  response: string;
}

interface SharedClient {
  client: CopilotClient;
  started: boolean;
}

export interface ModelResponse {
  type: "tool_call" | "final";
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
}

function stringifyMessage(message: BaseMessage): Record<string, unknown> {
  const value: Record<string, unknown> = {
    role: message.getType(),
    content: message.content,
  };
  if (message instanceof AIMessage && message.tool_calls?.length) {
    value.toolCalls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
    }));
  }
  const toolMessage = message as BaseMessage & {
    tool_call_id?: string;
    name?: string;
  };
  if (toolMessage.tool_call_id) {
    value.toolCallId = toolMessage.tool_call_id;
    value.toolName = toolMessage.name;
  }
  return value;
}

function schemaFor(tool: BindToolsInput): unknown {
  const candidate = tool as BindToolsInput & { schema?: z.ZodType };
  if (!candidate.schema) return {};
  try {
    return z.toJSONSchema(candidate.schema);
  } catch {
    return {};
  }
}

function toolSpec(tool: BindToolsInput): ToolSpec {
  const candidate = tool as BindToolsInput & {
    name?: string;
    description?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: unknown;
    };
  };
  if (candidate.function?.name) {
    return {
      name: candidate.function.name,
      description: candidate.function.description,
      parameters: candidate.function.parameters,
    };
  }
  if (!candidate.name) throw new Error("Copilot chat model received a tool without a name");
  return {
    name: candidate.name,
    description: candidate.description,
    parameters: schemaFor(candidate),
  };
}

function jsonObjects(raw: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(raw.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

export function parseCopilotResponse(raw: string): ModelResponse {
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidates = jsonObjects(unfenced);
  if (candidates.length === 0) {
    throw new Error(`Copilot model returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ModelResponse;
      if (parsed.type === "tool_call" || parsed.type === "final") return parsed;
    } catch {
      // Continue to a later complete object that may contain the action.
    }
  }
  throw new Error("Copilot model returned JSON without a supported response type");
}

export class CopilotChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  readonly modelName: string;
  readonly calls: CopilotModelCall[];

  private readonly options: CopilotChatModelOptions;
  private readonly shared: SharedClient;
  private readonly tools: ToolSpec[];

  constructor(
    options: CopilotChatModelOptions = {},
    shared?: SharedClient,
    tools: ToolSpec[] = [],
    calls: CopilotModelCall[] = [],
  ) {
    super({});
    this.options = options;
    this.modelName = options.model ?? "auto";
    this.shared = shared ?? {
      client: new CopilotClient({
        mode: "empty",
        baseDirectory: process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
        workingDirectory: options.workingDirectory,
        useLoggedInUser: true,
        logLevel: "error",
      }),
      started: false,
    };
    this.tools = tools;
    this.calls = calls;
  }

  _llmType(): string {
    return "github-copilot";
  }

  bindTools(
    tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    const bound = new CopilotChatModel(
      this.options,
      this.shared,
      tools.map(toolSpec),
      this.calls,
    );
    return bound.pipe((message) => new AIMessageChunk({
      content: message.content,
      tool_calls: message.tool_calls,
      response_metadata: message.response_metadata,
    }));
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.start();
    return this.shared.client.listModels();
  }

  async close(): Promise<void> {
    if (!this.shared.started) return;
    const errors = await this.shared.client.stop();
    this.shared.started = false;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to stop GitHub Copilot SDK client");
    }
  }

  async completeRaw(
    prompt: string,
    systemMessage = "Follow the prompt and return only the requested output.",
  ): Promise<string> {
    await this.start();
    const session = await this.shared.client.createSession({
      model: this.modelName,
      reasoningEffort: this.options.reasoningEffort,
      workingDirectory: this.options.workingDirectory,
      availableTools: [],
      systemMessage: {
        mode: "replace",
        content: systemMessage,
      },
    });

    try {
      const event = await session.sendAndWait(
        { prompt },
        this.options.timeoutMs ?? 120_000,
      );
      if (!event) throw new Error("GitHub Copilot model returned no assistant message");
      return event.data.content;
    } finally {
      await session.disconnect();
    }
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    await this.start();

    const prompt = [
      "You are the model component inside a LangChain tool-calling agent.",
      "Choose exactly one next action from the supplied tools, or finish.",
      "Do not add optional tool arguments that the user did not request.",
      "Set env.RESTRICTED=1 only when the user explicitly requests restricted or RESTRICTED execution.",
      "A final response must meaningfully summarize the result; never finish with only a one-word acknowledgement.",
      "Return only one JSON object. Do not use markdown.",
      'Tool call format: {"type":"tool_call","name":"TOOL_NAME","args":{...}}',
      'Final format: {"type":"final","content":"FINAL_RESPONSE"}',
      "",
      `TOOLS:\n${JSON.stringify(this.tools)}`,
      "",
      `MESSAGES:\n${JSON.stringify(messages.map(stringifyMessage))}`,
    ].join("\n");

    const session = await this.shared.client.createSession({
      model: this.modelName,
      reasoningEffort: this.options.reasoningEffort,
      workingDirectory: this.options.workingDirectory,
      availableTools: [],
      systemMessage: {
        mode: "replace",
        content: "Act only as a JSON tool-selection model for the enclosing LangChain agent.",
      },
    });

    try {
      const event = await session.sendAndWait(
        { prompt },
        this.options.timeoutMs ?? 120_000,
      );
      if (!event) throw new Error("GitHub Copilot model returned no assistant message");
      const parsed = parseCopilotResponse(event.data.content);
      if (parsed.type === "tool_call" && parsed.args) {
        const requestedRestricted = messages
          .filter((message) => message.getType() === "human")
          .some((message) => /\b(?:restricted|RESTRICTED)\b/.test(String(message.content)));
        const env = parsed.args.env;
        if (
          !requestedRestricted
          && env
          && typeof env === "object"
          && !Array.isArray(env)
          && (env as Record<string, unknown>).RESTRICTED === "1"
        ) {
          const sanitizedEnv = { ...(env as Record<string, unknown>) };
          delete sanitizedEnv.RESTRICTED;
          parsed.args = {
            ...parsed.args,
            ...(Object.keys(sanitizedEnv).length > 0 ? { env: sanitizedEnv } : {}),
          };
          if (Object.keys(sanitizedEnv).length === 0) delete parsed.args.env;
        }
      }
      this.calls.push({
        messages: [...messages],
        prompt,
        response: event.data.content,
      });

      const message = parsed.type === "tool_call"
        ? new AIMessage({
            content: "",
            tool_calls: [{
              id: `copilot_${randomUUID()}`,
              name: parsed.name ?? "",
              args: parsed.args ?? {},
              type: "tool_call",
            }],
            response_metadata: { model: this.modelName, provider: "github-copilot" },
          })
        : new AIMessage({
            content: parsed.content ?? "",
            response_metadata: { model: this.modelName, provider: "github-copilot" },
          });

      return {
        generations: [{ text: String(message.content), message }],
      };
    } finally {
      await session.disconnect();
    }
  }

  private async start(): Promise<void> {
    if (this.shared.started) return;
    await this.shared.client.start();
    this.shared.started = true;
  }
}
