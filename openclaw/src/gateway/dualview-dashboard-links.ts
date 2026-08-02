import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BOT_BATCH_ID_RE = /^\d{8}_\d{6}$/;

function resolveConfiguredDualViewDashboardPortUrl(): string | undefined {
  const rawPort = process.env.DUALVIEW_DASHBOARD_PORT?.trim();
  if (!rawPort || !/^\d+$/.test(rawPort)) {
    return undefined;
  }
  // Host defaults to loopback (back-compat) but can be overridden so symbol
  // links are clickable from outside the host. For a full base URL
  // (scheme/path), set DUALVIEW_DASHBOARD_URL instead.
  const host = process.env.DUALVIEW_DASHBOARD_HOST?.trim() || "127.0.0.1";
  return `http://${host}:${rawPort}/bot/`;
}

function normalizeDualViewDashboardBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if (url.pathname.endsWith("/bot")) {
    url.pathname = `${url.pathname}/`;
  } else if (!url.pathname.endsWith("/bot/")) {
    const prefix = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    url.pathname = `${prefix}bot/`;
  }
  return url.toString();
}

function safeRealpath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function resolveOpenClawStateDir(stateDir?: string): string | undefined {
  const explicitStateDir = stateDir?.trim();
  return safeRealpath(
    explicitStateDir ||
      process.env.OPENCLAW_STATE_DIR?.trim() ||
      process.env.CLAWDBOT_STATE_DIR?.trim() ||
      path.join(os.homedir(), ".openclaw"),
  );
}

function readSessionIdFromStore(storePath: string, sessionKey: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const store = parsed as Record<string, unknown>;
  const direct = store[sessionKey];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const sessionId = (direct as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  }
  for (const [key, value] of Object.entries(store)) {
    if (key.toLowerCase() !== sessionKey) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sessionId = (value as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId.trim();
      }
    }
  }
  return undefined;
}

function resolveSessionIdForSessionKey(params: {
  sessionKey?: string;
  stateDir?: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return undefined;
  }
  const stateDir = resolveOpenClawStateDir(params.stateDir);
  if (!stateDir) {
    return undefined;
  }

  const storePaths = [path.join(stateDir, "sessions.json")];
  const agentsDir = path.join(stateDir, "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        storePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
      }
    }
  } catch {
    // Per-agent session stores are optional.
  }

  for (const storePath of storePaths) {
    const sessionId = readSessionIdFromStore(storePath, sessionKey);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function resolveDualViewBotBatchId(params: { stateDir?: string } = {}): string | undefined {
  const explicitBatchId =
    process.env.DUALVIEW_BOT_BATCH_ID?.trim() || process.env.DUALVIEW_DASHBOARD_BATCH_ID?.trim();
  if (explicitBatchId) {
    return explicitBatchId;
  }

  const logBase = process.env.DUALVIEW_BOT_LOG_BASE?.trim() || process.env.BOT_LOG_BASE?.trim();
  if (!logBase) {
    return undefined;
  }
  const stateDir = resolveOpenClawStateDir(params.stateDir);
  if (!stateDir) {
    return undefined;
  }

  let entries: string[];
  try {
    entries = fs
      .readdirSync(logBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BOT_BATCH_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return undefined;
  }

  for (const batchId of entries) {
    const batchStateDir = safeRealpath(path.join(logBase, batchId, "00"));
    if (batchStateDir && batchStateDir === stateDir) {
      return batchId;
    }
  }
  return undefined;
}

export function resolveDualViewDashboardUrl(
  params: { sessionKey?: string; sessionId?: string; batchId?: string; stateDir?: string } = {},
): string | undefined {
  const configuredUrl =
    process.env.DUALVIEW_DASHBOARD_URL?.trim() ||
    process.env.DUALVIEW_BOT_DASHBOARD_URL?.trim() ||
    process.env.ADFI_DASHBOARD_URL?.trim();
  const rawUrl = configuredUrl || resolveConfiguredDualViewDashboardPortUrl();
  if (!rawUrl) {
    return undefined;
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeDualViewDashboardBaseUrl(rawUrl);
  } catch {
    return undefined;
  }
  const sessionId =
    params.sessionId?.trim() ||
    resolveSessionIdForSessionKey({ sessionKey: params.sessionKey, stateDir: params.stateDir });
  const batchId =
    params.batchId?.trim() || resolveDualViewBotBatchId({ stateDir: params.stateDir });
  if (batchId && sessionId) {
    return `${baseUrl}#batch/${encodeURIComponent(batchId)}/session/${encodeURIComponent(sessionId)}`;
  }
  return baseUrl;
}
