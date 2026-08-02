#!/usr/bin/env bash
# Generate a DualView OpenClaw bot config from environment variables and run it.
#
# The generated config intentionally does not write channel bot tokens. OpenClaw
# reads default-account channel tokens from the container environment, and
# scripts/run-bot.sh forwards the relevant variables into Docker.
set -euo pipefail

DUALVIEW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'HELP'
Usage: ./scripts/setup-openclaw-bot.sh [options]

Creates tmp-runs/bot/generated/openclaw-bot.json from .env/environment values,
then starts the Docker bot via scripts/run-bot.sh unless --no-run is set.

Options:
  --config <path>        Use an existing openclaw.json instead of generating one.
                         Channel tokens are still loaded from .env or
                         ~/.openclaw/openclaw.json and forwarded to Docker.
  --channel <name>       Enable one channel. Repeatable. Supported:
                         slack, telegram, discord, webchat.
  --channels <csv>       Enable a comma-separated channel list.
                         Default: auto-detect token-backed channels + webchat.
  --open-access          Convenience mode for private workspaces:
                         DM policy open, group policy open, allowFrom ["*"],
                         and Slack requireMention false.
  --output <path>        Generated config path
                         (default: tmp-runs/bot/generated/openclaw-bot.json)
  --port <port>          Gateway port passed to run-bot.sh (default: 18800)
  --seed-gws-demo        Seed local fws Gmail/Calendar/Drive demo data on start
  --model <model-id>     Bot model (default: openai-codex/gpt-5.3-codex-spark)
  --dualview-targets <csv>
                         Comma-separated DualView target channels/session ids.
                         Example: slack:C0123456789
  --dualview-disable-targets <csv>
                         Comma-separated DualView target channels/session ids
                         to disable. Takes precedence over broad targets such
                         as slack:*.
  --openclaw-dir <path>  OpenClaw source directory passed to run-bot.sh
                         (default: ./openclaw)
  --anthropic-key <key>  Anthropic key passed to run-bot.sh
  --no-run               Only generate the config.
  --run                  Generate and run (default).
  -h, --help             Show this help.

Environment:
  SLACK_BOT_TOKEN        Slack bot token (xoxb-...)
  SLACK_APP_TOKEN        Slack app token for Socket Mode (xapp-...)
  SLACK_MODE             socket (default) or http
  SLACK_SIGNING_SECRET   Required only when SLACK_MODE=http
  SLACK_ALLOW_FROM       Comma-separated Slack user IDs for DM allowlist
  SLACK_CHANNELS         Comma-separated Slack channel IDs for allowlist mode

  TELEGRAM_BOT_TOKEN     Telegram bot token from BotFather
  TELEGRAM_ALLOW_FROM    Comma-separated Telegram user IDs for DM allowlist
  TELEGRAM_GROUPS        Comma-separated Telegram group IDs
  TELEGRAM_GROUP_ALLOW_FROM
                         Comma-separated Telegram user IDs for groups

  DISCORD_BOT_TOKEN      Discord bot token
  DISCORD_ALLOW_FROM     Comma-separated Discord user IDs for DM allowlist
  DISCORD_GUILDS         Comma-separated Discord guild IDs
  DISCORD_CHANNELS       Comma-separated Discord channel IDs applied to each guild

  DUALVIEW_BOT_MODEL     Bot model when --model is unset
  DUALVIEW_BOT_INSPECT_MODEL
                         Model for inspect_symbol U-LLM fallback/logging
  DUALVIEW_TARGET_CHANNELS
                         Comma-separated DualView target channels/session ids.
                         Set this instead of using platform wildcards when a
                         Slack/Telegram/Discord bot should run in more channels
                         than DualView should inspect.
  DUALVIEW_TARGET_SESSION_IDS
                         Optional extra session key fragments for DualView.
  DUALVIEW_DISABLED_TARGET_CHANNELS
                         Comma-separated DualView target channels/session ids
                         to disable, e.g. slack:C0123456789.
  DUALVIEW_DISABLED_TARGET_SESSION_IDS
                         Optional session key fragments to disable.

Config file runner keys:
  dualviewBot.port       Gateway port used by scripts/run-bot.sh.
  dualviewBot.dashboard.port
                         Dashboard port and Slack symbol-link port.
  dualviewBot.dashboard.host
                         Public dashboard host for Slack symbol links.
                         If unset, scripts/run-bot.sh uses localhost for
                         non-CI local runs and the system hostname in CI.
  dualviewBot.dashboard.timezone
                         IANA timezone for dashboard timestamps,
                         e.g. Asia/Seoul. Defaults to system timezone.

Fallbacks:
  When token env vars are unset, this script imports default-account channel
  tokens from ~/.openclaw/openclaw.json into the current process environment.
  Imported tokens are passed to Docker but are not written to the generated
  config file.

Examples:
  SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
    ./scripts/setup-openclaw-bot.sh --channel slack --open-access

  TELEGRAM_BOT_TOKEN=123:abc ./scripts/setup-openclaw-bot.sh --channel telegram

  ./scripts/setup-openclaw-bot.sh --channels slack,telegram --no-run
HELP
  exit 0
}

OUTPUT="$DUALVIEW_ROOT/tmp-runs/bot/generated/openclaw-bot.json"
BOT_CONFIG=""
RUN_BOT=1
CHANNELS_ARG="${DUALVIEW_BOT_CHANNELS:-auto}"
OPEN_ACCESS=0
BOT_PORT=""
BOT_MODEL_ARG=""
DUALVIEW_TARGETS_ARG=""
DUALVIEW_DISABLED_TARGETS_ARG=""
OPENCLAW_DIR_ARG=""
ANTHROPIC_KEY_ARG=""
SEED_GWS_DEMO=0
REQUESTED_CHANNELS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) BOT_CONFIG="$2"; shift 2 ;;
    --channel) REQUESTED_CHANNELS+=("$2"); shift 2 ;;
    --channels) CHANNELS_ARG="$2"; shift 2 ;;
    --open-access) OPEN_ACCESS=1; shift ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --port) BOT_PORT="$2"; shift 2 ;;
    --seed-gws-demo) SEED_GWS_DEMO=1; shift ;;
    --model) BOT_MODEL_ARG="$2"; shift 2 ;;
    --dualview-targets) DUALVIEW_TARGETS_ARG="$2"; shift 2 ;;
    --dualview-disable-targets|--dualview-disabled-targets) DUALVIEW_DISABLED_TARGETS_ARG="$2"; shift 2 ;;
    --openclaw-dir) OPENCLAW_DIR_ARG="$2"; shift 2 ;;
    --anthropic-key) ANTHROPIC_KEY_ARG="$2"; shift 2 ;;
    --no-run) RUN_BOT=0; shift ;;
    --run) RUN_BOT=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1 (use --help)" >&2; exit 1 ;;
  esac
done

if [ -f "$DUALVIEW_ROOT/.env" ]; then
  set -a
  source "$DUALVIEW_ROOT/.env"
  set +a
fi

OPENCLAW_HOME_CONFIG="${OPENCLAW_HOME_CONFIG:-$HOME/.openclaw/openclaw.json}"
if [ -f "$OPENCLAW_HOME_CONFIG" ]; then
  mapfile -t _OPENCLAW_TOKEN_IMPORT < <(python3 - "$OPENCLAW_HOME_CONFIG" <<'PY'
import json
import sys

cfg_path = sys.argv[1]
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

channels = cfg.get("channels") if isinstance(cfg, dict) else {}
if not isinstance(channels, dict):
    channels = {}

def channel_value(channel: str, key: str) -> str:
    section = channels.get(channel)
    if not isinstance(section, dict):
        return ""
    account_id = section.get("defaultAccount") or "default"
    account = {}
    accounts = section.get("accounts")
    if isinstance(accounts, dict) and isinstance(accounts.get(account_id), dict):
        account = accounts[account_id]
    value = account.get(key) or section.get(key)
    return value.strip() if isinstance(value, str) else ""

values = [
    channel_value("slack", "botToken"),
    channel_value("slack", "appToken"),
    channel_value("slack", "signingSecret"),
    channel_value("slack", "mode"),
    channel_value("telegram", "botToken"),
    channel_value("discord", "token"),
]
for value in values:
    print(value)
PY
  )

  if [ -z "${SLACK_BOT_TOKEN:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[0]:-}" ]; then
    export SLACK_BOT_TOKEN="${_OPENCLAW_TOKEN_IMPORT[0]}"
  fi
  if [ -z "${SLACK_APP_TOKEN:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[1]:-}" ]; then
    export SLACK_APP_TOKEN="${_OPENCLAW_TOKEN_IMPORT[1]}"
  fi
  if [ -z "${SLACK_SIGNING_SECRET:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[2]:-}" ]; then
    export SLACK_SIGNING_SECRET="${_OPENCLAW_TOKEN_IMPORT[2]}"
  fi
  if [ -z "${SLACK_MODE:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[3]:-}" ]; then
    export SLACK_MODE="${_OPENCLAW_TOKEN_IMPORT[3]}"
  fi
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[4]:-}" ]; then
    export TELEGRAM_BOT_TOKEN="${_OPENCLAW_TOKEN_IMPORT[4]}"
  fi
  if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -n "${_OPENCLAW_TOKEN_IMPORT[5]:-}" ]; then
    export DISCORD_BOT_TOKEN="${_OPENCLAW_TOKEN_IMPORT[5]}"
  fi
  unset _OPENCLAW_TOKEN_IMPORT
fi

if [ ${#REQUESTED_CHANNELS[@]} -gt 0 ]; then
  CHANNELS_ARG="$(IFS=,; echo "${REQUESTED_CHANNELS[*]}")"
fi

# Preflight: fail fast on missing required .env values before the slow Docker
# build. Per-channel token checks for explicitly requested channels are done by
# the config generator below; here we only guard the LLM credential needed at
# run time. (Skipped for --no-run, which only writes the config file.)
# shellcheck source=scripts/lib/check-bot-env.sh
source "$DUALVIEW_ROOT/scripts/lib/check-bot-env.sh"
if [ "$RUN_BOT" -eq 1 ]; then
  require_llm_credential || exit 1
  case ",${CHANNELS_ARG,,}," in
    *,slack,*) require_slack_env || exit 1 ;;
  esac
fi

BOT_MODEL_ARG="${BOT_MODEL_ARG:-${DUALVIEW_BOT_MODEL:-openai-codex/gpt-5.3-codex-spark}}"
DUALVIEW_TARGETS_ARG="${DUALVIEW_TARGETS_ARG:-${DUALVIEW_TARGET_CHANNELS:-}}"
DUALVIEW_DISABLED_TARGETS_ARG="${DUALVIEW_DISABLED_TARGETS_ARG:-${DUALVIEW_DISABLED_TARGET_CHANNELS:-}}"

if [ -n "$BOT_CONFIG" ]; then
  if [ ! -f "$BOT_CONFIG" ]; then
    echo "ERROR: Config file not found: $BOT_CONFIG" >&2
    exit 1
  fi
  echo "Config: $BOT_CONFIG"
  if [ "$RUN_BOT" -eq 0 ]; then
    exit 0
  fi
  if [ -z "$BOT_PORT" ]; then
    BOT_PORT="$(python3 - "$BOT_CONFIG" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

value = cfg.get("dualviewBot", {}).get("port") if isinstance(cfg, dict) else None
if isinstance(value, int):
    print(value)
elif isinstance(value, str) and value.strip():
    print(value.strip())
PY
)"
  fi
  RUN_ARGS=(--config "$BOT_CONFIG")
  [ -n "$BOT_PORT" ] && RUN_ARGS+=(--port "$BOT_PORT")
  [ -n "$OPENCLAW_DIR_ARG" ] && RUN_ARGS+=(--openclaw-dir "$OPENCLAW_DIR_ARG")
  [ -n "$ANTHROPIC_KEY_ARG" ] && RUN_ARGS+=(--anthropic-key "$ANTHROPIC_KEY_ARG")
  [ "$SEED_GWS_DEMO" -eq 1 ] && RUN_ARGS+=(--seed-gws-demo)
  exec "$DUALVIEW_ROOT/scripts/run-bot.sh" "${RUN_ARGS[@]}"
fi

export DUALVIEW_SETUP_CHANNELS="$CHANNELS_ARG"
export DUALVIEW_SETUP_OPEN_ACCESS="$OPEN_ACCESS"
export DUALVIEW_SETUP_MODEL="$BOT_MODEL_ARG"
export DUALVIEW_SETUP_TARGET_CHANNELS="$DUALVIEW_TARGETS_ARG"
export DUALVIEW_SETUP_DISABLED_TARGET_CHANNELS="$DUALVIEW_DISABLED_TARGETS_ARG"

python3 - "$DUALVIEW_ROOT" "$OUTPUT" <<'PY'
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
output = Path(sys.argv[2])
template_path = root / "config" / "openclaw-bot.json"

SUPPORTED = ("slack", "telegram", "discord", "webchat")

def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()

def truthy(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}

def csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]

def has_slack() -> bool:
    mode = env("SLACK_MODE", "socket").lower()
    if mode == "http":
        return bool(env("SLACK_BOT_TOKEN") and env("SLACK_SIGNING_SECRET"))
    return bool(env("SLACK_BOT_TOKEN") and env("SLACK_APP_TOKEN"))

def has_telegram() -> bool:
    return bool(env("TELEGRAM_BOT_TOKEN"))

def has_discord() -> bool:
    return bool(env("DISCORD_BOT_TOKEN"))

def required_for(channel: str) -> str:
    if channel == "slack":
        mode = env("SLACK_MODE", "socket").lower()
        return "SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET" if mode == "http" else "SLACK_BOT_TOKEN + SLACK_APP_TOKEN"
    if channel == "telegram":
        return "TELEGRAM_BOT_TOKEN"
    if channel == "discord":
        return "DISCORD_BOT_TOKEN"
    return ""

requested_raw = env("DUALVIEW_SETUP_CHANNELS", "auto")
explicit = requested_raw.lower() not in {"", "auto"}
if explicit:
    requested = [part.lower() for part in csv(requested_raw)]
else:
    requested = []
    if has_slack():
        requested.append("slack")
    if has_telegram():
        requested.append("telegram")
    if has_discord():
        requested.append("discord")
    requested.append("webchat")

unknown = [name for name in requested if name not in SUPPORTED]
if unknown:
    raise SystemExit(f"Unsupported channel(s): {', '.join(unknown)}")

open_access = truthy(env("DUALVIEW_SETUP_OPEN_ACCESS"))
dm_policy = "open" if open_access else env("DUALVIEW_DM_POLICY", "pairing")
group_policy = "open" if open_access else env("DUALVIEW_GROUP_POLICY", "allowlist")
require_mention = not open_access

with template_path.open("r", encoding="utf-8") as f:
    cfg = json.load(f)

bot_model = env("DUALVIEW_SETUP_MODEL", "openai-codex/gpt-5.3-codex-spark")
inspect_model = env("DUALVIEW_BOT_INSPECT_MODEL") or bot_model
agent_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
agent_defaults["model"] = {"primary": bot_model}
dualview_cfg = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("dualview", {}).setdefault("config", {})
dualview_cfg["inspectModel"] = inspect_model
cfg.setdefault("tools", {}).setdefault("web", {}).setdefault("search", {}).pop("apiKey", None)
cfg["channels"] = {}

gateway_token = env("DUALVIEW_GATEWAY_TOKEN", "dualview-bot")
cfg["gateway"] = {
    "mode": "local",
    "auth": {"mode": "token", "token": gateway_token},
    "controlUi": {
        "dangerouslyAllowHostHeaderOriginFallback": True,
        "dangerouslyDisableDeviceAuth": True,
    },
}

enabled: list[str] = []
skipped: list[str] = []
errors: list[str] = []

if "slack" in requested:
    if has_slack():
        allow_from = ["*"] if dm_policy == "open" else csv(env("SLACK_ALLOW_FROM"))
        slack_channels = csv(env("SLACK_CHANNELS"))
        mode = env("SLACK_MODE", "socket").lower()
        slack_cfg = {
            "enabled": True,
            "mode": mode,
            "webhookPath": env("SLACK_WEBHOOK_PATH", "/slack/events"),
            "requireMention": require_mention,
            "groupPolicy": env("SLACK_GROUP_POLICY", group_policy),
            "streaming": "off",
            "nativeStreaming": True,
            "replyToMode": "off",
            "dmPolicy": env("SLACK_DM_POLICY", dm_policy),
            "dm": {"enabled": True},
        }
        if allow_from:
            slack_cfg["allowFrom"] = allow_from
        if slack_channels:
            slack_cfg["channels"] = {channel: {"requireMention": require_mention} for channel in slack_channels}
        cfg["channels"]["slack"] = slack_cfg
        enabled.append("slack")
    elif explicit:
        errors.append(f"slack requested but missing {required_for('slack')}")
    else:
        skipped.append("slack")

if "telegram" in requested:
    if has_telegram():
        allow_from = ["*"] if dm_policy == "open" else csv(env("TELEGRAM_ALLOW_FROM"))
        group_allow_from = ["*"] if open_access else csv(env("TELEGRAM_GROUP_ALLOW_FROM"))
        groups = csv(env("TELEGRAM_GROUPS"))
        telegram_cfg = {
            "enabled": True,
            "dmPolicy": env("TELEGRAM_DM_POLICY", dm_policy),
            "groupPolicy": env("TELEGRAM_GROUP_POLICY", group_policy),
            "streaming": "off",
        }
        if allow_from:
            telegram_cfg["allowFrom"] = allow_from
        if group_allow_from:
            telegram_cfg["groupAllowFrom"] = group_allow_from
        if groups:
            telegram_cfg["groups"] = {group: {"groupPolicy": env("TELEGRAM_GROUP_POLICY", group_policy)} for group in groups}
        cfg["channels"]["telegram"] = telegram_cfg
        enabled.append("telegram")
    elif explicit:
        errors.append(f"telegram requested but missing {required_for('telegram')}")
    else:
        skipped.append("telegram")

if "discord" in requested:
    if has_discord():
        allow_from = ["*"] if dm_policy == "open" else csv(env("DISCORD_ALLOW_FROM"))
        guilds = csv(env("DISCORD_GUILDS"))
        discord_channels = csv(env("DISCORD_CHANNELS"))
        discord_cfg = {
            "enabled": True,
            "dmPolicy": env("DISCORD_DM_POLICY", dm_policy),
            "groupPolicy": env("DISCORD_GROUP_POLICY", group_policy),
        }
        if allow_from:
            discord_cfg["allowFrom"] = allow_from
        if guilds:
            guild_cfg = {}
            for guild in guilds:
                entry = {"requireMention": require_mention}
                if discord_channels:
                    entry["channels"] = {channel: {"allow": True, "requireMention": require_mention} for channel in discord_channels}
                guild_cfg[guild] = entry
            discord_cfg["guilds"] = guild_cfg
        cfg["channels"]["discord"] = discord_cfg
        enabled.append("discord")
    elif explicit:
        errors.append(f"discord requested but missing {required_for('discord')}")
    else:
        skipped.append("discord")

if "webchat" in requested:
    enabled.append("webchat")

if errors:
    for msg in errors:
        print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)

target_override = csv(env("DUALVIEW_SETUP_TARGET_CHANNELS"))
if target_override:
    target_channels = target_override
else:
    target_channels = [f"{channel}:*" for channel in enabled if channel != "webchat"]
    if "webchat" in enabled:
        target_channels.append("webchat:*")
dualview_cfg["targetChannels"] = target_channels

disabled_target_channels = csv(env("DUALVIEW_SETUP_DISABLED_TARGET_CHANNELS"))
if disabled_target_channels:
    dualview_cfg["disabledTargetChannels"] = disabled_target_channels

target_session_override = env("DUALVIEW_TARGET_SESSION_IDS")
if target_session_override:
    dualview_cfg["targetSessionIds"] = csv(target_session_override)
elif target_override or any(channel != "webchat" for channel in enabled):
    dualview_cfg["targetSessionIds"] = []
else:
    dualview_cfg["targetSessionIds"] = ["agent:main"]

disabled_session_override = env("DUALVIEW_DISABLED_TARGET_SESSION_IDS")
if disabled_session_override:
    dualview_cfg["disabledTargetSessionIds"] = csv(disabled_session_override)

output.parent.mkdir(parents=True, exist_ok=True)
with output.open("w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print(f"Config: {output}")
print(f"Model: {bot_model}")
print(f"Inspect model: {inspect_model}")
print("Enabled channels: " + (", ".join(enabled) if enabled else "none"))
print("DualView targets: " + (", ".join(target_channels) if target_channels else "none"))
if disabled_target_channels:
    print("DualView disabled targets: " + ", ".join(disabled_target_channels))
if disabled_session_override:
    print("DualView disabled sessions: " + ", ".join(csv(disabled_session_override)))
if skipped:
    print("Skipped channels without env tokens: " + ", ".join(skipped))
if open_access:
    print("Access: open access mode")
else:
    print("Access: pairing/allowlist defaults")
PY

if [ "$RUN_BOT" -eq 0 ]; then
  exit 0
fi

RUN_ARGS=(--config "$OUTPUT")
[ -n "$BOT_PORT" ] && RUN_ARGS+=(--port "$BOT_PORT")
[ -n "$OPENCLAW_DIR_ARG" ] && RUN_ARGS+=(--openclaw-dir "$OPENCLAW_DIR_ARG")
[ -n "$ANTHROPIC_KEY_ARG" ] && RUN_ARGS+=(--anthropic-key "$ANTHROPIC_KEY_ARG")
[ "$SEED_GWS_DEMO" -eq 1 ] && RUN_ARGS+=(--seed-gws-demo)

exec "$DUALVIEW_ROOT/scripts/run-bot.sh" "${RUN_ARGS[@]}"
