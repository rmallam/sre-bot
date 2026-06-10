#!/usr/bin/env bash
# Run full test matrix: unit catalogs, platform smoke, Kind E2E, workflow E2E.
# Usage: ./scripts/test-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

run_step() {
  local name="$1"
  shift
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if "$@"; then
    echo "→ $name OK"
  else
    echo "→ $name FAILED" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_step "App catalog unit tests" ./scripts/test-app-catalog.sh
run_step "Platform integration smoke" ./scripts/test-platform-integration.sh
run_step "Kind platform E2E" ./scripts/test-e2e-kind.sh
run_step "Functional workflow E2E" ./scripts/test-e2e-workflows.sh

echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "test-all: $FAIL suite(s) failed"
  exit 1
fi
echo "test-all: all suites passed"
