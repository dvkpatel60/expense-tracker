#!/usr/bin/env bash
#
# Local startup. Loads .env, reports which providers are configured, then hands
# off to Vite — which serves the app and the /api functions from one process.
#
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found — created one from .env.example."
  cp .env.example .env
  echo "Add a key to .env and restart to enable merchant identification."
  echo "Starting anyway; everything else works without one."
  echo
fi

# Export every assignment in .env without executing it as a script.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

configured=()
[ -n "${ANTHROPIC_API_KEY:-}" ] && configured+=("Anthropic")
[ -n "${GEMINI_API_KEY:-}" ]    && configured+=("Gemini")

if [ ${#configured[@]} -eq 0 ]; then
  echo "Providers configured: none — merchant identification will be disabled."
  echo "                      (add ANTHROPIC_API_KEY or GEMINI_API_KEY to .env)"
else
  echo "Providers configured: ${configured[*]}"
fi
echo "Merchant lookups are cached in memory for the life of this process."
echo

# Kill any process already on the Vite dev port (default 5173) before starting.
PORT="${VITE_PORT:-5173}"
if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "Killing process on port $PORT..."
  kill "$(lsof -ti :"$PORT")" 2>/dev/null || true
  sleep 1
fi

exec npx vite "$@"
