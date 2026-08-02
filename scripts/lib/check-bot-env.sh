#!/usr/bin/env bash
# Shared startup preflight checks for the DualView bot.
#
# Used by both run paths so missing required values in .env fail fast with a
# clear message instead of a confusing runtime/Docker error:
#   - scripts/run-bot-local.sh       (Option 1, local/non-Docker)
#   - scripts/setup-openclaw-bot.sh  (Option 2, Docker)
#
# Source this file; it defines functions only (no side effects). Each function
# prints to stderr and returns non-zero on failure so callers can `|| exit 1`.

# require_llm_credential
#   Succeeds when any accepted LLM credential source is present. Mirrors the
#   auth sources tried by scripts/run-bot.sh.
require_llm_credential() {
  if [ -n "${ANTHROPIC_API_KEY:-}" ] \
    || [ -n "${OPENAI_API_KEY:-}" ] \
    || [ -n "${GEMINI_API_KEY:-}" ] \
    || { [ -n "${OPENAI_CODEX_ACCESS:-}" ] && [ -n "${OPENAI_CODEX_REFRESH:-}" ]; } \
    || [ -f "${HOME}/.codex/auth.json" ] \
    || [ -f "${HOME}/.openclaw/agents/main/agent/auth-profiles.json" ]; then
    return 0
  fi
  cat >&2 <<'MSG'
ERROR: No LLM credential found in .env or environment.
  Set one of the following in .env (repo root):
    ANTHROPIC_API_KEY=sk-ant-...
    OPENAI_API_KEY=sk-...
    GEMINI_API_KEY=...
    OPENAI_CODEX_ACCESS=...  and  OPENAI_CODEX_REFRESH=...
  Or provide ~/.codex/auth.json, or an existing ~/.openclaw auth profile.
MSG
  return 1
}

# require_slack_env
#   Validates the Slack tokens required for the configured SLACK_MODE.
#   socket (default): SLACK_BOT_TOKEN + SLACK_APP_TOKEN
#   http:             SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET
require_slack_env() {
  local mode missing
  mode="$(printf '%s' "${SLACK_MODE:-socket}" | tr '[:upper:]' '[:lower:]')"
  missing=()
  [ -z "${SLACK_BOT_TOKEN:-}" ] && missing+=("SLACK_BOT_TOKEN (xoxb-...)")
  if [ "$mode" = "http" ]; then
    [ -z "${SLACK_SIGNING_SECRET:-}" ] && missing+=("SLACK_SIGNING_SECRET (required for SLACK_MODE=http)")
  else
    [ -z "${SLACK_APP_TOKEN:-}" ] && missing+=("SLACK_APP_TOKEN (xapp-..., required for Socket Mode)")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    {
      echo "ERROR: Slack is enabled but required value(s) are missing from .env:"
      printf '  - %s\n' "${missing[@]}"
      echo "  See docs/setup.md for how to create the Slack app and tokens."
    } >&2
    return 1
  fi
  return 0
}
