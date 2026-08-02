#!/usr/bin/env bash
# Run the DualView OpenClaw bot locally (Option 1, non-Docker).
#
# One command for the local path: validates .env, builds the bundled OpenClaw if
# needed, installs + enables the DualView plugin into ~/.openclaw, then starts
# the gateway. Slack auto-enables from SLACK_BOT_TOKEN/SLACK_APP_TOKEN.
#
# For the isolated, persistent Docker path use scripts/setup-openclaw-bot.sh.
set -euo pipefail

DUALVIEW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'HELP'
Usage: ./scripts/run-bot-local.sh [options]

Builds the bundled OpenClaw (if dist is missing), installs the DualView plugin
into ~/.openclaw, and runs the gateway locally on this machine.

Required in .env (repo root):
  An LLM credential (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY /
    OPENAI_CODEX_ACCESS+OPENAI_CODEX_REFRESH), and
  Slack tokens: SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode, default)
    or SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET when SLACK_MODE=http.

Options:
  --port <port>     Gateway port (default: 18789)
  --model <id>      Bot model (default: $DUALVIEW_BOT_MODEL if set, else
                    OpenClaw's own default). Example: anthropic/claude-opus-4-8
  --skip-build      Do not build OpenClaw even if dist is missing (will fail
                    if dist/entry.js is absent). By default the bundled OpenClaw
                    source is built automatically (via pnpm, or Node's corepack).
  --no-plugin       Do not (re)install the DualView plugin.
  -h, --help        Show this help.

Note: this path writes to your real ~/.openclaw state directory (config,
plugin registration, sessions). For an isolated run, use the Docker path.
HELP
  exit 0
}

GW_PORT="18789"
MODEL_ARG=""
SKIP_BUILD=0
INSTALL_PLUGIN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) GW_PORT="$2"; shift 2 ;;
    --model) MODEL_ARG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-plugin) INSTALL_PLUGIN=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1 (use --help)" >&2; exit 1 ;;
  esac
done

# Load .env (same root file the Docker scripts use).
if [ -f "$DUALVIEW_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$DUALVIEW_ROOT/.env"
  set +a
fi

# Preflight: required .env values must be present before we do any slow work.
# shellcheck source=scripts/lib/check-bot-env.sh
source "$DUALVIEW_ROOT/scripts/lib/check-bot-env.sh"
require_llm_credential || exit 1
require_slack_env || exit 1

MODEL_ARG="${MODEL_ARG:-${DUALVIEW_BOT_MODEL:-}}"
OPENCLAW=(node "$DUALVIEW_ROOT/openclaw/openclaw.mjs")

# -- Build the bundled OpenClaw if needed --------------------------------------

DIST_OK=0
[ -f "$DUALVIEW_ROOT/openclaw/dist/entry.js" ] && DIST_OK=1
[ -f "$DUALVIEW_ROOT/openclaw/dist/entry.mjs" ] && DIST_OK=1

if [ "$DIST_OK" -eq 0 ]; then
  if [ "$SKIP_BUILD" -eq 1 ]; then
    echo "ERROR: openclaw/dist is missing and --skip-build was set." >&2
    echo "  Remove --skip-build to build it automatically." >&2
    exit 1
  fi
  # Resolve pnpm without requiring a global install: prefer one on PATH,
  # otherwise use Node's bundled corepack (openclaw pins the pnpm version via
  # its package.json "packageManager" field, so corepack fetches the right one).
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    PNPM=(corepack pnpm)
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  else
    echo "ERROR: cannot build OpenClaw: neither pnpm nor corepack was found." >&2
    echo "  Node 16.13+ ships corepack; ensure Node is installed, or install pnpm." >&2
    exit 1
  fi
  echo "=== Building bundled OpenClaw (one-time, via ${PNPM[*]}) ==="
  (cd "$DUALVIEW_ROOT/openclaw" && "${PNPM[@]}" install && "${PNPM[@]}" build)
fi

# -- Install dependencies ------------------------------------------------------

if [ ! -d "$DUALVIEW_ROOT/node_modules" ]; then
  echo "=== Installing root dependencies ==="
  (cd "$DUALVIEW_ROOT" && npm install)
fi

# -- Install + enable the DualView plugin --------------------------------------

if [ "$INSTALL_PLUGIN" -eq 1 ]; then
  if [ ! -d "$DUALVIEW_ROOT/plugin/dualview/node_modules" ]; then
    echo "=== Installing DualView plugin dependencies ==="
    (cd "$DUALVIEW_ROOT" && npm install --prefix plugin/dualview)
  fi
  echo "=== Installing DualView plugin into ~/.openclaw ==="
  "${OPENCLAW[@]}" plugins install ./plugin/dualview --link
  "${OPENCLAW[@]}" plugins enable dualview || true
  # DualView only inspects channels it targets; scope it to Slack for this path.
  "${OPENCLAW[@]}" config set plugins.entries.dualview.config.targetChannels '["slack:*"]' --strict-json || true
fi

# -- Model override (optional) -------------------------------------------------

if [ -n "$MODEL_ARG" ]; then
  echo "=== Setting bot model: $MODEL_ARG ==="
  "${OPENCLAW[@]}" config set agents.defaults.model.primary "$MODEL_ARG"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Hint: ANTHROPIC_API_KEY is set. If the gateway picks the wrong model," \
       "re-run with --model anthropic/claude-opus-4-8 (or set DUALVIEW_BOT_MODEL)." >&2
fi

# -- Run -----------------------------------------------------------------------

echo "=== Starting gateway on port $GW_PORT ==="
exec "${OPENCLAW[@]}" gateway run --port "$GW_PORT"
