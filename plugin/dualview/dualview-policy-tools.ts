import type {
  DataTrustPolicyRuntimeManager,
  PolicyAddRequest,
  PolicyDeleteRequest,
  PolicyMutationResult,
} from "./policy/runtime-policy-manager.js";

type PluginLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export interface AgentToolLike {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

interface AuditEntry {
  hookType: string;
  toolName?: string | null;
  toolCallId?: string;
  taintAction: string;
  originalText?: string;
  modifiedText?: string;
  extra?: Record<string, unknown>;
}

export interface DataTrustPolicyToolOptions {
  manager: DataTrustPolicyRuntimeManager;
  sessionKey: string;
  log: PluginLogger;
  auditWrite?: (sessionKey: string, entry: AuditEntry, log: PluginLogger | undefined) => void;
}

interface ConfirmedMutationParams {
  confirmedByUser?: boolean;
  persist?: boolean;
}

function toolResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function missingConfirmationResult(toolName: "policy_add" | "policy_del", persist: boolean | undefined) {
  return toolResult({
    ok: false,
    error:
      `${toolName} requires confirmedByUser=true. Explain the Data Trust Policy change to the user first, ` +
      "ask whether it should apply only to this session or be persisted to dualview-policy.yaml, then retry after approval.",
    persist: persist === true,
    confirmedByUser: false,
  });
}

function auditMutation(
  opts: DataTrustPolicyToolOptions,
  toolName: "policy_add" | "policy_del",
  toolCallId: string,
  params: ConfirmedMutationParams & { policyKind?: string },
  result: { ok: boolean; source?: string; changed?: boolean; message?: string },
): void {
  if (!opts.auditWrite) return;
  opts.auditWrite(
    opts.sessionKey,
    {
      hookType: toolName,
      toolName,
      toolCallId,
      taintAction: toolName,
      originalText: JSON.stringify(params),
      modifiedText: JSON.stringify(result),
      extra: {
        persist: params.persist === true,
        policyKind: params.policyKind ?? null,
        source: result.source ?? (params.persist === true ? "yaml" : "session"),
        confirmedByUser: params.confirmedByUser === true,
        changed: result.changed === true,
        ok: result.ok,
        message: result.message,
      },
    },
    opts.log,
  );
}

export function createPolicyListTool(opts: DataTrustPolicyToolOptions): AgentToolLike {
  return {
    name: "policy_list",
    label: "List Data Trust Policy",
    description:
      "Show the current effective Data Trust Policy. This focuses on inbound data classification " +
      "(URL, CHANNEL, DIR category policy and tool inbound trust schemas) and also includes the related " +
      "symbol resolution policy for outbound tool inputs.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
    async execute() {
      return toolResult(opts.manager.list());
    },
  };
}

export function createPolicyAddTool(opts: DataTrustPolicyToolOptions): AgentToolLike {
  return {
    name: "policy_add",
    label: "Add Data Trust Policy",
    description:
      "Add a URL, CHANNEL, or DIR Data Trust Policy list entry at runtime. This tool cannot change " +
      "per-tool policy schemas. Before using it, explain exactly what category entry will be added and why, " +
      "ask the user whether it should be session-only (persist=false) or saved to dualview-policy.yaml " +
      "(persist=true), and call it only after explicit approval with confirmedByUser=true. Calls without " +
      "confirmedByUser=true fail.",
    parameters: {
      type: "object" as const,
      required: ["policyKind", "category", "list", "entry", "confirmedByUser"],
      properties: {
        policyKind: {
          type: "string",
          enum: ["category"],
          description: "Only category policies can be changed at runtime.",
        },
        persist: {
          type: "boolean",
          description: "false applies only to the current runtime/session overlay; true updates dualview-policy.yaml and runtime.",
        },
        confirmedByUser: {
          type: "boolean",
          description: "Must be true only after the user explicitly approved the described policy change.",
        },
        category: {
          type: "string",
          enum: ["URL", "CHANNEL", "DIR"],
          description: "Category for category policies.",
        },
        list: {
          type: "string",
          enum: ["trusted", "untrusted", "allowlist", "blocklist"],
          description: "trusted/allowlist entries become trusted under default UNTRUSTED; untrusted/blocklist entries become untrusted under default TRUSTED.",
        },
        entry: {
          type: "string",
          description: "URL host/path pattern, channel pattern, or directory path to add.",
        },
      },
    },
    async execute(toolCallId: string, params: PolicyAddRequest & ConfirmedMutationParams) {
      if (params.confirmedByUser !== true) {
        return missingConfirmationResult("policy_add", params.persist);
      }
      let result: PolicyMutationResult;
      try {
        result = opts.manager.add(params);
      } catch (err) {
        result = {
          ok: false,
          message: (err as Error).message,
          persist: params.persist === true,
          policyKind: params.policyKind ?? "unknown",
          source: params.persist === true ? "yaml" : "session",
          changed: false,
        };
      }
      auditMutation(opts, "policy_add", toolCallId, params, result);
      return toolResult(result);
    },
  };
}

export function createPolicyDelTool(opts: DataTrustPolicyToolOptions): AgentToolLike {
  return {
    name: "policy_del",
    label: "Delete Data Trust Policy",
    description:
      "Delete a session-overlay or YAML user Data Trust Policy entry. Built-in policy cannot be deleted. " +
      "This tool only removes URL, CHANNEL, or DIR list entries; it cannot delete per-tool policy schemas. " +
      "Before using it, explain exactly what category entry will be removed and why, ask whether the deletion " +
      "should apply only to the session overlay (persist=false) or dualview-policy.yaml (persist=true), and call " +
      "it only after explicit approval with confirmedByUser=true. Calls without confirmedByUser=true fail.",
    parameters: {
      type: "object" as const,
      required: ["policyKind", "category", "list", "entry", "confirmedByUser"],
      properties: {
        policyKind: {
          type: "string",
          enum: ["category"],
          description: "Only category policies can be changed at runtime.",
        },
        persist: {
          type: "boolean",
          description: "false removes only the runtime/session overlay entry; true removes a YAML user policy entry.",
        },
        confirmedByUser: {
          type: "boolean",
          description: "Must be true only after the user explicitly approved the described policy deletion.",
        },
        category: {
          type: "string",
          enum: ["URL", "CHANNEL", "DIR"],
          description: "Category for category policies.",
        },
        list: {
          type: "string",
          enum: ["trusted", "untrusted", "allowlist", "blocklist"],
          description: "List to delete from.",
        },
        entry: {
          type: "string",
          description: "URL host/path pattern, channel pattern, or directory path to remove.",
        },
      },
    },
    async execute(toolCallId: string, params: PolicyDeleteRequest & ConfirmedMutationParams) {
      if (params.confirmedByUser !== true) {
        return missingConfirmationResult("policy_del", params.persist);
      }
      let result: PolicyMutationResult;
      try {
        result = opts.manager.delete(params);
      } catch (err) {
        result = {
          ok: false,
          message: (err as Error).message,
          persist: params.persist === true,
          policyKind: params.policyKind ?? "unknown",
          source: params.persist === true ? "yaml" : "session",
          changed: false,
        };
      }
      auditMutation(opts, "policy_del", toolCallId, params, result);
      return toolResult(result);
    },
  };
}

export function createDataTrustPolicyTools(opts: DataTrustPolicyToolOptions): AgentToolLike[] {
  return [
    createPolicyListTool(opts),
    createPolicyAddTool(opts),
    createPolicyDelTool(opts),
  ];
}
