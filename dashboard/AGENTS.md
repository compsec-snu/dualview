# dashboard

HTTP dashboard for viewing bot session logs, conversation traces, audit events, git history, file diffs, and assertion outcomes.

## Running

```
npx tsx dashboard/bot-server.ts [--port 3456]
```

Environment variables: `DASHBOARD_PORT`, `DASHBOARD_PASSWORD`, `DASHBOARD_TIMEZONE`, `DASHBOARD_BASE_PATH`, `DUALVIEW_BOT_DIR`.
The default dashboard entrypoint is bot-only. The legacy all-mode server remains at `dashboard/server.ts`.

## Directory Layout

```
dashboard/
  index.html            HTML skeleton (loads CSS + JS modules)
  dashboard.css         All styles (6 themes)
  bot-server.ts         Bot-only server entrypoint used by `npm run dashboard`
  server.ts             Shared HTTP server implementation, auth, static file serving
  api.ts                Barrel re-export for api/ modules
  api/
    types.ts            Interfaces, regexes, path constants
    utils.ts            stripAnsi, JSONL parser, json helper, DUALVIEW metadata parser
    sessions.ts         Session list parsing (meta.json / summary.log)
    logs.ts             Log entry parsing (summary + per-workspace)
    workspace.ts        File views, conversation/audit/notify data
    git.ts              Git log, commit detail, DUALVIEW commits by callId
    routes.ts           REST API route handler
  js/
    state.js            Shared app state object + api() helper
    utils.js            Pure utilities (escaping, timestamps, symbols, selectors)
    render-helpers.js   JSON tree, content blocks, audit inline, diffs, ref badges
    conversation.js     Conversation tab (timeline, tool calls, assertions, symbols)
    views.js            Log, Audit table, Git, Files, Test Spec tabs
    main.js             Entry point: init, events, sidebar, session mgmt, theme
```

## Architecture Notes

- **Backend** (`api/`): TypeScript modules, each under 300 lines. `server.ts` imports only the barrel `api.ts`.
- **Frontend** (`js/`): Vanilla ES modules (no bundler). All state lives in a single `S` object exported from `state.js`. Functions referenced by inline `onclick` handlers are exposed on `window` in `main.js`.
- **Static assets**: `server.ts` serves `*.css`, `js/*.js`, and `assets/*.png` from the dashboard directory with allowlist-based path validation.
- **Bot-only server**: `bot-server.ts` serves only `/bot/`, redirects root/login to bot mode, and hides e2e/eval mode switching in the frontend.

## Conventions

- Frontend is vanilla JS with no build step. Keep it that way.
- Dynamically generated HTML uses `onclick="fn()"` — any new function called this way must be added to the `Object.assign(window, ...)` block at the bottom of `main.js`.
- Backend modules use `import`/`export` with `.js` extensions in import paths (required for ESM with `tsx`).
- CSS uses CSS custom properties for theming. Add new theme overrides in the theme-specific sections at the top of `dashboard.css`.
