#!/usr/bin/env npx tsx
/**
 * DualView Test Dashboard Server
 *
 * Usage:
 *   npx tsx dashboard/server.ts [--port 3456]
 *
 * Environment variables:
 *   DASHBOARD_PORT       Port to listen on (default: 3456, overridden by --port)
 *   DASHBOARD_PASSWORD   HTTP Basic Auth password (any username accepted; unset = no auth)
 *   DASHBOARD_TIMEZONE   IANA timezone for timestamp display (e.g. Asia/Seoul; default: system TZ)
 *   DASHBOARD_DEFAULT_MODE Root/login redirect target: e2e, bot, or eval (default: e2e)
 *   DASHBOARD_BOT_ONLY   Serve only the bot dashboard (1/true/yes)
 *   DUALVIEW_WORKSPACE_DIR   E2E session directory (default: test/log-sessions)
 *   DUALVIEW_BOT_DIR         Bot log-sessions directory (enables bot mode in dashboard)
 */

import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, extname } from "node:path";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { handleApiRequest } from "./api.js";
import { setBotSessionsDir, setEvalResultsDir } from "./api/types.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`DUALVIEW Dashboard Server

Usage:
  npx tsx dashboard/server.ts [options]

Options:
  --port <number>      Port to listen on (default: 3456)
  --bot-dir <path>     Bot log-sessions directory (enables bot mode)
  --bot-only           Serve only the bot dashboard; root redirects to /bot/
  --help, -h           Show this help message

Environment variables:
  DASHBOARD_PORT       Port to listen on (default: 3456, overridden by --port)
  DASHBOARD_PASSWORD   Password for login page (unset = no auth)
  DASHBOARD_TIMEZONE   IANA timezone for timestamps (e.g. Asia/Seoul; default: system TZ)
  DASHBOARD_BASE_PATH  URL prefix for reverse proxy (e.g. /dualview-test)
  DASHBOARD_DEFAULT_MODE Root/login redirect target: e2e, bot, or eval (default: e2e)
  DASHBOARD_BOT_ONLY   Serve only the bot dashboard (1/true/yes)
  DUALVIEW_WORKSPACE_DIR   E2E session directory (default: test/log-sessions)
  DUALVIEW_BOT_DIR         Bot log-sessions directory (enables bot mode; --bot-dir overrides)
  DUALVIEW_EVAL_DIR        Eval results directory (default: test/eval/results)`);
  process.exit(0);
}

// --eval-dir flag overrides DUALVIEW_EVAL_DIR env var
const evalDirIdx = process.argv.indexOf("--eval-dir");
if (evalDirIdx !== -1 && process.argv[evalDirIdx + 1]) {
  setEvalResultsDir(process.argv[evalDirIdx + 1]!);
}

// --bot-dir flag overrides DUALVIEW_BOT_DIR env var
const botDirIdx = process.argv.indexOf("--bot-dir");
if (botDirIdx !== -1 && process.argv[botDirIdx + 1]) {
  setBotSessionsDir(process.argv[botDirIdx + 1]!);
} else if (!process.env.DUALVIEW_BOT_DIR) {
  // Auto-discover bot log directory.
  // Prefer tmp-runs/bot/ inside the project, fall back to legacy paths.
  const DUALVIEW_ROOT = join(new URL(".", import.meta.url).pathname, "..");
  const candidates = [
    join(DUALVIEW_ROOT, "tmp-runs", "bot", "log-sessions"),
    join(homedir(), ".dualview-bot", "log-sessions"),
    "/srv/adfi-bot/log-sessions",
    "/srv/dualview-bot/log-sessions",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      setBotSessionsDir(candidate);
      break;
    }
  }
}

const DASHBOARD_DIR = new URL(".", import.meta.url).pathname;
const HTML_PATH = join(DASHBOARD_DIR, "index.html");

// Port: --port flag > DASHBOARD_PORT env > default 3456
let port = 3456;
if (process.env.DASHBOARD_PORT) {
  port = parseInt(process.env.DASHBOARD_PORT, 10);
}
const portIdx = process.argv.indexOf("--port");
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  port = parseInt(process.argv[portIdx + 1]!, 10);
}
process.env.DASHBOARD_PORT = String(port);

// Base path for reverse proxy (e.g. "/dualview-test"), no trailing slash
const BASE_PATH = (process.env.DASHBOARD_BASE_PATH ?? "").replace(/\/+$/, "");
type DashboardMode = "e2e" | "bot" | "eval";
const DASHBOARD_MODES = new Set<DashboardMode>(["e2e", "bot", "eval"]);
const DASHBOARD_BOT_ONLY = process.argv.includes("--bot-only")
  || /^(1|true|yes)$/i.test(process.env.DASHBOARD_BOT_ONLY ?? "");
const ALLOWED_MODES = new Set<DashboardMode>(DASHBOARD_BOT_ONLY ? ["bot"] : DASHBOARD_MODES);
const DEFAULT_MODE: DashboardMode = (() => {
  if (DASHBOARD_BOT_ONLY) return "bot";
  const mode = process.env.DASHBOARD_DEFAULT_MODE?.trim();
  return ALLOWED_MODES.has(mode as DashboardMode) ? (mode as DashboardMode) : "e2e";
})();
const ALLOWED_MODE_LIST = [...ALLOWED_MODES].join(",");
process.env.DASHBOARD_ALLOWED_MODES = ALLOWED_MODE_LIST;
process.env.DASHBOARD_RESOLVED_DEFAULT_MODE = DEFAULT_MODE;
if (DASHBOARD_BOT_ONLY) process.env.DASHBOARD_BOT_ONLY = "1";

// Timezone: DASHBOARD_TIMEZONE env > system default
const DASHBOARD_TIMEZONE = (() => {
  const tz = process.env.DASHBOARD_TIMEZONE?.trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
      return tz;
    } catch { /* invalid timezone, fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
})();

// Auth: set DASHBOARD_PASSWORD env var to enable login page
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";
const SESSION_SECRET = randomBytes(32).toString("hex");

function makeSessionToken(password: string): string {
  return createHash("sha256").update(password + SESSION_SECRET).digest("hex");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k] = v.join("=");
  }
  return cookies;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${DASHBOARD_BOT_ONLY ? "DualView Bot Dashboard" : "DUALVIEW Dashboard"} — Login</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
    display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .login { background: #16213e; padding: 2rem; border-radius: 8px; width: 320px; }
  .login h1 { font-size: 1.2rem; margin: 0 0 1.5rem; text-align: center; }
  .login input { width: 100%; padding: 0.6rem; margin-bottom: 1rem; border: 1px solid #333;
    border-radius: 4px; background: #0f3460; color: #e0e0e0; font-size: 1rem; box-sizing: border-box; }
  .login button { width: 100%; padding: 0.6rem; background: #e94560; color: #fff; border: none;
    border-radius: 4px; font-size: 1rem; cursor: pointer; }
  .login button:hover { background: #c73e54; }
  .error { color: #e94560; font-size: 0.85rem; margin-bottom: 0.5rem; display: none; }
</style>
</head><body>
<form class="login" method="POST" action="${BASE_PATH}/login">
  <h1>${DASHBOARD_BOT_ONLY ? "DualView Bot Dashboard" : "DualView Test Dashboard"}</h1>
  <div class="error" id="err">Wrong password</div>
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Log in</button>
</form>
<script>if(location.search.includes("err=1"))document.getElementById("err").style.display="block"</script>
</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => resolve(data));
  });
}

function isAuthed(req: IncomingMessage): boolean {
  if (!DASHBOARD_PASSWORD) return true;
  const token = parseCookies(req)["dualview_session"];
  return token === makeSessionToken(DASHBOARD_PASSWORD);
}

const server = createServer(async (req, res) => {
  const rawUrl = req.url ?? "";

  // Strip base path prefix to get the local route
  let url = rawUrl;
  if (BASE_PATH && url.startsWith(BASE_PATH)) {
    url = url.slice(BASE_PATH.length) || "/";
  }

  // Login page — always accessible
  if (url === "/login" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(LOGIN_PAGE);
    return;
  }

  // Login form submission
  if (url === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const password = params.get("password") ?? "";
    if (password === DASHBOARD_PASSWORD) {
      const token = makeSessionToken(password);
      res.writeHead(302, {
        "Set-Cookie": `dualview_session=${token}; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Strict`,
        Location: `${BASE_PATH}/${DEFAULT_MODE}/`,
      });
      res.end();
    } else {
      res.writeHead(302, { Location: `${BASE_PATH}/login?err=1` });
      res.end();
    }
    return;
  }

  // Logout
  if (url === "/logout") {
    res.writeHead(302, {
      "Set-Cookie": `dualview_session=; Path=${BASE_PATH || "/"}; HttpOnly; Max-Age=0`,
      Location: `${BASE_PATH}/login`,
    });
    res.end();
    return;
  }

  // All other routes require auth
  if (!isAuthed(req)) {
    res.writeHead(302, { Location: `${BASE_PATH}/login` });
    res.end();
    return;
  }

  // Strip query string for route matching (query params are client-side state)
  const urlPath = url.split("?")[0];

  // Root → redirect to the configured default mode.
  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(302, { Location: `${BASE_PATH}/${DEFAULT_MODE}/` });
    res.end();
    return;
  }

  // Mode routes: /e2e/, /bot/, /eval/
  const modeMatch = urlPath.match(/^\/(e2e|bot|eval)\/?$/);
  if (modeMatch) {
    const mode = modeMatch[1]!;
    if (!ALLOWED_MODES.has(mode as DashboardMode)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Dashboard mode "${mode}" is disabled`);
      return;
    }
    // Normalize: redirect /e2e to /e2e/
    if (!urlPath.endsWith("/")) {
      res.writeHead(302, { Location: `${BASE_PATH}/${mode}/` });
      res.end();
      return;
    }
    let html = readFileSync(HTML_PATH, "utf-8");
    html = html.replace("<head>", `<head>\n<meta name="base-path" content="${BASE_PATH}">\n<meta name="dashboard-mode" content="${mode}">\n<meta name="dashboard-modes" content="${ALLOWED_MODE_LIST}">\n<meta name="dashboard-timezone" content="${DASHBOARD_TIMEZONE}">`);
    // Make asset paths absolute so they resolve correctly under /e2e/ and /bot/
    html = html.replace('href="dashboard.css"', `href="${BASE_PATH}/dashboard.css"`);
    html = html.replace('src="assets/dualview-logo.png"', `src="${BASE_PATH}/assets/dualview-logo.png"`);
    html = html.replace('src="js/main.js"', `src="${BASE_PATH}/js/main.js"`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (urlPath.startsWith("/api/")) {
    handleApiRequest(url, res);
    return;
  }

  // Serve static assets (CSS, JS, images) from the dashboard directory
  const MIME_TYPES: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
  };
  const ext = extname(urlPath);
  if (MIME_TYPES[ext]) {
    // Allow files at root and in js/ or assets/ subdirectories.
    const relPath = urlPath.slice(1); // strip leading /
    if (relPath && /^(?:(?:js|assets)\/)?[a-zA-Z0-9_.-]+$/.test(relPath)) {
      const filePath = join(DASHBOARD_DIR, relPath);
      if (existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext], "Cache-Control": "no-store" });
        res.end(readFileSync(filePath));
        return;
      }
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

function checkPortInUse(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port: p, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function startServer() {
  const inUse = await checkPortInUse(port);
  if (inUse) {
    const answer = await ask(
      `Port ${port} is already in use. Kill the existing server and take over? [y/N] `,
    );
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      process.exit(0);
    }
    // Find and kill the process using this port
    const { execSync } = await import("node:child_process");
    try {
      const pid = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8" }).trim();
      if (pid) {
        for (const p of pid.split("\n")) {
          console.log(`Killing PID ${p} on port ${port}`);
          process.kill(parseInt(p, 10), "SIGTERM");
        }
        // Brief wait for the port to free up
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch {
      console.error(`Could not find/kill process on port ${port}. Try manually.`);
      process.exit(1);
    }
  }

  server.listen(port, () => {
    const base = `http://${hostname()}:${port}${BASE_PATH}`;
    console.log(`DUALVIEW Dashboard:`);
    if (ALLOWED_MODES.has("e2e")) console.log(`  E2E: ${base}/e2e/`);
    if (ALLOWED_MODES.has("eval")) console.log(`  Eval: ${base}/eval/`);
    if (DASHBOARD_PASSWORD) console.log("Password protection enabled");
    // Import BOT_SESSIONS_DIR dynamically to get the (possibly overridden) value
    import("./api/types.js").then(({ BOT_SESSIONS_DIR }) => {
      if (ALLOWED_MODES.has("bot") && (DASHBOARD_BOT_ONLY || BOT_SESSIONS_DIR)) {
        console.log(`  Bot: ${base}/bot/`);
      }
    });
  });
}

startServer();
