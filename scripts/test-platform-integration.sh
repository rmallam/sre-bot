#!/usr/bin/env bash
# Smoke-test platform-agent wiring (semantic route + RAG ground + downstream health).
set -euo pipefail

PLATFORM_URL="${PLATFORM_URL:-http://localhost:8090}"
COMMANDER_URL="${COMMANDER_URL:-http://localhost:8081}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:8084}"

echo "== Platform health =="
curl -sf "$PLATFORM_URL/health" | python3 -m json.tool

echo ""
echo "== Semantic route: diagnose =="
curl -sf -X POST "$PLATFORM_URL/route" \
  -H 'Content-Type: application/json' \
  -d '{"text":"investigate OOMKilled in production payments-api"}' | python3 -m json.tool

echo ""
echo "== Semantic route: chitchat =="
curl -sf -X POST "$PLATFORM_URL/route" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello there"}' | python3 -m json.tool

echo ""
echo "== RAG ground: OOMKilled =="
curl -sf -X POST "$PLATFORM_URL/rag/ground" \
  -H 'Content-Type: application/json' \
  -d '{"detected_error":"OOMKilled","target_component":"compute","target_workload":"payments-api"}' \
  | python3 -m json.tool

echo ""
echo "== Commander health (platform wired) =="
curl -sf "$COMMANDER_URL/health" | python3 -m json.tool

echo ""
echo "== Orchestrator health =="
curl -sf "$ORCHESTRATOR_URL/health" | python3 -m json.tool

echo ""
echo "All platform integration smoke checks passed."
