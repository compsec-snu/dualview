# DualView

DualView is an OpenClaw plugin that keeps untrusted tool output out of the
trusted agent context. It replaces untrusted values with opaque symbols, tracks
those symbols across tool calls and file writes, and lets the agent request
isolated transformations through `inspect_symbol` when a task needs the
underlying content.

This repository includes the DualView plugin, the OpenClaw source version used
for this release, and the local dashboard.

## Repository Layout

```
plugin/dualview/   DualView OpenClaw plugin
openclaw/          bundled OpenClaw source for this release
dashboard/         local DualView activity/session dashboard
```

## Requirements

- Node.js 22.12 or newer
- npm
- Git

## Install

```sh
npm install
```

Confirm that the bundled OpenClaw runtime starts:

```sh
npm run openclaw -- --version
```

## OpenClaw Bot

See [`docs/setup.md`](docs/setup.md) for the full Slack quick start (creating the
Slack app, required `.env` values, and both run paths).

There are two ways to run the bot. Both validate `.env` on startup and stop with
a clear error if a required Slack token or LLM credential is missing, and both
build the bundled OpenClaw automatically.

- **Docker (recommended; isolated, persistent):**
  `./scripts/setup-openclaw-bot.sh --channel slack`
- **Local (non-Docker; runs against `~/.openclaw`):** `./scripts/run-bot-local.sh`

For a Slack/Telegram/Discord bot run, put credentials in `.env` or the shell
environment, then run the setup script:

```sh
cp .env.example .env
# Fill Codex OAuth or another LLM auth method and one channel token set, then:
./scripts/setup-openclaw-bot.sh --channel slack --open-access
```

The script writes `tmp-runs/bot/generated/openclaw-bot.json` without channel
tokens, starts Docker through `scripts/run-bot.sh`, and enables DualView for the
configured channels. If channel token env vars are unset, it imports the
default-account tokens from `~/.openclaw/openclaw.json` into the process
environment without writing them to the generated config file. The default model
is `openai-codex/gpt-5.3-codex-spark`; override it with `--model` or
`DUALVIEW_BOT_MODEL`.
The `inspect_symbol` U-LLM fallback/logging model follows the same model unless
`DUALVIEW_BOT_INSPECT_MODEL` is set.

Use the setup script for normal starts and restarts:

```sh
./scripts/setup-openclaw-bot.sh --channel slack --open-access
```

To run from a checked-in or local config file instead of CLI target/model flags,
pass the config explicitly:

```sh
./scripts/setup-openclaw-bot.sh --config config/openclaw-bot-dualview.json
```

Secrets still come from `.env`, the shell environment, or
`~/.openclaw/openclaw.json`; do not write channel tokens into config files. The
checked-in `config/openclaw-bot-dualview.json` is an example for a
DualView-limited Slack channel. Copy it and replace the example channel ID for
local deployments.

Bot config files may include runner-only settings under `dualviewBot`. These are
read by `scripts/setup-openclaw-bot.sh` / `scripts/run-bot.sh` and stripped
before the OpenClaw runtime config is written:

```json
{
  "dualviewBot": {
    "port": 18801,
    "dashboard": {
      "port": 13457,
      "host": "dashboard.example.test",
      "timezone": "Asia/Seoul"
    }
  }
}
```

`dualviewBot.port` controls the gateway port. `dualviewBot.dashboard.port`
controls the dashboard port and Slack symbol-link port.
`dualviewBot.dashboard.host` controls the public host used in Slack links; leave
host-specific values out of committed configs and set them in a local config or
`DUALVIEW_DASHBOARD_HOST`. `dualviewBot.dashboard.timezone` controls dashboard
timestamp display; omit it to use the system timezone.

Do not restart a Slack/Telegram/Discord bot with `scripts/run-bot.sh` directly
unless the channel token environment variables are already exported in that
shell. `run-bot.sh` only forwards existing env vars into Docker; it does not
import default-account channel tokens from `~/.openclaw/openclaw.json`.

By default, DualView targets every enabled external platform with entries such
as `slack:*`. To keep the bot active broadly while disabling DualView in a
specific channel, keep the broad target and pass a disable list:

```sh
./scripts/setup-openclaw-bot.sh --channel slack --open-access \
  --dualview-disable-targets slack:C0123456789
```

The target is the Slack channel ID, not the `#channel-name`. This is useful when
the bot should respond in a channel such as `#proj-adfi`, but DualView should
not inspect that channel. Disable entries take precedence over allowlist entries,
so `targetChannels: ["slack:*"]` plus
`disabledTargetChannels: ["slack:C0123456789"]` enables DualView for Slack
except that one channel.

To enable DualView only for selected channels instead, pass an explicit target
allowlist:

```sh
./scripts/setup-openclaw-bot.sh --channel slack --open-access \
  --dualview-targets slack:C0123456789
```

For a config-only dry run:

```sh
./scripts/setup-openclaw-bot.sh --channels slack,telegram --no-run
```

## Dashboard

Start the dashboard:

```sh
npm run dashboard
```

Open `http://127.0.0.1:3456/`. The default dashboard is bot-only and redirects
to `/bot/`. Override the bot log directory with `DUALVIEW_BOT_DIR` when viewing
a different run directory.

Useful environment variables:

```sh
DASHBOARD_PORT=3456
DASHBOARD_PASSWORD=
DUALVIEW_BOT_DIR=/path/to/bot/log-sessions
```

## Development

For normal bot runs, use the scripts above. They install and enable the
DualView plugin as needed.

If you are developing the plugin against the bundled OpenClaw runtime manually:

```sh
npm install
npm install --prefix plugin/dualview
npm run openclaw -- plugins install ./plugin/dualview --link
npm run openclaw -- plugins enable dualview
npm run openclaw -- gateway run
```

`--link` makes OpenClaw load the plugin from this working tree instead of a
copied plugin snapshot. That is useful for development because edits under
`plugin/dualview/` are picked up without reinstalling the plugin. If the repo is
moved or deleted, the linked plugin path must be reinstalled.

DualView options are documented in
`plugin/dualview/openclaw.plugin.json`. The most common settings are:

- `targetSessionIds`: session key fragments where DualView should run
- `targetChannels`: channel IDs or platform wildcards where DualView should run
- `disabledTargetChannels`: channel IDs or platform wildcards where DualView
  should not run, even if a broad target such as `slack:*` matches
- `disabledTargetSessionIds`: session key fragments where DualView should not run
- `policyPath`: path to a `dualview-policy.yaml` data trust policy
- `fileTrackingEnabled`: enable git-based trusted/untrusted file tracking

```sh
npm run typecheck
```

## Acknowledgements

Contributors:

- Juhee Kim (Seoul National University)
- Woohyuk Choi (Seoul National University)
- Taehyun Kang (Seoul National University)
- Youngmin Kim (Seoul National University)
- Byoungyoung Lee (Seoul National University)

This project was supported by LG Electronics.
