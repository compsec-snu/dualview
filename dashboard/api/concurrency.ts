import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlFile, resolveAuditDir, resolveWsDir } from "./utils.js";
import { getConversationByAgent } from "./workspace.js";

interface ConcurrencyTimelineEvent {
  at: number;
  lane: string;
  event: string;
  detail: string;
  from?: string;
  to?: string;
  toolName?: string;
  toolCallId?: string;
  taintAction?: string;
  files?: string[];
  syncedFiles?: string[];
  skippedDirtyFiles?: string[];
  trustedBranchHead?: string;
  isError?: boolean;
  sourceOrder: number;
}

const HUMAN_FILE_EVENTS = ["write", "append", "replace", "atomic replace", "rename", "move", "delete"];

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function conciseTimelineText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? compact.slice(0, maxLength - 1) + "…" : compact;
}

function toolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "target_path"]) {
    if (typeof record[key] === "string") return path.basename(record[key]);
  }
  return "";
}

function timelineEventPriority(entry: ConcurrencyTimelineEvent): number {
  if (entry.lane === "agent") {
    if (entry.event === "User prompt") return 10;
    if (entry.event === "Tool call") return 20;
    if (entry.event === "Tool response") return 70;
    if (entry.event === "AI response") return 90;
  }
  if (entry.event === "plugin paused") return 40;
  if (HUMAN_FILE_EVENTS.includes(entry.event)) return 50;
  if (entry.event === "plugin resumed") return 60;
  if (entry.lane === "dualview") return entry.event === "transform_tool_result" ? 65 : 30;
  return 80;
}

function auditTimelineEvents(
  auditDir: string,
  startAt: number,
  endAt: number,
  nextOrder: () => number,
): ConcurrencyTimelineEvent[] {
  const events: ConcurrencyTimelineEvent[] = [];
  if (!fs.existsSync(auditDir)) return events;
  const files = fs.readdirSync(auditDir)
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".llm-requests.jsonl"))
    .sort();
  for (const file of files) {
    for (const rawEntry of parseJsonlFile(path.join(auditDir, file))) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      if (typeof entry.ts !== "string" || typeof entry.hookType !== "string") continue;
      const at = Date.parse(entry.ts);
      if (!Number.isFinite(at) || at < startAt || at > endAt) continue;
      events.push({
        at,
        lane: "dualview",
        event: entry.hookType,
        detail: "",
        sourceOrder: nextOrder(),
        ...(typeof entry.toolName === "string" ? { toolName: entry.toolName } : {}),
        ...(typeof entry.toolCallId === "string" ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.taintAction === "string" ? { taintAction: entry.taintAction } : {}),
        ...(Array.isArray(entry.files)
          ? { files: entry.files.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(Array.isArray(entry.syncedFiles)
          ? { syncedFiles: entry.syncedFiles.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(Array.isArray(entry.skippedDirtyFiles)
          ? { skippedDirtyFiles: entry.skippedDirtyFiles.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(typeof entry.trustedBranchHead === "string"
          ? { trustedBranchHead: entry.trustedBranchHead }
          : {}),
      });
    }
  }
  return events;
}

function agentTimelineEvents(
  batchId: string,
  wsId: string,
  startAt: number,
  endAt: number,
  nextOrder: () => number,
): ConcurrencyTimelineEvent[] {
  const events: ConcurrencyTimelineEvent[] = [];
  for (const rawEntry of getConversationByAgent(batchId, wsId, "main")) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const at = typeof msg.timestamp === "number"
      ? msg.timestamp
      : typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : NaN;
    if (!Number.isFinite(at) || at < startAt || at > endAt) continue;

    if (msg.role === "user") {
      events.push({
        at,
        lane: "agent",
        event: "User prompt",
        detail: conciseTimelineText(messageText(msg.content)),
        sourceOrder: nextOrder(),
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const item = block as Record<string, unknown>;
        if (item.type === "toolCall" && typeof item.name === "string") {
          events.push({
            at,
            lane: "agent",
            event: "Tool call",
            detail: toolTarget(item.arguments),
            toolName: item.name,
            ...(typeof item.id === "string" ? { toolCallId: item.id } : {}),
            sourceOrder: nextOrder(),
          });
        } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          events.push({
            at,
            lane: "agent",
            event: "AI response",
            detail: conciseTimelineText(item.text),
            sourceOrder: nextOrder(),
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      events.push({
        at,
        lane: "agent",
        event: "Tool response",
        detail: conciseTimelineText(messageText(msg.content)),
        ...(typeof msg.toolName === "string" ? { toolName: msg.toolName } : {}),
        ...(typeof msg.toolCallId === "string" ? { toolCallId: msg.toolCallId } : {}),
        ...(typeof msg.isError === "boolean" ? { isError: msg.isError } : {}),
        sourceOrder: nextOrder(),
      });
    }
  }
  return events;
}

export function getConcurrencyTimeline(batchId: string, wsId: string): Array<{
  order: number;
  at: number;
  elapsedMs: number;
  lane: string;
  event: string;
  detail: string;
  from?: string;
  to?: string;
  toolName?: string;
  toolCallId?: string;
  taintAction?: string;
  files?: string[];
  syncedFiles?: string[];
  skippedDirtyFiles?: string[];
  trustedBranchHead?: string;
  isError?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
}> {
  const wsDir = resolveWsDir(batchId, wsId);
  if (!wsDir) return [];

  let sourceOrder = 0;
  const nextOrder = () => sourceOrder++;
  const rawTimelineEntries = parseJsonlFile(path.join(wsDir, "concurrency-barriers", "timeline.jsonl"))
    .filter((entry): entry is Record<string, unknown> => (
      typeof entry === "object"
      && entry !== null
      && typeof (entry as Record<string, unknown>).at === "number"
      && typeof (entry as Record<string, unknown>).lane === "string"
      && typeof (entry as Record<string, unknown>).event === "string"
    ));
  if (rawTimelineEntries.length === 0) return [];

  const startAt = Math.min(...rawTimelineEntries.map((entry) => entry.at as number));
  const endAt = Math.max(...rawTimelineEntries.map((entry) => entry.at as number));
  const timelineEntries: ConcurrencyTimelineEvent[] = rawTimelineEntries
    .filter((entry) => (
      entry.event === "plugin paused"
      || entry.event === "plugin resumed"
      || (entry.lane === "human" && HUMAN_FILE_EVENTS.includes(entry.event as string))
    ))
    .map((entry) => ({
      at: entry.at as number,
      lane: entry.event === "plugin paused" || entry.event === "plugin resumed"
        ? "dualview"
        : "human",
      event: entry.event as string,
      detail: typeof entry.detail === "string" ? entry.detail : "",
      ...(typeof entry.from === "string" ? { from: entry.from } : {}),
      ...(typeof entry.to === "string" ? { to: entry.to } : {}),
      sourceOrder: nextOrder(),
    }));
  const auditDir = resolveAuditDir(path.join(wsDir, "logs", "dualview-audit"));
  const auditEvents = auditTimelineEvents(auditDir, startAt, endAt, nextOrder);
  const agentEvents = agentTimelineEvents(batchId, wsId, startAt, endAt, nextOrder);
  const entries = [...timelineEntries, ...auditEvents, ...agentEvents]
    .sort((a, b) => (
      a.at - b.at
      || timelineEventPriority(a) - timelineEventPriority(b)
      || a.sourceOrder - b.sourceOrder
    ));
  if (entries.length === 0) return [];

  const origin = entries[0]!.at;
  return entries.map((entry, index) => ({
    order: index + 1,
    at: entry.at,
    elapsedMs: entry.at - origin,
    lane: entry.lane,
    event: entry.event,
    detail: entry.detail,
    ...(entry.from ? { from: entry.from } : {}),
    ...(entry.to ? { to: entry.to } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.taintAction ? { taintAction: entry.taintAction } : {}),
    ...(entry.files ? { files: entry.files } : {}),
    ...(entry.syncedFiles ? { syncedFiles: entry.syncedFiles } : {}),
    ...(entry.skippedDirtyFiles ? { skippedDirtyFiles: entry.skippedDirtyFiles } : {}),
    ...(entry.trustedBranchHead ? { trustedBranchHead: entry.trustedBranchHead } : {}),
    ...(typeof entry.isError === "boolean" ? { isError: entry.isError } : {}),
    ...(() => {
      if (
        entry.lane !== "human"
        || !HUMAN_FILE_EVENTS.includes(entry.event)
      ) return {};
      const activeTool = [...agentEvents]
        .reverse()
        .find((candidate) => candidate.at <= entry.at && candidate.event === "Tool call");
      return activeTool
        ? { activeToolName: activeTool.toolName, activeToolCallId: activeTool.toolCallId }
        : {};
    })(),
  }));
}
