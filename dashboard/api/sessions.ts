import * as fs from "node:fs";
import * as path from "node:path";
import {
  SESSIONS_DIR, BATCH_ID_RE, WS_ID_RE, TEST_END_RE, TEST_SKIP_RE, RETRY_DIR_RE,
  type SessionSummary, type TestRef, type RetryAttemptRef,
} from "./types.js";
import { stripAnsi } from "./utils.js";

// ── Session list ────────────────────────────────────────────────────────────

export function parseSessionList(): SessionSummary[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  // Scan batch directories (YYYYMMDD_HHMMSS) for meta.json or summary.log
  const batchDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && BATCH_ID_RE.test(d.name))
    .map((d) => d.name);

  const sessions: SessionSummary[] = [];

  for (const batchId of batchDirs) {
    const batchDir = path.join(SESSIONS_DIR, batchId);

    // Try meta.json first (new format), then fall back to summary.log parsing
    const metaPath = path.join(batchDir, "meta.json");
    const summaryPath = path.join(batchDir, "summary.log");

    let date = "";
    let mode = "";
    let result: "PASS" | "FAIL" | "RUNNING" | "INTERRUPTED" = "PASS";
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let total = 0;
    let elapsedSec: number | undefined;
    let wsMap: Record<string, string> | undefined;
    let docker: boolean | undefined;
    let gitBranch: string | undefined;
    let ciActor: string | undefined;
    let ciJobUrl: string | undefined;
    let testRetries: Record<string, {attempt: number; maxAttempts: number}> | undefined;
    let symbolFormat: string | undefined;
    let defense: string | undefined;
    let openshellPolicy: string | undefined;
    let attackSuccessCount: number | undefined;
    let attackBlockedCount: number | undefined;
    let attackInconclusive: number | undefined;
    let attackSuccessRate: number | undefined;

    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        date = meta.date ?? "";
        mode = meta.mode ?? "";
        if (meta.status === "RUNNING") {
          // Detect interrupted: check if the runner PID is still alive
          let alive = false;
          if (typeof meta.pid === "number") {
            try { process.kill(meta.pid, 0); alive = true; } catch { /* process dead */ }
          }
          // Fallback: if no PID (old format), use mtime staleness (>2 min = interrupted)
          if (!alive && typeof meta.pid !== "number") {
            try {
              const mtime = fs.statSync(metaPath).mtimeMs;
              alive = Date.now() - mtime < 120_000;
            } catch { /* stat failed, treat as interrupted */ }
          }
          result = alive ? "RUNNING" : "INTERRUPTED";
        } else {
          result = meta.status === "FAIL" ? "FAIL" : "PASS";
        }
        passed = meta.passed ?? 0;
        failed = meta.failed ?? 0;
        skipped = meta.skipped ?? 0;
        total = meta.total ?? (passed + failed + skipped);
        if (typeof meta.elapsedSec === "number") {
          elapsedSec = meta.elapsedSec;
        } else if (date) {
          // Fallback: compute from batchId (YYYYMMDD_HHMMSS) → date
          const m = batchId.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\w+)?$/);
          if (m) {
            const start = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
            const end = new Date(date).getTime();
            if (start > 0 && end > start) elapsedSec = Math.round((end - start) / 1000);
          }
        }
        if (meta.wsMap && typeof meta.wsMap === "object") wsMap = meta.wsMap;
        if (typeof meta.docker === "boolean") docker = meta.docker;
        if (typeof meta.gitBranch === "string" && meta.gitBranch) gitBranch = meta.gitBranch;
        if (typeof meta.ciActor === "string" && meta.ciActor) ciActor = meta.ciActor;
        if (typeof meta.ciJobUrl === "string" && meta.ciJobUrl) ciJobUrl = meta.ciJobUrl;
        if (meta.testRetries && typeof meta.testRetries === "object") testRetries = meta.testRetries;
        if (typeof meta.symbolFormat === "string" && meta.symbolFormat) symbolFormat = meta.symbolFormat;
        if (typeof meta.defense === "string" && meta.defense) defense = meta.defense;
        if (typeof meta.openshellPolicy === "string" && meta.openshellPolicy) openshellPolicy = meta.openshellPolicy;
        if (typeof meta.attackSuccessCount === "number") attackSuccessCount = meta.attackSuccessCount;
        if (typeof meta.attackBlockedCount === "number") attackBlockedCount = meta.attackBlockedCount;
        if (typeof meta.attackInconclusive === "number") attackInconclusive = meta.attackInconclusive;
        if (typeof meta.attackSuccessRate === "number") attackSuccessRate = meta.attackSuccessRate;
      } catch {
        continue; // skip corrupted meta
      }
    } else if (fs.existsSync(summaryPath)) {
      // Parse summary.log header lines
      const content = fs.readFileSync(summaryPath, "utf-8");
      const lines = content.split("\n");
      const headerLine = lines[0] ?? "";
      const modeMatch = headerLine.match(/--\s+(.+?)\s+mode$/);
      mode = modeMatch ? modeMatch[1]! : "";
      date = lines[1]?.replace("Date: ", "").trim() ?? "";
      const countMatch = lines[2]?.match(/(\d+) passed, (\d+) failed, (\d+) skipped/);
      if (countMatch) {
        passed = parseInt(countMatch[1]!);
        failed = parseInt(countMatch[2]!);
        skipped = parseInt(countMatch[3]!);
      }
      result = failed > 0 ? "FAIL" : "PASS";
    } else {
      continue; // no session data in this batch dir
    }

    // Parse test results from summary.log (needed for test-level detail)
    const tests: TestRef[] = [];
    const wsIds = new Set<string>();
    const wsIdsByTestName = new Map<string, string[]>();
    if (wsMap) {
      for (const [wsId, testName] of Object.entries(wsMap)) {
        const existing = wsIdsByTestName.get(testName) ?? [];
        existing.push(wsId);
        wsIdsByTestName.set(testName, existing);
      }
    }
    const wsIdFromMap = (testName: string, usedWsIds: Set<string>): string | null => {
      const ids = wsIdsByTestName.get(testName) ?? [];
      if (ids.length === 1) return ids[0]!;
      for (const id of ids) {
        if (!usedWsIds.has(id)) return id;
      }
      return null;
    };
    // Collect replaced (failed) attempt results for retry display (hoisted for use after the if block)
    const failedAttempts: Record<string, Array<{ elapsed: number | null; reason: string }>> = {};

    if (fs.existsSync(summaryPath)) {
      const raw = fs.readFileSync(summaryPath, "utf-8");
      // Collapse multi-line END markers (caused by embedded newlines in failure
      // reasons, e.g. JSON excerpts) so the per-line parser can match them.
      const content = raw.replace(
        /=== END: \S+ (?:PASS|FAIL)(?:.*?) -- [\s\S]*? ===/g,
        (m) => m.replace(/\r?\n\s*/g, " "),
      );
      const lines = content.split("\n");

      for (const line of lines) {
        for (const wm of line.matchAll(WS_ID_RE)) {
          wsIds.add(wm[1]!);
        }
      }

      const testStartRe = /=== START(?: \(\w+\))?: (\S+?)(?: \[ws:(\d{2})\])? ===$/;
      const lineTimestampRe = /^\[\s*([\d.]+)s\]/;
      const testWsMap: Record<string, Set<string>> = {};
      const testExplicitWs: Record<string, string> = {};
      const testStartTime: Record<string, number> = {};
      const activeTests = new Set<string>();
      const usedWsIds = new Set<string>();

      for (const line of lines) {
        const clean = stripAnsi(line);
        const sm = testStartRe.exec(clean);
        if (sm) {
          activeTests.add(sm[1]!);
          testWsMap[sm[1]!] = new Set();
          if (sm[2]) testExplicitWs[sm[1]!] = sm[2];
          const tm = lineTimestampRe.exec(clean);
          if (tm) testStartTime[sm[1]!] = parseFloat(tm[1]!);
        }

        for (const wsm of clean.matchAll(/\blog-sessions\/(?:\d{8}_\d{6}(?:_\w+)?\/)?(\d{2})\//g)) {
          for (const testName of activeTests) {
            testWsMap[testName]!.add(wsm[1]!);
          }
        }

        const em = TEST_END_RE.exec(clean);
        if (em) {
          let wsId: string | null = testExplicitWs[em[1]!] ?? wsIdFromMap(em[1]!, usedWsIds);
          if (wsId) {
            usedWsIds.add(wsId);
          } else {
            const candidates = testWsMap[em[1]!] ?? new Set();
            for (const id of [...candidates].sort((a, b) => (a === "00" ? 1 : 0) - (b === "00" ? 1 : 0))) {
              if (!usedWsIds.has(id)) {
                wsId = id;
                usedWsIds.add(id);
                break;
              }
            }
          }
          let elapsed: number | null = null;
          const tm = lineTimestampRe.exec(clean);
          if (tm && testStartTime[em[1]!] !== undefined) {
            elapsed = Math.round((parseFloat(tm[1]!) - testStartTime[em[1]!]) * 10) / 10;
          }
          const existingIdx = tests.findIndex(t => t.name === em[1]!);
          const ref: TestRef = {
            name: em[1]!,
            result: em[2] as "PASS" | "FAIL",
            reason: em[3]!,
            wsId,
            elapsed,
          };
          if (existingIdx >= 0) {
            // Save the replaced (failed) attempt's data before overwriting
            const old = tests[existingIdx]!;
            if (!failedAttempts[em[1]!]) failedAttempts[em[1]!] = [];
            failedAttempts[em[1]!].push({ elapsed: old.elapsed, reason: old.reason });
            tests[existingIdx] = ref;
          } else {
            tests.push(ref);
          }
          activeTests.delete(em[1]!);
        }

        // Handle skipped tests: === END (skip): UT-XX×mode SKIP ===
        const sm2 = TEST_SKIP_RE.exec(clean);
        if (sm2) {
          const wsId: string | null = testExplicitWs[sm2[1]!] ?? wsIdFromMap(sm2[1]!, usedWsIds);
          if (wsId) usedWsIds.add(wsId);
          let elapsed: number | null = null;
          const tm = lineTimestampRe.exec(clean);
          if (tm && testStartTime[sm2[1]!] !== undefined) {
            elapsed = Math.round((parseFloat(tm[1]!) - testStartTime[sm2[1]!]) * 10) / 10;
          }
          tests.push({
            name: sm2[1]!,
            result: "SKIP",
            reason: "Skipped",
            wsId,
            elapsed,
          });
          activeTests.delete(sm2[1]!);
        }
      }

      // Assign remaining tests without wsId to unused workspace IDs
      const assignedWsIds = new Set(tests.filter(t => t.wsId).map(t => t.wsId!));
      const unassignedWsIds = [...wsIds].filter(id => id !== "00" && !assignedWsIds.has(id)).sort();
      let unassignedIdx = 0;
      for (const t of tests) {
        if (!t.wsId && unassignedIdx < unassignedWsIds.length) {
          t.wsId = unassignedWsIds[unassignedIdx++]!;
        }
      }
    }

    // Also detect workspace dirs directly (in case summary.log didn't reference them)
    const concreteWsIds = new Set<string>();
    try {
      for (const entry of fs.readdirSync(batchDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d{2}$/.test(entry.name)) {
          wsIds.add(entry.name);
          concreteWsIds.add(entry.name);
        }
      }
    } catch { /* ignore */ }

    // Some no-Docker/simple runs keep the whole OpenClaw state under 00/ while
    // meta.wsMap still contains a logical worker id such as 01. Prefer the
    // only concrete workspace so sidebar clicks do not navigate to a missing dir.
    if (concreteWsIds.size === 1) {
      const [onlyWsId] = [...concreteWsIds];
      for (const test of tests) {
        if (test.wsId && !concreteWsIds.has(test.wsId)) {
          test.wsId = onlyWsId!;
        }
      }
    }

    // Detect retry attempt directories (e.g., "01-a1", "01-a2")
    const retryDirMap: Record<string, string[]> = {};  // wsId -> sorted attempt dir names
    try {
      for (const entry of fs.readdirSync(batchDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const rm = RETRY_DIR_RE.exec(entry.name);
          if (rm) {
            const baseWsId = rm[1]!;
            if (!retryDirMap[baseWsId]) retryDirMap[baseWsId] = [];
            retryDirMap[baseWsId].push(entry.name);
          }
        }
      }
    } catch { /* ignore */ }
    // Sort attempt dirs and attach to matching TestRef with elapsed/reason from failed attempts
    for (const [baseWsId, dirs] of Object.entries(retryDirMap)) {
      dirs.sort();
      const test = tests.find(t => t.wsId === baseWsId);
      if (test) {
        const saved = failedAttempts[test.name] ?? [];
        test.retryAttempts = dirs.map((dir, i): RetryAttemptRef => ({
          dir,
          elapsed: saved[i]?.elapsed ?? null,
          reason: saved[i]?.reason ?? "",
        }));
      }
    }

    // Populate attempt/maxAttempts from testRetries metadata
    if (testRetries) {
      for (const test of tests) {
        const info = testRetries[test.name];
        if (info) {
          test.attempt = info.attempt;
          test.maxAttempts = info.maxAttempts;
        }
      }
    }

    // Add attempt dirs to workspaceIds so the dashboard can load their artifacts
    for (const dirs of Object.values(retryDirMap)) {
      for (const d of dirs) wsIds.add(d);
    }

    // Synthesize entries for workspaces in wsMap that have no parsed test
    // result. If the session is still RUNNING, these are in-progress tests;
    // if finished, they're setup failures that never logged START/END markers.
    if (wsMap) {
      const parsedWsIds = new Set(tests.map(t => t.wsId).filter(Boolean));
      const parsedTestNames = new Set(tests.map(t => t.name));
      const isRunning = result === "RUNNING" || result === "INTERRUPTED";
      for (const [wsId, testId] of Object.entries(wsMap)) {
        if (!parsedWsIds.has(wsId) && !parsedTestNames.has(testId)) {
          tests.push({
            name: testId,
            result: isRunning ? "RUNNING" : "FAIL",
            reason: isRunning ? "" : "No test output (setup failure)",
            wsId,
            elapsed: null,
          });
        }
      }
    }

    sessions.push({
      id: batchId,
      date,
      mode,
      result,
      passed,
      failed,
      skipped,
      total,
      elapsedSec,
      tests,
      workspaceIds: [...wsIds].sort(),
      wsMap,
      docker,
      gitBranch,
      ciActor,
      ciJobUrl,
      symbolFormat,
      defense,
      openshellPolicy,
      attackSuccessCount,
      attackBlockedCount,
      attackInconclusive,
      attackSuccessRate,
    });
  }

  sessions.sort((a, b) => b.id.localeCompare(a.id));
  return sessions;
}
