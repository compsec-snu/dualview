#!/usr/bin/env bash
# Approve a channel pairing request for the DUALVIEW bot container.
# Usage: ./scripts/bot-approve-pairing.sh [channel] <pairing-code>
set -euo pipefail

BOT_CONTAINER="dualview-bot"

if [ $# -lt 1 ]; then
  echo "Usage: $0 [channel] <pairing-code>"
  echo "Examples:"
  echo "  $0 telegram NSSPMWUQ"
  echo "  $0 slack NSSPMWUQ"
  exit 1
fi

if [ $# -eq 1 ]; then
  CHANNEL="telegram"
  PAIRING_CODE="$1"
else
  CHANNEL="$1"
  PAIRING_CODE="$2"
fi

docker exec "$BOT_CONTAINER" node /app/dist/index.js pairing approve "$CHANNEL" "$PAIRING_CODE"
