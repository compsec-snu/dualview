import * as os from "node:os";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { TEST_DIR, SESSIONS_DIR, BOT_SESSIONS_DIR, EVAL_RESULTS_DIR, type LogEntry } from "./types.js";
import { json, resolveBotWsDir, parseSessionKey, sessionLabel } from "./utils.js";
import { parseSessionList } from "./sessions.js";
import { parseLogEntries, parseWsLogEntries } from "./logs.js";
import { getConversation, getAudit, getNotify, getLlmRequests, getViewRoots, getViewRootsForDir, listWsFiles, listFilesForDir, readWsFile, readFileForDir } from "./workspace.js";
import { getConcurrencyTimeline } from "./concurrency.js";
import { getGitLog, getGitLogForDir, getFileGitLog, getFileGitLogForDir, getFileAtCommit, getFileAtCommitForDir, getCommitDetail, getCommitDetailForDir, getAdfiCommitsByCallId, getAdfiCommitsByCallIdForDir } from "./git.js";
import { parseBotSessionList, getBotConversation, getBotAudit, getBotLlmRequests } from "./bot-sessions.js";
import { evaluateBotAssertions } from "./bot-assertions.js";
import { parseEvalRuns, getEvalResult, getEvalMeta, listEvalTranscripts, getEvalTranscript, getEvalConversation, getEvalAuditLog, getEvalNotify, getEvalLlmRequestsByAgent, getEvalGatewayLog, getEvalWsViewRoots, listEvalWsFiles, readEvalWsFile, getEvalWsGitLog, getEvalWsAdfiCommits, getEvalTaskSpec, getEvalStatus, getEvalTrackingDir } from "./eval.js";

// ── Spec lookup helpers ─────────────────────────────────────────────────────
// UTs, injection tasks, attack templates, and assertion templates live under
// either test/benchmark/<kind>/ (paper benchmark assets) or test/e2e/<kind>/
// (CI assets). Earlier the dashboard hardcoded the e2e path, which served the
// wrong yaml for benchmark runs (issue #249). Prefer the benchmark tree first
// so paper-mode runs see their own UTs; fall back to e2e for CI lookups.

const SPEC_TREE_BASES = [
  path.join(TEST_DIR, "benchmark"),
  path.join(TEST_DIR, "e2e"),
];
const INTEGRATION_SCENARIOS_DIR = path.join(TEST_DIR, "integration", "scenarios");

function findSpecByPrefix(kind: string, idPrefix: string): { dir: string; file: string } | null {
  for (const base of SPEC_TREE_BASES) {
    const dir = path.join(base, kind);
    if (!fs.existsSync(dir)) continue;
    const file = fs.readdirSync(dir).find(
      (f) => f.startsWith(idPrefix + "-") && (f.endsWith(".yaml") || f.endsWith(".yml"))
    );
    if (file) return { dir, file };
  }
  return null;
}

function findSpecByName(kind: string, filename: string): { dir: string; file: string } | null {
  for (const base of SPEC_TREE_BASES) {
    const dir = path.join(base, kind);
    if (!fs.existsSync(dir)) continue;
    if (fs.existsSync(path.join(dir, filename))) return { dir, file: filename };
  }
  return null;
}

function listSpecFiles(kind: string): { dir: string; file: string }[] {
  const out: { dir: string; file: string }[] = [];
  const seenIds = new Set<string>();
  for (const base of SPEC_TREE_BASES) {
    const dir = path.join(base, kind);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const m = file.match(/^([A-Z]+-\d+)/);
      const id = m ? m[1]! : file;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push({ dir, file });
    }
  }
  return out;
}

function findTestDefinitionByPrefix(testId: string): { dir: string; file: string } | null {
  const userTask = findSpecByPrefix("user-tasks", testId);
  if (userTask) return userTask;
  if (!fs.existsSync(INTEGRATION_SCENARIOS_DIR)) return null;
  const file = fs.readdirSync(INTEGRATION_SCENARIOS_DIR).find(
    (name) => name.startsWith(testId + "-") && (name.endsWith(".yaml") || name.endsWith(".yml")),
  );
  return file ? { dir: INTEGRATION_SCENARIOS_DIR, file } : null;
}

function listTestDefinitionFiles(): { dir: string; file: string }[] {
  const files = listSpecFiles("user-tasks");
  if (!fs.existsSync(INTEGRATION_SCENARIOS_DIR)) return files;
  return files.concat(
    fs.readdirSync(INTEGRATION_SCENARIOS_DIR)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .sort()
      .map((file) => ({ dir: INTEGRATION_SCENARIOS_DIR, file })),
  );
}

function hasAssertionEntries(entries: LogEntry[] | null | undefined): entries is LogEntry[] {
  return Array.isArray(entries) && entries.some((entry) => entry.category === "assertion");
}

function testNameFromStart(message: string): string | null {
  const m = /^=== START(?: \(\w+\))?: (\S+?)(?: \[ws:[^\]]+\])? ===$/.exec(message);
  return m?.[1] ?? null;
}

function testNameFromEnd(message: string): string | null {
  const m = /^=== END: (\S+) /.exec(message);
  return m?.[1] ?? null;
}

function entriesForTest(entries: LogEntry[], testName: string): LogEntry[] {
  const startIdx = entries.findIndex((entry) => entry.category === "test" && testNameFromStart(entry.message) === testName);
  if (startIdx < 0) return entries;

  const endIdx = entries.findIndex((entry, idx) => (
    idx >= startIdx && entry.category === "test" && testNameFromEnd(entry.message) === testName
  ));
  return entries.slice(startIdx, endIdx >= 0 ? endIdx + 1 : entries.length);
}

// ── Route handler ───────────────────────────────────────────────────────────

export function handleApiRequest(url: string, res: ServerResponse): void {

  if (url === "/api/config") {
    let gitBranch = "", gitCommit = "";
    try {
      gitBranch = childProcess.execSync("git rev-parse --abbrev-ref HEAD", { cwd: TEST_DIR, encoding: "utf-8", stdio: "pipe" }).trim();
      gitCommit = childProcess.execSync("git log -1 --format=%h\\ %s", { cwd: TEST_DIR, encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {}
    const ciActor = process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN || process.env.CI_COMMITTER_NAME || "";
    const allowedModes = (process.env.DASHBOARD_ALLOWED_MODES || "e2e,bot,eval")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    json(res, {
      hostname: os.hostname(),
      port: process.env.DASHBOARD_PORT || "3456",
      sessionsDir: SESSIONS_DIR,
      botAvailable: !!BOT_SESSIONS_DIR && fs.existsSync(BOT_SESSIONS_DIR),
      evalAvailable: fs.existsSync(EVAL_RESULTS_DIR),
      allowedModes,
      defaultMode: process.env.DASHBOARD_RESOLVED_DEFAULT_MODE || "e2e",
      botOnly: process.env.DASHBOARD_BOT_ONLY === "1",
      authEnabled: !!process.env.DASHBOARD_PASSWORD,
      gitBranch,
      gitCommit,
      ciActor,
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      uptime: Math.floor(process.uptime()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    return;
  }

  if (url === "/api/sessions") {
    json(res, parseSessionList());
    return;
  }

  // /api/sessions/:id/log or /api/sessions/:id/log?ws=XX
  const logMatch = url.match(/^\/api\/sessions\/([^/]+)\/log(?:\?(.+))?$/);
  if (logMatch) {
    const logSessionId = logMatch[1]!;
    const logParams = new URLSearchParams(logMatch[2] ?? "");
    const logWsId = logParams.get("ws");

    const entries = logWsId
      ? parseWsLogEntries(logSessionId, logWsId)
      : parseLogEntries(logSessionId);
    if (entries === null) {
      json(res, { error: "Session not found" }, 404);
    } else {
      json(res, entries);
    }
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/conversation
  // /api/sessions/:sessionId/workspace/:wsId/audit
  // /api/sessions/:sessionId/workspace/:wsId/notify
  const wsDataMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/(conversation|audit|notify|llm-requests)$/);
  if (wsDataMatch) {
    const [, sessionId, wsId, field] = wsDataMatch;

    if (field === "conversation") json(res, getConversation(sessionId!, wsId!));
    else if (field === "audit") json(res, getAudit(sessionId!, wsId!));
    else if (field === "notify") json(res, getNotify(sessionId!, wsId!));
    else if (field === "llm-requests") json(res, getLlmRequests(sessionId!, wsId!));
    else json(res, { error: "Unknown field" }, 400);
    return;
  }

  const concurrencyTimelineMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/concurrency-timeline$/);
  if (concurrencyTimelineMatch) {
    const [, sessionId, wsId] = concurrencyTimelineMatch;
    json(res, {
      events: getConcurrencyTimeline(sessionId!, wsId!),
    });
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/view-roots — resolved absolute paths for each file view
  const viewRootsMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/view-roots$/);
  if (viewRootsMatch) {
    const [, sessionId, wsId] = viewRootsMatch;
    json(res, getViewRoots(sessionId!, wsId!));
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/files[?view=root|trusted|untrusted] — list all files
  const wsFilesMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/files(?:\?(.+))?$/);
  if (wsFilesMatch) {
    const [, sessionId, wsId, query] = wsFilesMatch;
    const params = new URLSearchParams(query ?? "");
    const view = params.get("view") ?? undefined;
    json(res, listWsFiles(sessionId!, wsId!, view));
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/file?path=...&view=... — read a specific file
  const wsFileMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/file\?(.+)$/);
  if (wsFileMatch) {
    const [, sessionId, wsId, query] = wsFileMatch;
    const params = new URLSearchParams(query!);
    const filePath = params.get("path");
    const view = params.get("view") ?? undefined;
    if (!filePath) { json(res, { error: "Missing path param" }, 400); return; }

    const result = readWsFile(sessionId!, wsId!, filePath, view);
    if (!result) { json(res, { error: "File not found" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/git-log?subdir=workspace
  const gitLogMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/git-log(?:\?(.+))?$/);
  if (gitLogMatch) {
    const [, sessionId, wsId, query] = gitLogMatch;
    const params = new URLSearchParams(query ?? "");
    const subdir = params.get("subdir") ?? "workspace";
    json(res, getGitLog(sessionId!, wsId!, subdir));
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/file-git-log?subdir=workspace&path=report.md
  const fileGitLogMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/file-git-log\?(.+)$/);
  if (fileGitLogMatch) {
    const [, sessionId, wsId, query] = fileGitLogMatch;
    const params = new URLSearchParams(query!);
    const subdir = params.get("subdir") ?? "workspace";
    const filePath = params.get("path");
    if (!filePath) { json(res, { error: "Missing path param" }, 400); return; }
    json(res, getFileGitLog(sessionId!, wsId!, subdir, filePath));
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/file-at-commit?subdir=workspace&path=report.md&commit=abc123
  const fileAtCommitMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/file-at-commit\?(.+)$/);
  if (fileAtCommitMatch) {
    const [, sessionId, wsId, query] = fileAtCommitMatch;
    const params = new URLSearchParams(query!);
    const subdir = params.get("subdir") ?? "workspace";
    const filePath = params.get("path");
    const commit = params.get("commit");
    if (!filePath || !commit) { json(res, { error: "Missing path or commit param" }, 400); return; }
    const result = getFileAtCommit(sessionId!, wsId!, subdir, filePath, commit);
    if (!result) { json(res, { error: "File not found at commit" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/commit-detail?subdir=workspace&commit=abc123
  const commitDetailMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/commit-detail\?(.+)$/);
  if (commitDetailMatch) {
    const [, sessionId, wsId, query] = commitDetailMatch;
    const params = new URLSearchParams(query!);
    const subdir = params.get("subdir") ?? "workspace";
    const commit = params.get("commit");
    if (!commit) { json(res, { error: "Missing commit param" }, 400); return; }
    const result = getCommitDetail(sessionId!, wsId!, subdir, commit);
    if (!result) { json(res, { error: "Commit not found" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/dualview-commits?subdir=workspace
  const dualviewCommitsMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/dualview-commits(?:\?(.+))?$/);
  if (dualviewCommitsMatch) {
    const [, sessionId, wsId, query] = dualviewCommitsMatch;
    const params = new URLSearchParams(query ?? "");
    const subdir = params.get("subdir") ?? "workspace";
    json(res, getAdfiCommitsByCallId(sessionId!, wsId!, subdir));
    return;
  }

  // /api/sessions/:sessionId/workspace/:wsId/assertions — assertion results from log
  const assertionsMatch = url.match(/^\/api\/sessions\/([^/]+)\/workspace\/(\d{2}(?:-a\d+)?)\/assertions$/);
  if (assertionsMatch) {
    const [, sessionId, wsId] = assertionsMatch;

    // Find the test name for this workspace
    const sessions = parseSessionList();
    const session = sessions.find((s) => s.id === sessionId);
    const test = session?.tests.find((t) => t.wsId === wsId);

    const wsEntries = parseWsLogEntries(sessionId!, wsId!);
    const summaryEntries = parseLogEntries(sessionId!);
    const entries = hasAssertionEntries(wsEntries)
      ? wsEntries
      : summaryEntries
        ? (test?.name ? entriesForTest(summaryEntries, test.name) : summaryEntries)
        : wsEntries;
    if (!entries) { json(res, { testName: test?.name ?? null, testResult: test?.result ?? null, assertions: [] }, 200); return; }

    // Extract assertion log entries from per-workspace log
    const ASSERTION_RE = /^(PASS|FAIL|ERROR|SKIP|WARN): (.+?) -- (.+?)(?:\s+\[(.+)\])?$/;

    const results: Array<{
      status: "pass" | "fail" | "error" | "skip" | "warn";
      label: string;
      description?: string;
      reason: string;
      category: "correctness" | "utility";
      tool?: string;
      timing?: string;
      timingRef?: string;
      assert?: string;
      idx?: number;
    }> = [];

    for (const entry of entries) {
      if (entry.category !== "assertion") continue;

      const m = ASSERTION_RE.exec(entry.message);
      if (!m) continue;

      const metaStr = m[4] ?? "";
      const meta: Record<string, string> = {};
      for (const part of metaStr.split(/\s+/)) {
        const eq = part.indexOf("=");
        if (eq > 0) meta[part.slice(0, eq)] = part.slice(eq + 1);
      }

      // category from log meta (set by assertion runner)
      const category: "correctness" | "utility" = meta.category === "correctness" ? "correctness" : "utility";
      results.push({
        status: m[1] === "PASS" ? "pass" : m[1] === "FAIL" ? "fail" : m[1] === "WARN" ? "warn" : m[1] === "SKIP" ? "skip" : "error",
        label: m[2]!,
        description: meta.desc ? decodeURIComponent(meta.desc) : undefined,
        reason: m[3]!,
        category,
        tool: meta.tool,
        timing: meta.timing,
        timingRef: meta.ref,
        assert: meta.assert,
        idx: meta.idx != null ? parseInt(meta.idx, 10) : undefined,
        template: meta.template,
        tidx: meta.tidx != null ? parseInt(meta.tidx, 10) : undefined,
      });
    }

    // Read test spec's `active` field from YAML
    let testActive: true | false | "wip" | null = null;
    if (test) {
      const testId = test.name.split("\u00d7")[0]!;
      const found = findTestDefinitionByPrefix(testId);
      if (found) {
        try {
          const specContent = fs.readFileSync(path.join(found.dir, found.file), "utf-8");
          const activeMatch = specContent.match(/^active:\s*(.+)$/m);
          if (activeMatch) {
            const val = activeMatch[1]!.trim();
            if (val === "wip") testActive = "wip";
            else if (val === "false") testActive = false;
            else testActive = true;
          }
        } catch { /* skip */ }
      }
    }

    // Read runtime metadata from workspace (openclaw session + config)
    let runtimeMeta: Record<string, string> | null = null;
    const wsDir = path.join(SESSIONS_DIR, sessionId!, wsId!);
    const oclawCfgPath = path.join(wsDir, "openclaw.json");
    if (fs.existsSync(oclawCfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(oclawCfgPath, "utf-8"));
        const meta: Record<string, string> = {};
        if (cfg.model) meta.model = cfg.model;
        if (cfg.thinking) meta.thinking = String(cfg.thinking);
        if (cfg.cwd) meta.cwd = cfg.cwd;
        // Read session ID from the session JSONL (first line, type=session)
        const mainSessDir = path.join(wsDir, "agents", "main", "sessions");
        if (fs.existsSync(mainSessDir)) {
          const sessFiles = fs.readdirSync(mainSessDir).filter((f) => f.endsWith(".jsonl"));
          if (sessFiles.length > 0) {
            try {
              const firstLine = fs.readFileSync(path.join(mainSessDir, sessFiles[0]!), "utf-8").split("\n")[0]!;
              const sessEntry = JSON.parse(firstLine);
              if (sessEntry.id) meta.sessionId = sessEntry.id;
            } catch { /* skip */ }
          }
        }
        if (Object.keys(meta).length > 0) runtimeMeta = meta;
      } catch { /* skip */ }
    }

    json(res, { testName: test?.name ?? null, testResult: test?.result ?? null, active: testActive, runtimeMeta, assertions: results });
    return;
  }

  // /api/test-names — map of test IDs to human-readable names from YAML specs
  if (url === "/api/test-names") {
    const names: Record<string, string> = {};
    for (const { dir, file } of listTestDefinitionFiles()) {
      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const idMatch = content.match(/^id:\s*"?([A-Z]+-\d+)"?\s*$/m);
        const nameMatch = content.match(/^name:\s*"?(.+?)"?\s*$/m);
        if (idMatch && nameMatch) names[idMatch[1]!] = nameMatch[1]!;
      } catch { /* skip unreadable files */ }
    }
    json(res, names);
    return;
  }

  // /api/test-tags — map of test IDs to tags arrays from YAML specs
  if (url === "/api/test-tags") {
    const tags: Record<string, string[]> = {};
    for (const { dir, file } of listSpecFiles("user-tasks")) {
      const m = file.match(/^(UT-\d+)-/);
      if (!m) continue;
      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const tagMatch = content.match(/^tags:\s*\[(.+?)\]\s*$/m);
        if (tagMatch) {
          tags[m[1]!] = tagMatch[1]!.split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""));
        }
      } catch { /* skip unreadable files */ }
    }
    json(res, tags);
    return;
  }

  // /api/test-spec/:testId — serve the YAML test definition file
  const specMatch = url.match(/^\/api\/test-spec\/([^/]+)$/);
  if (specMatch) {
    const testId = decodeURIComponent(specMatch[1]!);
    const found = findTestDefinitionByPrefix(testId);
    if (!found) { json(res, { error: `No spec found for ${testId}` }, 404); return; }
    const content = fs.readFileSync(path.join(found.dir, found.file), "utf-8");
    json(res, { filename: found.file, content });
    return;
  }

  // /api/injection-task/:itId — serve the injection task YAML definition
  const itMatch = url.match(/^\/api\/injection-task\/([^/]+)$/);
  if (itMatch) {
    const itId = decodeURIComponent(itMatch[1]!);
    const found = findSpecByPrefix("injection-tasks", itId);
    if (!found) { json(res, { error: `No injection task found for ${itId}` }, 404); return; }
    const content = fs.readFileSync(path.join(found.dir, found.file), "utf-8");
    json(res, { filename: found.file, content });
    return;
  }

  // /api/attack-template/:attackId — serve the attack template YAML definition
  const atkMatch = url.match(/^\/api\/attack-template\/([^/]+)$/);
  if (atkMatch) {
    const atkId = decodeURIComponent(atkMatch[1]!);
    const filename = `${atkId}.yaml`;
    const found = findSpecByName("attack-templates", filename);
    if (!found) { json(res, { error: `No attack template found for ${atkId}` }, 404); return; }
    const content = fs.readFileSync(path.join(found.dir, found.file), "utf-8");
    json(res, { filename, content });
    return;
  }

  // /api/template-spec/:templateId — serve an assertion template YAML file
  const templateMatch = url.match(/^\/api\/template-spec\/([^/]+)$/);
  if (templateMatch) {
    const templateId = decodeURIComponent(templateMatch[1]!);
    const filename = `${templateId}.yaml`;
    const found = findSpecByName("assertion-templates", filename);
    if (!found) { json(res, { error: `No template found: ${templateId}` }, 404); return; }
    const content = fs.readFileSync(path.join(found.dir, found.file), "utf-8");
    json(res, { filename, templateId, content });
    return;
  }

  // /api/sessions/:sessionId/meta — raw meta.json for this batch
  const metaMatch = url.match(/^\/api\/sessions\/([^/]+)\/meta$/);
  if (metaMatch) {
    const metaSessionId = metaMatch[1]!;
    const metaPath = path.join(SESSIONS_DIR, metaSessionId, "meta.json");
    if (!fs.existsSync(metaPath)) { json(res, { error: "meta.json not found" }, 404); return; }
    json(res, JSON.parse(fs.readFileSync(metaPath, "utf-8")));
    return;
  }

  // /api/sessions/:sessionId/openclaw-config — openclaw.json from the batch's 00/ dir
  const oclawCfgMatch = url.match(/^\/api\/sessions\/([^/]+)\/openclaw-config$/);
  if (oclawCfgMatch) {
    const cfgSessionId = oclawCfgMatch[1]!;
    const cfgPath = path.join(SESSIONS_DIR, cfgSessionId, "00", "openclaw.json");
    if (!fs.existsSync(cfgPath)) { json(res, { error: "openclaw.json not found" }, 404); return; }
    // Redact sensitive fields
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    try {
      if (cfg.gateway?.auth?.token) cfg.gateway.auth.token = "***";
    } catch { /* ignore */ }
    json(res, cfg);
    return;
  }

  // ── Bot dashboard routes ──────────────────────────────────────────────────

  // /api/bot/batches — list all bot deploy batches with their sessions
  if (url === "/api/bot/batches") {
    json(res, parseBotSessionList());
    return;
  }

  // /api/bot/batches/:batchId/sessions/:sessionId/conversation
  const botConvMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/sessions\/([^/]+)\/conversation$/);
  if (botConvMatch) {
    const [, batchId, sessionId] = botConvMatch;
    json(res, getBotConversation(batchId!, sessionId!));
    return;
  }

  // /api/bot/batches/:batchId/audit
  const botAuditMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/audit$/);
  if (botAuditMatch) {
    json(res, getBotAudit(botAuditMatch[1]!));
    return;
  }

  // /api/bot/batches/:batchId/llm-requests
  const botLlmMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/llm-requests$/);
  if (botLlmMatch) {
    json(res, getBotLlmRequests(botLlmMatch[1]!));
    return;
  }

  // /api/bot/batches/:batchId/ws/view-roots
  const botViewRootsMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/view-roots$/);
  if (botViewRootsMatch) {
    const wsDir = resolveBotWsDir(botViewRootsMatch[1]!);
    if (!wsDir) { json(res, { root: null, trusted: null, untrusted: null }); return; }
    json(res, getViewRootsForDir(wsDir));
    return;
  }

  // /api/bot/batches/:batchId/ws/files[?view=root|trusted|untrusted]
  const botFilesMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/files(?:\?(.+))?$/);
  if (botFilesMatch) {
    const wsDir = resolveBotWsDir(botFilesMatch[1]!);
    if (!wsDir) { json(res, []); return; }
    const params = new URLSearchParams(botFilesMatch[2] ?? "");
    const view = params.get("view") ?? undefined;
    json(res, listFilesForDir(wsDir, view));
    return;
  }

  // /api/bot/batches/:batchId/ws/file?path=...&view=...
  const botFileMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/file\?(.+)$/);
  if (botFileMatch) {
    const wsDir = resolveBotWsDir(botFileMatch[1]!);
    if (!wsDir) { json(res, { error: "Batch not found" }, 404); return; }
    const params = new URLSearchParams(botFileMatch[2]!);
    const filePath = params.get("path");
    const view = params.get("view") ?? undefined;
    if (!filePath) { json(res, { error: "Missing path param" }, 400); return; }
    const result = readFileForDir(wsDir, filePath, view);
    if (!result) { json(res, { error: "File not found" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/bot/batches/:batchId/ws/git-log[?subdir=workspace]
  const botGitLogMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/git-log(?:\?(.+))?$/);
  if (botGitLogMatch) {
    const wsDir = resolveBotWsDir(botGitLogMatch[1]!);
    if (!wsDir) { json(res, []); return; }
    const params = new URLSearchParams(botGitLogMatch[2] ?? "");
    const subdir = params.get("subdir") ?? "workspace";
    json(res, getGitLogForDir(wsDir, subdir));
    return;
  }

  // /api/bot/batches/:batchId/ws/file-git-log?subdir=...&path=...
  const botFileGitLogMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/file-git-log\?(.+)$/);
  if (botFileGitLogMatch) {
    const wsDir = resolveBotWsDir(botFileGitLogMatch[1]!);
    if (!wsDir) { json(res, []); return; }
    const params = new URLSearchParams(botFileGitLogMatch[2]!);
    const subdir = params.get("subdir") ?? "workspace";
    const filePath = params.get("path");
    if (!filePath) { json(res, { error: "Missing path param" }, 400); return; }
    json(res, getFileGitLogForDir(wsDir, subdir, filePath));
    return;
  }

  // /api/bot/batches/:batchId/ws/file-at-commit?subdir=...&path=...&commit=...
  const botFileAtCommitMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/file-at-commit\?(.+)$/);
  if (botFileAtCommitMatch) {
    const wsDir = resolveBotWsDir(botFileAtCommitMatch[1]!);
    if (!wsDir) { json(res, { error: "Batch not found" }, 404); return; }
    const params = new URLSearchParams(botFileAtCommitMatch[2]!);
    const subdir = params.get("subdir") ?? "workspace";
    const filePath = params.get("path");
    const commit = params.get("commit");
    if (!filePath || !commit) { json(res, { error: "Missing path or commit param" }, 400); return; }
    const result = getFileAtCommitForDir(wsDir, subdir, filePath, commit);
    if (!result) { json(res, { error: "File not found at commit" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/bot/batches/:batchId/ws/commit-detail?subdir=...&commit=...
  const botCommitDetailMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/commit-detail\?(.+)$/);
  if (botCommitDetailMatch) {
    const wsDir = resolveBotWsDir(botCommitDetailMatch[1]!);
    if (!wsDir) { json(res, { error: "Batch not found" }, 404); return; }
    const params = new URLSearchParams(botCommitDetailMatch[2]!);
    const subdir = params.get("subdir") ?? "workspace";
    const commit = params.get("commit");
    if (!commit) { json(res, { error: "Missing commit param" }, 400); return; }
    const result = getCommitDetailForDir(wsDir, subdir, commit);
    if (!result) { json(res, { error: "Commit not found" }, 404); return; }
    json(res, result);
    return;
  }

  // /api/bot/batches/:batchId/ws/dualview-commits[?subdir=workspace]
  const botAdfiCommitsMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/ws\/dualview-commits(?:\?(.+))?$/);
  if (botAdfiCommitsMatch) {
    const wsDir = resolveBotWsDir(botAdfiCommitsMatch[1]!);
    if (!wsDir) { json(res, {}); return; }
    const params = new URLSearchParams(botAdfiCommitsMatch[2] ?? "");
    const subdir = params.get("subdir") ?? "workspace";
    json(res, getAdfiCommitsByCallIdForDir(wsDir, subdir));
    return;
  }

  // ── Collected view routes ───────────────────────────────────────────────

  // /api/bot/collected/sessions — cross-batch session index grouped by platform
  if (url === "/api/bot/collected/sessions") {
    const batches = parseBotSessionList();
    // Build a map: sessionKey → { parsed, batches: [{batchId, messageCount, updatedAt}] }
    const sessionMap = new Map<string, {
      parsed: ReturnType<typeof parseSessionKey>;
      label: string;
      batches: Array<{ batchId: string; messageCount: number; updatedAt?: number; model?: string }>;
    }>();

    for (const batch of batches) {
      for (const sess of batch.sessions) {
        const key = sess.sessionKey;
        if (!sessionMap.has(key)) {
          const parsed = parseSessionKey(key);
          sessionMap.set(key, { parsed, label: sessionLabel(parsed), batches: [] });
        }
        // Count messages by reading the session JSONL file
        let messageCount = 0;
        const wsDir = resolveBotWsDir(batch.batchId);
        if (wsDir) {
          const sessDir = path.join(wsDir, "agents", "main", "sessions");
          if (fs.existsSync(sessDir)) {
            for (const f of fs.readdirSync(sessDir)) {
              if (f.endsWith(".jsonl") && f.startsWith(sess.sessionId)) {
                const content = fs.readFileSync(path.join(sessDir, f), "utf-8");
                messageCount = content.split("\n").filter((l) => l.trim()).length;
              }
            }
          }
        }
        sessionMap.get(key)!.batches.push({
          batchId: batch.batchId,
          messageCount,
          updatedAt: sess.updatedAt,
          model: sess.model,
        });
      }
    }

    // Group by platform
    const grouped: Record<string, Array<{
      sessionKey: string;
      label: string;
      platform: string;
      scope: string;
      peerId: string;
      batches: Array<{ batchId: string; messageCount: number; updatedAt?: number; model?: string }>;
    }>> = {};
    for (const [key, entry] of sessionMap) {
      const platform = entry.parsed.platform;
      if (!grouped[platform]) grouped[platform] = [];
      grouped[platform].push({
        sessionKey: key,
        label: entry.label,
        platform: entry.parsed.platform,
        scope: entry.parsed.scope,
        peerId: entry.parsed.peerId,
        batches: entry.batches,
      });
    }
    json(res, grouped);
    return;
  }

  // /api/bot/collected/sessions/:sessionKey/conversation?batch=<batchId>
  const persistConvMatch = url.match(/^\/api\/bot\/collected\/sessions\/([^/]+)\/conversation\?(.+)$/);
  if (persistConvMatch) {
    const sessionKey = decodeURIComponent(persistConvMatch[1]!);
    const params = new URLSearchParams(persistConvMatch[2]!);
    const batchId = params.get("batch");
    if (!batchId) { json(res, { error: "Missing batch param" }, 400); return; }

    // Find the sessionId for this sessionKey in this batch
    const batches = parseBotSessionList();
    const batch = batches.find((b) => b.batchId === batchId);
    if (!batch) { json(res, { error: "Batch not found" }, 404); return; }
    const sess = batch.sessions.find((s) => s.sessionKey === sessionKey);
    if (!sess) { json(res, { error: "Session not found in batch" }, 404); return; }
    json(res, getBotConversation(batchId, sess.sessionId));
    return;
  }

  // /api/bot/collected/audit?session=<sessionKey>[&batch=<batchId>]
  const persistAuditMatch = url.match(/^\/api\/bot\/collected\/audit\?(.+)$/);
  if (persistAuditMatch) {
    const params = new URLSearchParams(persistAuditMatch[1]!);
    const sessionFilter = params.get("session");
    const batchId = params.get("batch");

    if (batchId) {
      // Specific batch
      const entries = getBotAudit(batchId);
      if (sessionFilter) {
        json(res, entries.filter((e) => (e as Record<string, string>).sessionKey === sessionFilter));
      } else {
        json(res, entries);
      }
    } else {
      // Latest batch containing this session
      const batches = parseBotSessionList();
      const targetBatch = sessionFilter
        ? batches.find((b) => b.sessions.some((s) => s.sessionKey === sessionFilter))
        : batches[0]; // newest
      if (!targetBatch) { json(res, []); return; }
      const entries = getBotAudit(targetBatch.batchId);
      if (sessionFilter) {
        json(res, entries.filter((e) => (e as Record<string, string>).sessionKey === sessionFilter));
      } else {
        json(res, entries);
      }
    }
    return;
  }


  // /api/bot/collected/sessions/:sessionKey/stitched — cross-batch stitched conversation
  const persistStitchedMatch = url.match(/^\/api\/bot\/collected\/sessions\/([^/]+)\/stitched$/);
  if (persistStitchedMatch) {
    const sessionKey = decodeURIComponent(persistStitchedMatch[1]!);
    const batches = parseBotSessionList();

    const mainEntries: unknown[] = [];
    const ullmEntries: unknown[] = [];

    // Iterate oldest-first so the stitched timeline is chronological
    for (const batch of [...batches].reverse()) {
      const sess = batch.sessions.find((s) => s.sessionKey === sessionKey);
      if (!sess) continue;
      const conv = getBotConversation(batch.batchId, sess.sessionId);

      // Insert a batch boundary marker
      const marker = {
        type: "batch_boundary",
        batchId: batch.batchId,
        date: batch.date,
        status: batch.status,
        gitBranch: batch.gitBranch,
      };
      if (conv.main.length > 0) {
        mainEntries.push(marker, ...conv.main);
      }
      if (conv.ullm.length > 0) {
        ullmEntries.push(marker, ...conv.ullm);
      }
    }
    json(res, { main: mainEntries, ullm: ullmEntries });
    return;
  }

  // /api/bot/batches/:batchId/assertions — permissive assertion evaluation
  const botAssertionsMatch = url.match(/^\/api\/bot\/batches\/([^/]+)\/assertions$/);
  if (botAssertionsMatch) {
    json(res, evaluateBotAssertions(botAssertionsMatch[1]!));
    return;
  }

  // ── Eval dashboard routes ─────────────────────────────────────────────────

  if (url === "/api/eval/runs") {
    json(res, parseEvalRuns());
    return;
  }

  if (url === "/api/eval/status") {
    json(res, getEvalStatus());
    return;
  }

  // /api/eval/runs/:runId — full PinchBench result
  const evalRunMatch = url.match(/^\/api\/eval\/runs\/([^/]+)$/);
  if (evalRunMatch) {
    const data = getEvalResult(evalRunMatch[1]!);
    if (!data) { json(res, { error: "Run not found" }, 404); return; }
    json(res, data);
    return;
  }

  // /api/eval/runs/:runId/meta
  const evalMetaMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/meta$/);
  if (evalMetaMatch) {
    const data = getEvalMeta(evalMetaMatch[1]!);
    if (!data) { json(res, { error: "Run not found" }, 404); return; }
    json(res, data);
    return;
  }

  // /api/eval/runs/:runId/transcripts — list available transcripts
  const evalTranscriptsMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/transcripts$/);
  if (evalTranscriptsMatch) {
    json(res, listEvalTranscripts(evalTranscriptsMatch[1]!));
    return;
  }

  // /api/eval/runs/:runId/transcripts/:taskId — single task transcript
  const evalTranscriptMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/transcripts\/([^/]+)$/);
  if (evalTranscriptMatch) {
    json(res, getEvalTranscript(evalTranscriptMatch[1]!, evalTranscriptMatch[2]!));
    return;
  }

  // /api/eval/runs/:runId/conversation/:taskId — e2e-format conversation data
  const evalConvMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/conversation\/([^/]+)$/);
  if (evalConvMatch) {
    json(res, getEvalConversation(evalConvMatch[1]!, evalConvMatch[2]!));
    return;
  }

  // /api/eval/runs/:runId/audit — DUALVIEW audit log
  // /api/eval/runs/:runId/audit/:taskId — task-scoped DUALVIEW audit log
  const evalTaskAuditMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/audit\/([^/]+)$/);
  if (evalTaskAuditMatch) {
    json(res, getEvalAuditLog(evalTaskAuditMatch[1]!, decodeURIComponent(evalTaskAuditMatch[2]!)));
    return;
  }

  const evalAuditMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/audit$/);
  if (evalAuditMatch) {
    json(res, getEvalAuditLog(evalAuditMatch[1]!));
    return;
  }

  // /api/eval/runs/:runId/notify — DUALVIEW notify events
  const evalNotifyMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/notify$/);
  if (evalNotifyMatch) {
    json(res, getEvalNotify(evalNotifyMatch[1]!));
    return;
  }

  // /api/eval/runs/:runId/llm-requests — DUALVIEW LLM request log (by agent)
  const evalLlmMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/llm-requests$/);
  if (evalLlmMatch) {
    json(res, getEvalLlmRequestsByAgent(evalLlmMatch[1]!));
    return;
  }

  // /api/eval/runs/:runId/task-spec/:taskId — PinchBench task markdown
  const evalTaskSpecMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/task-spec\/([^/]+)$/);
  if (evalTaskSpecMatch) {
    const spec = getEvalTaskSpec(evalTaskSpecMatch[1]!, evalTaskSpecMatch[2]!);
    json(res, { spec: spec || null });
    return;
  }

  // /api/eval/runs/:runId/gateway-log — raw gateway log text
  const evalGwLogMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/gateway-log$/);
  if (evalGwLogMatch) {
    json(res, { log: getEvalGatewayLog(evalGwLogMatch[1]!) });
    return;
  }

  // /api/eval/runs/:runId/ws/view-roots[?task=task_id] — workspace view roots
  const evalWsRootsMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/view-roots(?:\?(.+))?$/);
  if (evalWsRootsMatch) {
    const params = new URLSearchParams(evalWsRootsMatch[2] || "");
    json(res, getEvalWsViewRoots(evalWsRootsMatch[1]!, params.get("task") || undefined));
    return;
  }

  // /api/eval/runs/:runId/ws/files[?view=root|trusted|untrusted&task=task_id]
  const evalWsFilesMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/files(\?.*)?$/);
  if (evalWsFilesMatch) {
    const view = new URLSearchParams(evalWsFilesMatch[2] || "").get("view") || undefined;
    const taskId = new URLSearchParams(evalWsFilesMatch[2] || "").get("task") || undefined;
    json(res, listEvalWsFiles(evalWsFilesMatch[1]!, view, taskId));
    return;
  }

  // /api/eval/runs/:runId/ws/dualview-commits[?task=task_id] — DUALVIEW git commit history
  const evalAdfiCommitsMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/dualview-commits(?:\?(.+))?$/);
  if (evalAdfiCommitsMatch) {
    const params = new URLSearchParams(evalAdfiCommitsMatch[2] || "");
    json(res, getEvalWsAdfiCommits(evalAdfiCommitsMatch[1]!, params.get("task") || undefined));
    return;
  }

  // /api/eval/runs/:runId/ws/git-log?subdir=...
  const evalGitLogMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/git-log(?:\?(.+))?$/);
  if (evalGitLogMatch) {
    const params = new URLSearchParams(evalGitLogMatch[2] || "");
    const subdir = params.get("subdir") ?? ".";
    json(res, getEvalWsGitLog(evalGitLogMatch[1]!, subdir, params.get("task") || undefined));
    return;
  }

  // /api/eval/runs/:runId/ws/commit-detail?subdir=...&commit=...
  const evalCommitDetailMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/commit-detail\?(.+)$/);
  if (evalCommitDetailMatch) {
    const trackingDir = getEvalTrackingDir(evalCommitDetailMatch[1]!);
    const params = new URLSearchParams(evalCommitDetailMatch[2]!);
    const subdir = params.get("subdir") ?? ".";
    const commit = params.get("commit") ?? "";
    if (fs.existsSync(trackingDir)) {
      json(res, getCommitDetailForDir(trackingDir, subdir, commit));
    } else {
      json(res, { error: "Not found" }, 404);
    }
    return;
  }

  // /api/eval/runs/:runId/ws/file?path=...&view=...&task=task_id
  const evalWsFileMatch = url.match(/^\/api\/eval\/runs\/([^/]+)\/ws\/file\?(.+)$/);
  if (evalWsFileMatch) {
    const params = new URLSearchParams(evalWsFileMatch[2]!);
    const data = readEvalWsFile(evalWsFileMatch[1]!, params.get("path") || "", params.get("view") || undefined, params.get("task") || undefined);
    if (!data) { json(res, { error: "File not found" }, 404); return; }
    json(res, data);
    return;
  }

  json(res, { error: "Not found" }, 404);
}
