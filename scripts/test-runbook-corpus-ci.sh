#!/usr/bin/env bash
# Offline runbook corpus checks for CI (no Kind / platform required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Runbook corpus CI (offline GP-RB) =="
npm run runbooks:validate
npm test -- --run shared/test/runbook-corpus.test.ts shared/test/runbook-normalize.test.ts
npm run test:platform
FIXTURE_APPLY=false FIXTURE_INVESTIGATE=false FIXTURE_RAG_GROUND=false \
  "$ROOT/scripts/test-runbook-fixtures.sh"
