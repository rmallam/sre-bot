#!/usr/bin/env sh
# Clean Podman/Docker Compose startup (avoids stale depends_on container IDs).
set -e
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  echo "Loading .env.local"
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
else
  echo "Warning: .env.local not found — copy secrets.example.yaml and fill tokens/keys"
fi

COMPOSE="podman compose"
COMPOSE_ENV_FILE=""
if ! podman compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
fi
if [ -f .env.local ]; then
  COMPOSE_ENV_FILE="--env-file .env.local"
fi

echo "Using: $COMPOSE"
$COMPOSE down --remove-orphans
exec $COMPOSE $COMPOSE_ENV_FILE up --build "$@"
