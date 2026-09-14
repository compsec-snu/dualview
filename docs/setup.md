# Quick Start: Run DualView on Slack

> **Goal**: clone this repo, fill in `.env`, run one command, and have the
> DualView OpenClaw bot live on Slack.

## Repository layout

```
.                  DualView wrapper (run everything from here)
openclaw/          bundled OpenClaw source for this release
plugin/dualview/   DualView OpenClaw plugin
scripts/           bot setup + run scripts
dashboard/         local DualView activity/session dashboard
```

The CLI entry point is `npm run openclaw -- <args>` (which runs
`openclaw/openclaw.mjs`). Run it from the **repo root**, not from `openclaw/`.

## Prerequisites

- Node.js 22.12+
- npm and Git
- An LLM credential (see [LLM credentials](#llm-credentials))
- **Docker** — required for the Docker run path (recommended)
- For the local run path, no extra tooling: the bundled OpenClaw source is built
  automatically (via pnpm, or Node's bundled corepack)

---

## Step 1: Create the Slack app

The easiest path is to create the app from a manifest.

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Paste the manifest from
   [`openclaw/docs/channels/slack.md`](../openclaw/docs/channels/slack.md)
   ("Slack app manifest example"). It already enables Socket Mode, the App Home
   messages tab, and the full bot scope + event list.
3. **Socket Mode → Generate an app-level token** with scope `connections:write`.
   Copy it (`xapp-...`).
4. **Install App to Workspace**, then copy the **Bot User OAuth Token**
   (`xoxb-...`).

If you prefer to configure scopes/events by hand, the authoritative bot scope
and event lists live in that same Slack doc under "Manifest and scope checklist".

---

## Step 2: Configure `.env`

```bash
cp .env.example .env
```

Fill in at minimum:

```bash
# Slack (Socket Mode)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_MODE=socket            # default; set to "http" only for Events API mode

# One LLM credential (see below)
ANTHROPIC_API_KEY=sk-ant-...
```

Both `scripts/setup-openclaw-bot.sh` and `scripts/run-bot.sh` `source` this
root `.env`. The plain `npm run openclaw` path also loads `./.env` from the repo
root.

### LLM credentials

The generated bot config defaults to model
`openai-codex/gpt-5.3-codex-spark` (OpenAI Codex OAuth). If you are using an
Anthropic key instead, override the model so the bot does not try to use Codex:

```bash
DUALVIEW_BOT_MODEL=anthropic/claude-opus-4-8
```

Accepted credentials (auth is tried in this order by `run-bot.sh`):

1. OpenAI Codex OAuth (`OPENAI_CODEX_ACCESS` / `OPENAI_CODEX_REFRESH`, or
   `~/.codex/auth.json`)
2. Provider API keys: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`,
   `OPENROUTER_API_KEY`, or `FOUNDRY_ENDPOINT` + `FOUNDRY_KEY`
3. Existing OpenClaw auth profiles under `~/.openclaw`

For Qwen3.5-4B through Microsoft Foundry:

```bash
FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
FOUNDRY_KEY=...
FOUNDRY_MODEL=qwen35-4b
```

`FOUNDRY_MODEL` is the deployment name, not just the catalog model name. The
model must be deployed in the Foundry project before the bot can use it. With
Foundry credentials present, the Docker setup defaults to
`microsoft-foundry/$FOUNDRY_MODEL`.

The managed endpoint enables Qwen reasoning by default and rejects the upstream
`chat_template_kwargs.enable_thinking` override. Keep enough completion-token
budget for reasoning.

For Qwen3.5-9B through OpenRouter:

```bash
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=qwen/qwen3.5-9b
```

OpenClaw uses its native `openrouter` provider and the generated auth profile
`openrouter:default`. When both OpenRouter and Foundry credentials are present,
the bot setup defaults to `openrouter/$OPENROUTER_MODEL`; `--model` or
`DUALVIEW_BOT_MODEL` still takes precedence.

---

## Step 3: Run

There are two run paths. **Use Docker for the easiest isolated setup** — it
builds everything and keeps bot state under this repo. The local path runs
directly on this machine against your own `~/.openclaw` state.

### Docker (recommended)

Builds OpenClaw for you and runs a fully configured, persistent bot in a
container.

```bash
./scripts/setup-openclaw-bot.sh --channel slack
```

What it does:

- auto-detects token-backed channels (here, Slack) from `.env`
- generates `tmp-runs/bot/generated/openclaw-bot.json` from the template at
  `config/openclaw-bot.json`
- builds the `openclaw:local` and `dualview-bot:local` Docker images
- starts the `dualview-bot` container on port **18800** and waits for health

Useful flags:

- `--open-access` — for a private workspace: DM policy open, group policy
  open, `allowFrom ["*"]`, and Slack `requireMention` false (the bot replies
  without being @-mentioned).
- `--model <id>` — override the bot model (otherwise `DUALVIEW_BOT_MODEL` or
  `openai-codex/gpt-5.3-codex-spark`).
- `--no-run` — only generate the config, do not start Docker.
- `--dualview-targets <csv>` / `--dualview-disable-targets <csv>` — scope which
  channels DualView inspects (e.g. `slack:C0123456789`).

See `./scripts/setup-openclaw-bot.sh --help` for the full list.

Once healthy, message the bot in Slack (DM or `@`-mention in a channel).

### Local (non-Docker)

```bash
./scripts/run-bot-local.sh
```

What it does:

- validates the required `.env` values and **errors out** if a Slack token or
  LLM credential is missing (no half-started gateway)
- builds the bundled OpenClaw automatically if `openclaw/dist` is missing — no
  manual setup; it uses pnpm if present, otherwise Node's bundled corepack
- installs and enables the DualView plugin into `~/.openclaw`
- runs the gateway on port **18789**

Useful flags: `--port <port>`, `--model <id>` (e.g. `anthropic/claude-opus-4-8`),
`--skip-build`, `--no-plugin`. See `./scripts/run-bot-local.sh --help`.

This path runs against your real `~/.openclaw/` state directory (config, plugin
registration, sessions). For an isolated, persistent bot use the Docker path.

For manual plugin development against the bundled OpenClaw runtime, see the
Development section in [`README.md`](../README.md). Normal bot runs should use
`scripts/setup-openclaw-bot.sh` or `scripts/run-bot-local.sh` so plugin setup,
config generation, and credential preflight stay consistent.

Slack auto-enables when `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` are present; the
default mode is Socket Mode.

---

## Where is `openclaw.json`?

There is no committed runtime `openclaw.json`. It is produced/used as follows:

| Path | Role |
|------|------|
| `config/openclaw-bot.json` | template the setup script starts from |
| `tmp-runs/bot/generated/openclaw-bot.json` | config generated by `setup-openclaw-bot.sh` |
| `tmp-runs/node/.openclaw/openclaw.json` | runtime config inside the Docker bot (bind-mounted) |
| `~/.openclaw/openclaw.json` | runtime config for the local (non-Docker) path |

`tmp-runs/` is gitignored runtime state.

---

## Migrating from an existing OpenClaw install

This is **not** a full migration. The only thing reused is your Slack/Telegram/
Discord **tokens**:

- When `SLACK_BOT_TOKEN` (etc.) is unset in `.env`/env, `setup-openclaw-bot.sh`
  imports the default-account channel tokens from `~/.openclaw/openclaw.json`
  into the process environment and forwards them to the container.
- Your existing sessions, workspace, model config, and other settings are **not**
  carried over — the script generates a fresh DualView bot config each run.

So if you already had Slack working in a local OpenClaw, you can run the setup
script without re-entering tokens, but everything else starts clean.

---

## Dashboard (optional)

```bash
npm run dashboard
```

Shows DualView activity/sessions. Set `DUALVIEW_DASHBOARD_URL` before running the
bot if you want Slack symbol links to point at a hosted dashboard.

---

## Troubleshooting

- **`missing dist/entry.(m)js`** — the bundled OpenClaw is not built.
  Both run paths build it for you (`run-bot-local.sh` locally, Docker in its
  image); only `--skip-build` leaves it to you.
- **`No LLM credential found` / `Slack is enabled but required value(s) missing`** —
  a required `.env` value is missing. Both run paths preflight `.env` and stop
  before doing any work; fill in the value the error names.
- **`No LLM credentials found`** — set one of the credentials in
  [LLM credentials](#llm-credentials), or pass `--anthropic-key`.
- **Bot connects but never replies** — in a non-`--open-access` setup, channel
  messages require an `@`-mention, and DMs use pairing by default. Use
  `--open-access` for a private workspace.
- **Port already in use** — pass `--port <port>` to the setup/run script
  (default 18800).
