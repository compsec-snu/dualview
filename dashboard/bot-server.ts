#!/usr/bin/env npx tsx
/**
 * DualView Bot Dashboard Server entrypoint.
 *
 * Usage:
 *   npx tsx dashboard/bot-server.ts [--port 3456] [--bot-dir <path>]
 *
 * This is intentionally bot-only by default. The shared server implementation
 * still owns auth, static serving, and API routing, but callers should not need
 * to remember a bot-only flag.
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`DualView Bot Dashboard Server

Usage:
  npx tsx dashboard/bot-server.ts [options]

Options:
  --port <number>      Port to listen on (default: 3456)
  --bot-dir <path>     Bot log-sessions directory
  --help, -h           Show this help message

Environment variables:
  DASHBOARD_PORT       Port to listen on (default: 3456, overridden by --port)
  DASHBOARD_PASSWORD   Password for login page (unset = no auth)
  DASHBOARD_TIMEZONE   IANA timezone for timestamps (e.g. Asia/Seoul; default: system TZ)
  DASHBOARD_BASE_PATH  URL prefix for reverse proxy (e.g. /dualview)
  DUALVIEW_BOT_DIR     Bot log-sessions directory (--bot-dir overrides)`);
  process.exit(0);
}

process.env.DASHBOARD_BOT_ONLY = "1";
process.env.DASHBOARD_DEFAULT_MODE = "bot";

await import("./server.js");
