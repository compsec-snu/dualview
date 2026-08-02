import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDualViewDashboardUrl } from "./dualview-dashboard-links.js";

const ENV_KEYS = [
  "DUALVIEW_DASHBOARD_URL",
  "DUALVIEW_BOT_DASHBOARD_URL",
  "ADFI_DASHBOARD_URL",
  "DUALVIEW_DASHBOARD_PORT",
  "DUALVIEW_DASHBOARD_HOST",
  "DUALVIEW_BOT_BATCH_ID",
  "DUALVIEW_DASHBOARD_BATCH_ID",
  "DUALVIEW_BOT_LOG_BASE",
  "BOT_LOG_BASE",
  "OPENCLAW_STATE_DIR",
  "CLAWDBOT_STATE_DIR",
] as const;

const tempDirs: string[] = [];

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function createStateDirWithSessionStore(store: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dashboard-links-"));
  tempDirs.push(dir);
  const sessionsDir = path.join(dir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(store), "utf8");
  return dir;
}

describe("resolveDualViewDashboardUrl", () => {
  beforeEach(clearEnv);
  afterEach(() => {
    clearEnv();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not guess a dashboard URL when none is configured", () => {
    expect(resolveDualViewDashboardUrl()).toBeUndefined();
  });

  it("can derive a local bot dashboard URL from an explicit port", () => {
    process.env.DUALVIEW_DASHBOARD_PORT = "3456";
    expect(resolveDualViewDashboardUrl()).toBe("http://127.0.0.1:3456/bot/");
  });

  it("uses DUALVIEW_DASHBOARD_HOST for the port-derived URL when set", () => {
    process.env.DUALVIEW_DASHBOARD_PORT = "3457";
    process.env.DUALVIEW_DASHBOARD_HOST = "dashboard.example.test";
    expect(resolveDualViewDashboardUrl()).toBe("http://dashboard.example.test:3457/bot/");
  });

  it("ignores DUALVIEW_DASHBOARD_HOST when no port is configured", () => {
    process.env.DUALVIEW_DASHBOARD_HOST = "dashboard.example.test";
    expect(resolveDualViewDashboardUrl()).toBeUndefined();
  });

  it("opens the bot dashboard when only a session key is known", () => {
    process.env.DUALVIEW_DASHBOARD_URL = "http://127.0.0.1:3456/bot/";
    expect(
      resolveDualViewDashboardUrl({
        sessionKey: "agent:main:slack:channel:C123:thread:1700.1",
      }),
    ).toBe("http://127.0.0.1:3456/bot/");
  });

  it("prefers a concrete batch/session URL when the session id is known", () => {
    process.env.DUALVIEW_DASHBOARD_URL = "http://127.0.0.1:3456/bot/";
    process.env.DUALVIEW_BOT_BATCH_ID = "20260623_144338";
    expect(
      resolveDualViewDashboardUrl({
        sessionKey: "agent:main:slack:channel:c0ahk77p1mz",
        sessionId: "d739b35d-808c-4649-bcd7-eeadc67bf054",
      }),
    ).toBe(
      "http://127.0.0.1:3456/bot/#batch/20260623_144338/session/d739b35d-808c-4649-bcd7-eeadc67bf054",
    );
  });

  it("resolves a known session key through the OpenClaw session store", () => {
    const stateDir = createStateDirWithSessionStore({
      "agent:main:slack:channel:c123": {
        sessionId: "d739b35d-808c-4649-bcd7-eeadc67bf054",
      },
    });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.DUALVIEW_DASHBOARD_URL = "http://127.0.0.1:3456/bot/";
    process.env.DUALVIEW_BOT_BATCH_ID = "20260623_144338";

    expect(
      resolveDualViewDashboardUrl({
        sessionKey: "agent:main:slack:channel:C123",
      }),
    ).toBe(
      "http://127.0.0.1:3456/bot/#batch/20260623_144338/session/d739b35d-808c-4649-bcd7-eeadc67bf054",
    );
  });

  it("normalizes a configured dashboard root to bot mode", () => {
    process.env.DUALVIEW_DASHBOARD_URL = "http://dash.example.test:3457";
    expect(resolveDualViewDashboardUrl()).toBe("http://dash.example.test:3457/bot/");
  });

  it("keeps a configured bot dashboard path", () => {
    process.env.DUALVIEW_BOT_DASHBOARD_URL = "http://dash.example.test:3457/tools/bot";
    expect(resolveDualViewDashboardUrl()).toBe("http://dash.example.test:3457/tools/bot/");
  });

  it("skips links when the configured URL is invalid", () => {
    process.env.DUALVIEW_DASHBOARD_URL = "not a url";
    expect(resolveDualViewDashboardUrl()).toBeUndefined();
  });
});
