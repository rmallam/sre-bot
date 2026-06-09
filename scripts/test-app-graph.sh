#!/usr/bin/env bash
# Smoke-test app graph endpoints (investigator + console BFF).
set -euo pipefail

INVESTIGATOR_URL="${INVESTIGATOR_URL:-http://localhost:8082}"
CONSOLE_URL="${CONSOLE_URL:-http://localhost:9091}"
APP_ID="${APP_ID:-commander-agent}"
NAMESPACE="${NAMESPACE:-sre-bot-system}"

echo "== Investigator GET /apps =="
curl -sf "${INVESTIGATOR_URL}/apps?namespace=${NAMESPACE}" | python3 -m json.tool | head -40

echo ""
echo "== Investigator GET /app-review appId=${APP_ID} =="
curl -sf "${INVESTIGATOR_URL}/app-review?appId=${APP_ID}&namespace=${NAMESPACE}&force=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('status', d.get('overallStatus'), 'nodes', len(d.get('graph',{}).get('nodes',[])))"

echo ""
echo "== Console GET /api/app-review =="
curl -sf "${CONSOLE_URL}/api/app-review?appId=${APP_ID}&namespace=${NAMESPACE}&force=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('appId', d.get('appId'), 'reachable', d.get('reachable'))"

echo ""
echo "App graph smoke checks passed."
