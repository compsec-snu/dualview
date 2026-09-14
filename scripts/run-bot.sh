#!/usr/bin/env bash
# Run DUALVIEW bot gateway in Docker.
#
# Builds Docker images and starts the bot container. All state persists across
# restarts under a single persistent directory. Only the config file and auth
# profiles are refreshed from source on each run.
set -euo pipefail

DUALVIEW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'HELP'
Usage: ./scripts/run-bot.sh [options]

Options:
  --openclaw-dir <path>  Path to openclaw source repo (default: $OPENCLAW_DIR or ./openclaw)
  --anthropic-key <key>  Anthropic API/OAuth key (default: $ANTHROPIC_API_KEY env var)
  --config <path>        Custom openclaw.json to inject (default: generated bot config if present,
                         otherwise config/openclaw-bot.json)
  --port <port>          Gateway port (default: 18800)
  --seed-gws-demo        Seed local fws Gmail/Calendar/Drive demo data on start
  --skill <slug>         Install a ClawHub skill into the persistent workspace
                         (repeatable; bare slug, e.g. --skill gog --skill reddit-readonly)
  --keep-skills          Keep previously installed ClawHub workspace skills
  -h, --help             Show this help

Auth (tried in order):
  1. Codex OAuth env vars or ~/.codex/auth.json
  2. Provider API keys such as OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
  3. Existing OpenClaw auth profiles from ~/.openclaw

Directory layout:
  tmp-runs/node/           Bind-mounted as /home/node
    .openclaw/             OpenClaw state dir
      openclaw.json        Config (refreshed each run)
      credentials/         Pairing approvals, allowFrom (persistent)
      agents/              Sessions, audit logs (persistent)
      telegram/            Telegram update offsets (persistent)
    workspace/             Agent git workspace (persistent)
    workspace-ullm/        Read-only agent workspace (persistent)
    .dualview/             Agent File System worktrees and symbol DB (persistent)
  tmp-runs/bot/log-sessions/{batchId}/
    meta.json              Batch metadata (status, git info)
    00 -> symlink          Points to tmp-runs/node/.openclaw/
    00.log                 Container stdout

Environment variables:
  BOT_LOG_BASE        Batch log base dir (default: $DUALVIEW_ROOT/tmp-runs/bot/log-sessions)
  BOT_NODE_HOME       Host dir bind-mounted as /home/node (default: $DUALVIEW_ROOT/tmp-runs/node)
  OPENCLAW_DIR        Path to openclaw source repo
  ANTHROPIC_API_KEY   API key (optional if auth profiles exist)
  SLACK_BOT_TOKEN / SLACK_APP_TOKEN
  TELEGRAM_BOT_TOKEN
  DISCORD_BOT_TOKEN
  DUALVIEW_DASHBOARD_URL  Full bot dashboard base URL for Slack symbol links
                          (local non-CI default: http://localhost:<port>/bot/)
  DUALVIEW_DASHBOARD_HOST Host for symbol links when only a port is set.
                          Explicit host/URL settings are preserved; CI keeps
                          the machine FQDN default. Yields http://<host>:<port>/bot/
  DUALVIEW_DASHBOARD_PORT Dashboard port used to build symbol links when no URL
  DUALVIEW_BOT_BATCH_ID   Override bot batch id for Slack dashboard links
  DUALVIEW_BOT_FWS_SEED   Seed fws Gmail/Calendar/Drive demo data when 1
  DUALVIEW_BOT_DASHBOARD  Start bot dashboard with the bot (default: 1; set 0 to disable)
  DASHBOARD_PORT          Dashboard port (default: DUALVIEW_DASHBOARD_PORT or 13457)
  DASHBOARD_TIMEZONE      Dashboard timestamp timezone (default: system TZ)

Dashboard:
  npm run dashboard

Examples:
  ./scripts/setup-openclaw-bot.sh --channel slack --open-access
  ./scripts/run-bot.sh --config config/openclaw-bot-dualview.json
  ./scripts/run-bot.sh --port 19000
HELP
  exit 0
}

OPENCLAW_DIR="${OPENCLAW_DIR:-$DUALVIEW_ROOT/openclaw}"
BOT_PORT="18800"
BOT_CONFIG=""
# ClawHub skills are opt-in for bot runs. Slugs are flat (globally unique), NOT
# the "<owner>/<slug>" form from clawhub.ai URLs. Verify with:
#   npx clawhub inspect <slug>
BOT_SKILLS=()
BOT_PRUNE_SKILLS="${BOT_PRUNE_SKILLS:-1}"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-dir) OPENCLAW_DIR="$2"; shift 2 ;;
    --anthropic-key) ANTHROPIC_API_KEY="$2"; export ANTHROPIC_API_KEY; shift 2 ;;
    --config) BOT_CONFIG="$2"; shift 2 ;;
    --port) BOT_PORT="$2"; shift 2 ;;
    --seed-gws-demo) DUALVIEW_BOT_FWS_SEED=1; export DUALVIEW_BOT_FWS_SEED; shift ;;
    --skill) BOT_SKILLS+=("$2"); shift 2 ;;
    --keep-skills) BOT_PRUNE_SKILLS=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1 (use --help)"; exit 1 ;;
  esac
done

# Load .env if present
if [ -f "$DUALVIEW_ROOT/.env" ]; then
  set -a; source "$DUALVIEW_ROOT/.env"; set +a
fi
OPENCLAW_DIR="${OPENCLAW_DIR:-$DUALVIEW_ROOT/openclaw}"

DEFAULT_GENERATED_CONFIG="$DUALVIEW_ROOT/tmp-runs/bot/generated/openclaw-bot.json"
if [ -n "$BOT_CONFIG" ]; then
  BOT_CONFIG_SRC="$BOT_CONFIG"
elif [ -f "$DEFAULT_GENERATED_CONFIG" ]; then
  BOT_CONFIG_SRC="$DEFAULT_GENERATED_CONFIG"
else
  BOT_CONFIG_SRC="$DUALVIEW_ROOT/config/openclaw-bot.json"
fi
if [ ! -f "$BOT_CONFIG_SRC" ]; then
  echo "ERROR: Config file not found: $BOT_CONFIG_SRC"
  exit 1
fi

is_ci_environment() {
  [ -n "${CI:-}" ] || \
  [ -n "${GITLAB_CI:-}" ] || \
  [ -n "${GITHUB_ACTIONS:-}" ] || \
  [ -n "${BUILDKITE:-}" ] || \
  [ -n "${JENKINS_URL:-}" ]
}

set_default_dashboard_link_target() {
  if [ -n "${DUALVIEW_DASHBOARD_URL:-}" ] || \
     [ -n "${DUALVIEW_BOT_DASHBOARD_URL:-}" ] || \
     [ -n "${DUALVIEW_DASHBOARD_HOST:-}" ]; then
    return
  fi
  local _port="${DUALVIEW_DASHBOARD_PORT:-${DASHBOARD_PORT:-}}"
  if [ -z "$_port" ]; then
    return
  fi
  if is_ci_environment; then
    export DUALVIEW_DASHBOARD_HOST="$(hostname -f 2>/dev/null || hostname)"
  else
    export DUALVIEW_DASHBOARD_URL="http://localhost:${_port}/bot/"
  fi
}

mapfile -t _BOT_RUNNER_CONFIG < <(python3 - "$BOT_CONFIG_SRC" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

dualview_bot = cfg.get("dualviewBot") if isinstance(cfg, dict) else {}
if not isinstance(dualview_bot, dict):
    dualview_bot = {}
dashboard = dualview_bot.get("dashboard")
if not isinstance(dashboard, dict):
    dashboard = {}

def config_value(*values: object) -> str:
    for value in values:
        if isinstance(value, int):
            return str(value)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

print(config_value(dashboard.get("port"), dualview_bot.get("dashboardPort")))
print(config_value(dashboard.get("timezone"), dualview_bot.get("dashboardTimezone")))
print(config_value(dashboard.get("host"), dualview_bot.get("dashboardHost")))
PY
)
if [ -z "${DASHBOARD_PORT:-}" ] && \
   [ -z "${DUALVIEW_DASHBOARD_PORT:-}" ] && \
   [ -n "${_BOT_RUNNER_CONFIG[0]:-}" ]; then
  export DASHBOARD_PORT="${_BOT_RUNNER_CONFIG[0]}"
fi
if [ -z "${DUALVIEW_DASHBOARD_PORT:-}" ] && [ -n "${_BOT_RUNNER_CONFIG[0]:-}" ]; then
  export DUALVIEW_DASHBOARD_PORT="${_BOT_RUNNER_CONFIG[0]}"
fi
if [ -z "${DASHBOARD_TIMEZONE:-}" ] && [ -n "${_BOT_RUNNER_CONFIG[1]:-}" ]; then
  export DASHBOARD_TIMEZONE="${_BOT_RUNNER_CONFIG[1]}"
fi
if [ -z "${DUALVIEW_DASHBOARD_HOST:-}" ] && [ -n "${_BOT_RUNNER_CONFIG[2]:-}" ]; then
  export DUALVIEW_DASHBOARD_HOST="${_BOT_RUNNER_CONFIG[2]}"
fi
unset _BOT_RUNNER_CONFIG

# Slack symbol links resolve to a dashboard URL inside the container. The bot
# builds them from DUALVIEW_DASHBOARD_HOST + DUALVIEW_DASHBOARD_PORT (or a full
# DUALVIEW_DASHBOARD_URL). Local non-CI runs default to localhost because the
# dashboard is normally opened from the same machine; CI keeps the FQDN default.
set_default_dashboard_link_target

if [ "${DUALVIEW_BOT_DASHBOARD:-1}" != "0" ]; then
  DASHBOARD_PORT="${DASHBOARD_PORT:-${DUALVIEW_DASHBOARD_PORT:-13457}}"
  export DASHBOARD_PORT
  if [ -z "${DUALVIEW_DASHBOARD_URL:-}" ] && [ -z "${DUALVIEW_BOT_DASHBOARD_URL:-}" ]; then
    export DUALVIEW_DASHBOARD_PORT="${DUALVIEW_DASHBOARD_PORT:-$DASHBOARD_PORT}"
    set_default_dashboard_link_target
  fi
fi

# Keys to forward into the Docker container. LLM/tool keys mirror
# scripts/lib/env.ts; channel keys are needed by generated bot configs.
FORWARD_KEYS=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  GEMINI_API_KEY
  OPENROUTER_API_KEY
  OPENROUTER_MODEL
  FOUNDRY_ENDPOINT
  FOUNDRY_KEY
  FOUNDRY_MODEL
  BRAVE_API_KEY
  OPENAI_CODEX_ACCESS
  OPENAI_CODEX_REFRESH
  OPENAI_CODEX_ACCOUNT_ID
  OPENAI_CODEX_EMAIL
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SLACK_SIGNING_SECRET
  TELEGRAM_BOT_TOKEN
  DISCORD_BOT_TOKEN
  DUALVIEW_DASHBOARD_URL
  DUALVIEW_BOT_DASHBOARD_URL
  DUALVIEW_DASHBOARD_HOST
  DUALVIEW_DASHBOARD_PORT
  DUALVIEW_BOT_BATCH_ID
  DUALVIEW_BOT_FWS_SEED
  FWS_PORT
)

OPENCLAW_DIR="$(cd "$OPENCLAW_DIR" && pwd)"
BOT_LOG_BASE="${BOT_LOG_BASE:-$DUALVIEW_ROOT/tmp-runs/bot/log-sessions}"
BOT_NODE_HOME="${BOT_NODE_HOME:-$DUALVIEW_ROOT/tmp-runs/node}"
LEGACY_BOT_PERSISTENT_DIR="${BOT_PERSISTENT_DIR:-$DUALVIEW_ROOT/tmp-runs/bot/persistent}"
BOT_CONTAINER="dualview-bot"
BOT_IMAGE="dualview-bot:local"

# -- Kill previous instance ----------------------------------------------------

docker rm -f "$BOT_CONTAINER" 2>/dev/null || true

EXISTING_PID=$(lsof -ti "tcp:$BOT_PORT" 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  echo "Killing existing process on port $BOT_PORT (PID $EXISTING_PID)..."
  kill $EXISTING_PID 2>/dev/null || true
  sleep 1
fi

# -- Initialize persistent directories ----------------------------------------

BOT_STATE_DIR="$BOT_NODE_HOME/.openclaw"
BOT_PERSISTENT_WS="$BOT_NODE_HOME/workspace"
BOT_PERSISTENT_WS_ULLM="$BOT_NODE_HOME/workspace-ullm"
BOT_PERSISTENT_DUALVIEW="$BOT_NODE_HOME/.dualview"

# One-time migration from the older tmp-runs/bot/persistent layout.
if [ -d "$LEGACY_BOT_PERSISTENT_DIR" ]; then
  mkdir -p "$BOT_NODE_HOME"
  [ ! -e "$BOT_STATE_DIR" ] && [ -d "$LEGACY_BOT_PERSISTENT_DIR/state" ] && cp -a "$LEGACY_BOT_PERSISTENT_DIR/state" "$BOT_STATE_DIR"
  [ ! -e "$BOT_PERSISTENT_WS" ] && [ -d "$LEGACY_BOT_PERSISTENT_DIR/workspace" ] && cp -a "$LEGACY_BOT_PERSISTENT_DIR/workspace" "$BOT_PERSISTENT_WS"
  [ ! -e "$BOT_PERSISTENT_WS_ULLM" ] && [ -d "$LEGACY_BOT_PERSISTENT_DIR/workspace-ullm" ] && cp -a "$LEGACY_BOT_PERSISTENT_DIR/workspace-ullm" "$BOT_PERSISTENT_WS_ULLM"
  [ ! -e "$BOT_PERSISTENT_DUALVIEW" ] && [ -d "$LEGACY_BOT_PERSISTENT_DIR/dualview" ] && cp -a "$LEGACY_BOT_PERSISTENT_DIR/dualview" "$BOT_PERSISTENT_DUALVIEW"
fi

mkdir -p "$BOT_STATE_DIR" "$BOT_PERSISTENT_WS" "$BOT_PERSISTENT_WS_ULLM" "$BOT_PERSISTENT_DUALVIEW"

# Initialize workspace git repo (required for DUALVIEW file tracking).
if [ ! -d "$BOT_PERSISTENT_WS/.git" ]; then
  git init "$BOT_PERSISTENT_WS"
fi
git -C "$BOT_PERSISTENT_WS" config user.name "dualview-bot"
git -C "$BOT_PERSISTENT_WS" config user.email "dualview-bot@localhost"
if ! git -C "$BOT_PERSISTENT_WS" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$BOT_PERSISTENT_WS" commit --allow-empty -m "init: empty workspace"
fi

# Symlink persistent workspace into state dir for dashboard host-side reads.
ln -sfn ../workspace "$BOT_STATE_DIR/workspace"
ln -sfn ../workspace-ullm "$BOT_STATE_DIR/workspace-ullm"
ln -sfn ../.dualview "$BOT_STATE_DIR/dualview"

# -- Install ClawHub skills ----------------------------------------------------
# Runs on the host; writes into the persistent workspace that bind-mounts to
# /home/node/workspace inside the container. OpenClaw auto-discovers skills
# from <workspace>/skills at session start, so the next agent run picks them up.
# Slugs are flat identifiers (e.g. "gog"), NOT the "<owner>/<slug>" path from
# clawhub.ai URLs. Use `npx clawhub inspect <slug>` to verify.
if [ "$BOT_PRUNE_SKILLS" != "0" ] && [ -d "$BOT_PERSISTENT_WS/skills" ]; then
  echo "=== Pruning unrequested ClawHub skills from $BOT_PERSISTENT_WS/skills ==="
  for _skill_dir in "$BOT_PERSISTENT_WS"/skills/*; do
    [ -d "$_skill_dir" ] || continue
    [ -f "$_skill_dir/.clawhub/origin.json" ] || continue
    _skill_name="$(basename "$_skill_dir")"
    _keep=0
    for _slug in "${BOT_SKILLS[@]}"; do
      if [ "$_skill_name" = "$_slug" ]; then
        _keep=1
        break
      fi
    done
    if [ "$_keep" -eq 0 ]; then
      echo "  -> removing stale ClawHub skill: $_skill_name"
      rm -rf -- "$_skill_dir"
    fi
  done
fi

if [ ${#BOT_SKILLS[@]} -gt 0 ]; then
  if ! command -v npx >/dev/null 2>&1; then
    echo "ERROR: --skill requires 'npx' on the host (install Node.js)."
    exit 1
  fi
  echo "=== Installing ClawHub skills into $BOT_PERSISTENT_WS/skills ==="
  for _slug in "${BOT_SKILLS[@]}"; do
    echo "  -> $_slug"
    if ! npx --yes clawhub install "$_slug" --workdir "$BOT_PERSISTENT_WS"; then
      echo "WARN: clawhub install $_slug failed (continuing)"
    fi
  done
fi

# -- Batch log directory (logs + metadata only) --------------------------------

BATCH_ID=$(date +%Y%m%d_%H%M%S)
BATCH_DIR="$BOT_LOG_BASE/$BATCH_ID"
mkdir -p "$BATCH_DIR"

# Symlink 00 -> persistent state dir so dashboard can still find it.
ln -sfn "$BOT_STATE_DIR" "$BATCH_DIR/00"

_GIT_BRANCH="${CI_COMMIT_BRANCH:-$(cd "$DUALVIEW_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"
_GIT_COMMIT="${CI_COMMIT_SHORT_SHA:-$(cd "$DUALVIEW_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "")}"

cat > "$BATCH_DIR/meta.json" <<'_META_TEMPLATE'
{
  "kind": "bot",
  "status": "RUNNING",
  "date": "__DATE__",
  "gitBranch": "__BRANCH__",
  "gitCommit": "__COMMIT__",
  "ciActor": "__ACTOR__",
  "ciJobUrl": "__JOB_URL__",
  "gatewayPort": "__GW_PORT__"
}
_META_TEMPLATE
sed -i \
  -e "s|__DATE__|$(date -u +%Y-%m-%dT%H:%M:%SZ)|" \
  -e "s|__BRANCH__|${_GIT_BRANCH}|" \
  -e "s|__COMMIT__|${_GIT_COMMIT}|" \
  -e "s|__ACTOR__|${GITLAB_USER_LOGIN:-}|" \
  -e "s|__JOB_URL__|${CI_JOB_URL:-}|" \
  -e "s|__GW_PORT__|${BOT_PORT}|" \
  "$BATCH_DIR/meta.json"

for _prev in "$BOT_LOG_BASE"/*/meta.json; do
  [ -f "$_prev" ] || continue
  [ "$_prev" = "$BATCH_DIR/meta.json" ] && continue
  sed -i 's/"status": "RUNNING"/"status": "STOPPED"/' "$_prev"
done

echo "Batch:      $BATCH_ID"
echo "OpenClaw:   $OPENCLAW_DIR"
echo "State dir:  $BOT_STATE_DIR (persistent)"
echo "Node home:  $BOT_NODE_HOME -> /home/node"

# -- Auth profiles -------------------------------------------------------------

# Build auth-profiles.json via the shared TS helper (scripts/lib/env.ts).
# This covers both api_key providers (anthropic/openai/gemini) and the
# openai-codex OAuth profile (env vars or ~/.codex/auth.json).
AUTH_SRC="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
_AUTH_TMP=$(mktemp)
if (cd "$DUALVIEW_ROOT" && npx --no-install tsx scripts/lib/build-auth-profiles-cli.ts) > "$_AUTH_TMP" 2>/dev/null \
    && [ -s "$_AUTH_TMP" ]; then
  for _agent in main ullm; do
    _dst="$BOT_STATE_DIR/agents/$_agent/agent/auth-profiles.json"
    mkdir -p "$(dirname "$_dst")"
    cp "$_AUTH_TMP" "$_dst"
  done
  rm -f "$_AUTH_TMP"
  echo "Auth:      built via build-auth-profiles-cli (main + ullm)"
elif [ -f "$AUTH_SRC" ]; then
  rm -f "$_AUTH_TMP"
  for _agent in main ullm; do
    _dst="$BOT_STATE_DIR/agents/$_agent/agent/auth-profiles.json"
    mkdir -p "$(dirname "$_dst")"
    cp "$AUTH_SRC" "$_dst"
  done
  echo "Auth:       copied from ~/.openclaw (main + ullm)"
elif [ -f "$BOT_STATE_DIR/agents/main/agent/auth-profiles.json" ]; then
  rm -f "$_AUTH_TMP"
  echo "Auth:       reusing existing (main + ullm)"
elif [ -n "${FOUNDRY_ENDPOINT:-}" ] && [ -n "${FOUNDRY_KEY:-}" ]; then
  rm -f "$_AUTH_TMP"
  echo "Auth:       Microsoft Foundry key from environment"
else
  rm -f "$_AUTH_TMP"
  echo "ERROR: No LLM credentials found."
  echo "  Provide one of: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY,"
  echo "  FOUNDRY_ENDPOINT + FOUNDRY_KEY,"
  echo "  or OPENAI_CODEX_ACCESS + OPENAI_CODEX_REFRESH (+ OPENAI_CODEX_ACCOUNT_ID),"
  echo "  or ~/.codex/auth.json, or --anthropic-key flag."
  exit 1
fi

# -- Write openclaw.json (always refresh from source config) -------------------

python3 - "$BOT_CONFIG_SRC" "$BOT_STATE_DIR/openclaw.json" <<'PY'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, "r", encoding="utf-8") as f:
    cfg = json.load(f)
if isinstance(cfg, dict):
    cfg.pop("dualviewBot", None)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
echo "Config:     $BOT_CONFIG_SRC"

# -- Build and run -------------------------------------------------------------

echo "=== Building base image (openclaw:local) ==="
BASE_SHA=$(python3 - "$OPENCLAW_DIR" <<'PY'
import hashlib
import os
import subprocess
import sys

openclaw_dir = os.path.realpath(sys.argv[1])

try:
    top = subprocess.check_output(
        ["git", "-C", openclaw_dir, "rev-parse", "--show-toplevel"],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    rel = os.path.relpath(openclaw_dir, top)
    status = subprocess.check_output(
        ["git", "-C", top, "status", "--porcelain", "--untracked-files=all", "--", rel],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    if not status:
        tree = subprocess.check_output(
            ["git", "-C", top, "rev-parse", f"HEAD:{rel}"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        print(tree)
        raise SystemExit(0)
except Exception:
    pass

digest = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(openclaw_dir):
    dirnames[:] = sorted(
        name for name in dirnames
        if name not in {".git", "node_modules", "dist", "coverage", ".turbo"}
    )
    for filename in sorted(filenames):
        path = os.path.join(dirpath, filename)
        rel = os.path.relpath(path, openclaw_dir)
        digest.update(rel.encode())
        digest.update(b"\0")
        if os.path.islink(path):
            digest.update(b"symlink\0")
            digest.update(os.readlink(path).encode())
        else:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    digest.update(chunk)
        digest.update(b"\0")
print(digest.hexdigest())
PY
)
LAST_SHA=""
SHA_FILE="$DUALVIEW_ROOT/.openclaw-last-docker-sha"
[ -f "$SHA_FILE" ] && LAST_SHA=$(cat "$SHA_FILE")

if [ "$BASE_SHA" != "$LAST_SHA" ] || ! docker image inspect openclaw:local >/dev/null 2>&1; then
  docker build -t openclaw:local "$OPENCLAW_DIR"
  echo "$BASE_SHA" > "$SHA_FILE"
else
  echo "openclaw:local up to date, skipping."
fi

echo "=== Building bot image ($BOT_IMAGE) ==="
BOT_IMAGE_SHA_FILE="$DUALVIEW_ROOT/.dualview-bot-image-sha"
FWS_SOURCE_DIR="${FWS_SOURCE_DIR:-$DUALVIEW_ROOT/../fws}"
FWS_DISCOVERY_CACHE_DIR="${FWS_DISCOVERY_CACHE_DIR:-$HOME/.cache/fws-discovery/cache}"
export FWS_DISCOVERY_CACHE_DIR

ensure_gws_discovery_cache() {
  local _cache_dir="$1"
  mkdir -p "$_cache_dir"
  local _missing=0
  for _file in gmail_v1.json calendar_v3.json drive_v3.json tasks_v1.json sheets_v4.json people_v1.json; do
    [ -f "$_cache_dir/$_file" ] || _missing=1
  done
  if [ "$_missing" -eq 0 ]; then
    return
  fi
  while read -r _file _url; do
    [ -n "$_file" ] || continue
    if [ ! -f "$_cache_dir/$_file" ]; then
      curl -sfL -o "$_cache_dir/$_file" "$_url"
    fi
  done <<'GWS_DISCOVERY_APIS'
gmail_v1.json https://gmail.googleapis.com/$discovery/rest?version=v1
calendar_v3.json https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest
drive_v3.json https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
tasks_v1.json https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest
sheets_v4.json https://sheets.googleapis.com/$discovery/rest?version=v4
people_v1.json https://people.googleapis.com/$discovery/rest?version=v1
GWS_DISCOVERY_APIS
}

copy_fws_source() {
  local _dst="$1"
  if [ -d "$FWS_SOURCE_DIR" ]; then
    mkdir -p "$_dst"
    (cd "$FWS_SOURCE_DIR" && tar --exclude=.git --exclude=node_modules -cf - .) | (cd "$_dst" && tar -xf -)
    return
  fi
  echo "fws source not found at $FWS_SOURCE_DIR; cloning juppytt/fws for the bot image..."
  git clone --depth 1 https://github.com/juppytt/fws.git "$_dst"
  rm -rf "$_dst/.git"
}

ensure_gws_discovery_cache "$FWS_DISCOVERY_CACHE_DIR"
BOT_IMAGE_SHA=$(python3 - "$DUALVIEW_ROOT" "$BASE_SHA" <<'PY'
import hashlib
import os
import sys

root, base_sha = sys.argv[1], sys.argv[2]
inputs = [
    "docker/Dockerfile.bot",
    "plugin/dualview",
    "plugin/llama-prompt-guard",
    "plugin/llama-secalign",
    "scripts/lib/seed-gws-demo.sh",
    "../fws",
]
if os.environ.get("FWS_DISCOVERY_CACHE_DIR"):
    inputs.append(os.environ["FWS_DISCOVERY_CACHE_DIR"])
digest = hashlib.sha256()
digest.update(f"base:{base_sha}\n".encode())

files = []
for rel in inputs:
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        continue
    if os.path.isfile(path):
        files.append((rel, path))
        continue
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = sorted(
            name for name in dirnames
            if name not in {".git", "node_modules", "dist", "coverage"}
        )
        for filename in sorted(filenames):
            full = os.path.join(dirpath, filename)
            files.append((os.path.relpath(full, root), full))

for rel, path in sorted(files):
    digest.update(rel.encode())
    digest.update(b"\0")
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    digest.update(b"\0")

print(digest.hexdigest())
PY
)
LAST_BOT_IMAGE_SHA=""
[ -f "$BOT_IMAGE_SHA_FILE" ] && LAST_BOT_IMAGE_SHA=$(cat "$BOT_IMAGE_SHA_FILE")

if [ "$BOT_IMAGE_SHA" = "$LAST_BOT_IMAGE_SHA" ] && docker image inspect "$BOT_IMAGE" >/dev/null 2>&1; then
  echo "$BOT_IMAGE up to date, skipping."
else
  TMPCTX=$(mktemp -d)
  cp -r "$DUALVIEW_ROOT/plugin/dualview" "$TMPCTX/plugin-dualview"
  # Guardrail plugins (optional — skip if not present)
  [ -d "$DUALVIEW_ROOT/plugin/llama-prompt-guard" ] && cp -r "$DUALVIEW_ROOT/plugin/llama-prompt-guard" "$TMPCTX/plugin-llama-prompt-guard"
  [ -d "$DUALVIEW_ROOT/plugin/llama-secalign" ] && cp -r "$DUALVIEW_ROOT/plugin/llama-secalign" "$TMPCTX/plugin-llama-secalign"

  copy_fws_source "$TMPCTX/fws"
  mkdir -p "$TMPCTX/gws-cache"
  cp -r "$FWS_DISCOVERY_CACHE_DIR"/. "$TMPCTX/gws-cache"/
  cp "$DUALVIEW_ROOT/scripts/lib/seed-gws-demo.sh" "$TMPCTX/seed-gws-test-data.sh"
  cp "$DUALVIEW_ROOT/docker/Dockerfile.bot" "$TMPCTX/Dockerfile"
  docker build -t "$BOT_IMAGE" "$TMPCTX"
  rm -rf "$TMPCTX"
  echo "$BOT_IMAGE_SHA" > "$BOT_IMAGE_SHA_FILE"
fi

echo "=== Starting $BOT_CONTAINER on port $BOT_PORT ==="
# Write git global config so safe.directory is set before the gateway loads
# the DUALVIEW plugin (required for worktree-mode file tracking).
cat > "$BOT_STATE_DIR/.gitconfig" <<GITCFG
[safe]
	directory = /home/node/workspace
	directory = /home/node/workspace/.dualview/trusted
[user]
	name = dualview-bot
	email = dualview-bot@localhost
GITCFG

# Build -e flags for all configured provider keys
DOCKER_ENV_ARGS=()
for _k in "${FORWARD_KEYS[@]}"; do
  eval "_v=\${$_k:-}"
  [ -n "$_v" ] && DOCKER_ENV_ARGS+=(-e "${_k}=${_v}")
done

docker run -d --name "$BOT_CONTAINER" \
  --cap-add SYS_ADMIN \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/node \
  -e GIT_CONFIG_GLOBAL=/home/node/.openclaw/.gitconfig \
  -e "DUALVIEW_BOT_BATCH_ID=${DUALVIEW_BOT_BATCH_ID:-$BATCH_ID}" \
  -v "$BOT_NODE_HOME":/home/node \
  "${DOCKER_ENV_ARGS[@]}" \
  -p "$BOT_PORT":18789 \
  --restart unless-stopped \
  "$BOT_IMAGE"

docker logs -f "$BOT_CONTAINER" > "$BATCH_DIR/00.log" 2>&1 &

if [ "${DUALVIEW_BOT_DASHBOARD:-1}" != "0" ]; then
  DASHBOARD_LOG="$BATCH_DIR/dashboard.log"
  DASHBOARD_PORT="${DASHBOARD_PORT:-${DUALVIEW_DASHBOARD_PORT:-13457}}"
  if curl -sfI "http://127.0.0.1:$DASHBOARD_PORT/bot/" >/dev/null 2>&1 || \
     curl -sfI "http://127.0.0.1:$DASHBOARD_PORT/" >/dev/null 2>&1; then
    echo "=== Dashboard already listening on port $DASHBOARD_PORT ==="
  else
    DASHBOARD_PID=$(lsof -ti "tcp:$DASHBOARD_PORT" 2>/dev/null || true)
    if [ -n "$DASHBOARD_PID" ]; then
      echo "=== Dashboard already listening on port $DASHBOARD_PORT (PID $DASHBOARD_PID) ==="
    else
      echo "=== Starting DUALVIEW bot dashboard on port $DASHBOARD_PORT ==="
      DASHBOARD_CMD_FILE="$BATCH_DIR/dashboard-command.sh"
      cat > "$DASHBOARD_CMD_FILE" <<DASHBOARD_SH
#!/usr/bin/env bash
set -euo pipefail
cd "$DUALVIEW_ROOT"
if [ -x "$DUALVIEW_ROOT/node_modules/.bin/tsx" ]; then
  DASHBOARD_CMD=("$DUALVIEW_ROOT/node_modules/.bin/tsx")
elif [ -x "$OPENCLAW_DIR/node_modules/.bin/tsx" ]; then
  DASHBOARD_CMD=("$OPENCLAW_DIR/node_modules/.bin/tsx")
else
  DASHBOARD_CMD=(npx tsx)
fi
DUALVIEW_BOT_DIR="$BOT_LOG_BASE" DASHBOARD_PORT="$DASHBOARD_PORT" DASHBOARD_TIMEZONE="${DASHBOARD_TIMEZONE:-}" \
  "\${DASHBOARD_CMD[@]}" ./dashboard/bot-server.ts --bot-dir "$BOT_LOG_BASE" --port "$DASHBOARD_PORT"
DASHBOARD_SH
      chmod +x "$DASHBOARD_CMD_FILE"
      setsid -f "$DASHBOARD_CMD_FILE" > "$DASHBOARD_LOG" 2>&1 < /dev/null
      sleep 1
      DASHBOARD_PID=$(pgrep -f "dashboard/bot-server.ts.*--port $DASHBOARD_PORT" | head -n 1 || true)
      [ -n "$DASHBOARD_PID" ] && echo "$DASHBOARD_PID" > "$BATCH_DIR/dashboard.pid"
    fi
  fi
fi

echo "=== Waiting for health check ==="
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$BOT_PORT/healthz" >/dev/null 2>&1; then
    echo ""
    echo "Bot is healthy!"
    echo ""
    _GW_TOKEN=$(python3 -c "import json,sys;c=json.load(open('$BOT_STATE_DIR/openclaw.json'));t=c.get('gateway',{}).get('auth',{}).get('token','');print(t)" 2>/dev/null || true)
    if [ -n "$_GW_TOKEN" ]; then
      echo "  OpenClaw:       http://127.0.0.1:$BOT_PORT/#token=$_GW_TOKEN"
    else
      echo "  OpenClaw:       http://127.0.0.1:$BOT_PORT"
    fi
    echo "  View logs:      docker logs -f $BOT_CONTAINER"
    if [ -n "${DUALVIEW_DASHBOARD_URL:-}" ]; then
      echo "  DUALVIEW dashboard: $DUALVIEW_DASHBOARD_URL"
    elif [ -n "${DUALVIEW_BOT_DASHBOARD_URL:-}" ]; then
      echo "  DUALVIEW dashboard: $DUALVIEW_BOT_DASHBOARD_URL"
    elif [ -n "${DUALVIEW_DASHBOARD_PORT:-}" ]; then
      echo "  DUALVIEW dashboard: http://${DUALVIEW_DASHBOARD_HOST:-127.0.0.1}:$DUALVIEW_DASHBOARD_PORT/bot/"
    else
      echo "  DUALVIEW dashboard: http://127.0.0.1:${DASHBOARD_PORT:-13457}/bot/"
      echo "  Slack symbol links: set DUALVIEW_DASHBOARD_PORT (and DUALVIEW_DASHBOARD_HOST) or DUALVIEW_DASHBOARD_URL to enable dashboard links"
    fi
    echo ""
    exit 0
  fi
  sleep 2
done

echo "ERROR: Bot did not become healthy in 120s"
docker logs "$BOT_CONTAINER" --tail 50
exit 1
