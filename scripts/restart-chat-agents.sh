#!/usr/bin/env sh
# Rebuild + restart agents involved in web chat, HIL approvals, and investigate flow.
# Use after changes to commander, orchestrator, console, or hil.
set -e
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

COMPOSE="podman compose"
COMPOSE_ENV_FILE=""
if ! podman compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
fi
if [ -f .env.local ]; then
  COMPOSE_ENV_FILE="--env-file .env.local"
fi

SERVICES="commander-agent orchestrator-agent console-agent hil-agent redis"

echo "Rebuilding: $SERVICES"
$COMPOSE $COMPOSE_ENV_FILE build --no-cache $SERVICES
$COMPOSE $COMPOSE_ENV_FILE up -d $SERVICES

echo ""
echo "Done. Console: http://localhost:8091/chat"
echo "Tip: start a New chat or Clear thread — old sessions may still show the stuck status line."
