#!/usr/bin/env bash
# Run unit tests for app catalog, discovery, and chat waiting-state fixes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PATTERN="${1:-}"

if [[ -n "$PATTERN" ]]; then
  npx vitest run $PATTERN
else
  npx vitest run \
    shared/test/app-catalog.test.ts \
    shared/test/app-discovery.test.ts \
    shared/test/chat-waiting-state.test.ts \
    shared/test/app-parser.test.ts \
    shared/test/app-graph.test.ts \
    shared/test/deploy-workloads.test.ts \
    agents/investigator/test/app-catalog-store.test.ts \
    agents/commander/test/event-investigate-parser.test.ts \
    agents/commander/test/app-investigate-parser.test.ts
fi

echo ""
echo "All app-catalog / chat-waiting tests passed."
