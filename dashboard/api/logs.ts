import * as fs from "node:fs";
import * as path from "node:path";
import { SESSIONS_DIR, ENTRY_RE, type LogEntry } from "./types.js";
import { stripAnsi } from "./utils.js";

// ── Log entry parsing (shared logic) ────────────────────────────────────────

function parseLogLines(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];

  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith("[")) i++;

  while (i < lines.length) {
    const line = stripAnsi(lines[i]!);
    const m = ENTRY_RE.exec(line);
    if (m) {
      const entry: LogEntry = { elapsed: m[1]!, category: m[2]!, message: m[3]! };
      const dataLines: string[] = [];
      i++;
      while (i < lines.length) {
        const next = stripAnsi(lines[i]!);
        if (next.match(/^\s{11}/) && !ENTRY_RE.test(next)) {
          dataLines.push(next.trim());
          i++;
        } else {
          break;
        }
      }
      if (dataLines.length > 0) entry.data = dataLines.join("\n");
      entries.push(entry);
    } else {
      const tm = /^\[\s*([\d.]+s)\]\s+(=== (?:START(?: \(\w+\))?:|END:) .+ ===)$/.exec(line);
      if (tm) entries.push({ elapsed: tm[1]!, category: "test", message: tm[2]! });
      i++;
      continue;
    }
  }

  return entries;
}

// ── Summary log entries ─────────────────────────────────────────────────────

export function parseLogEntries(sessionId: string): LogEntry[] | null {
  const summaryPath = path.join(SESSIONS_DIR, sessionId, "summary.log");
  if (!fs.existsSync(summaryPath)) return null;

  const content = fs.readFileSync(summaryPath, "utf-8");
  return parseLogLines(content.split("\n"));
}

// ── Per-workspace log entries ───────────────────────────────────────────────

export function parseWsLogEntries(sessionId: string, wsId: string): LogEntry[] | null {
  const wsLogPath = path.join(SESSIONS_DIR, sessionId, `${wsId}.log`);
  if (!fs.existsSync(wsLogPath)) return null;

  const content = fs.readFileSync(wsLogPath, "utf-8");
  return parseLogLines(content.split("\n"));
}
