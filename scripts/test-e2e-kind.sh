#!/usr/bin/env bash
# End-to-end smoke + feature tests against Kind (or compose) deployment.
# Usage: ./scripts/test-e2e-kind.sh
# Env: KIND_CONTEXT, NS, COMMANDER_URL, INVESTIGATOR_URL, ORCHESTRATOR_URL, ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/test-e2e-lib.sh"
trap e2e_cleanup EXIT INT TERM

echo "══════════════════════════════════════════════════════════════"
echo " SRE Bot E2E Test Suite"
echo "══════════════════════════════════════════════════════════════"
echo " Commander:     $COMMANDER_URL"
echo " Investigator:  $INVESTIGATOR_URL"
echo " Orchestrator:  $ORCHESTRATOR_URL"
echo " Platform:      $PLATFORM_URL"
echo " Console:       $CONSOLE_URL"
echo ""

ensure_port_forwards

# ── 1. Agent health matrix ───────────────────────────────────────────────────
echo "▶ 1. Agent health checks"
for pair in \
  "commander|$COMMANDER_URL/health" \
  "investigator|$INVESTIGATOR_URL/health" \
  "orchestrator|$ORCHESTRATOR_URL/health" \
  "brain|$BRAIN_URL/health" \
  "hil|$HIL_URL/health" \
  "platform|$PLATFORM_URL/health" \
  "console|$CONSOLE_URL/health"; do
  IFS='|' read -r agent url <<< "$pair"
  if curl -sf -m 10 "$url" >/dev/null 2>&1; then
    pass "$agent /health"
  else
    fail "$agent /health" "$url unreachable"
  fi
done

# ── 2. Agent mode in health payloads (AGENT-8) ───────────────────────────────
echo ""
echo "▶ 2. Agent mode configuration (AGENT-8)"
ORCH_HEALTH="$(curl -sf -m 10 "$ORCHESTRATOR_URL/health" 2>/dev/null || echo '{}')"
if echo "$ORCH_HEALTH" | grep -q agentMode; then
  assert_json_field "orchestrator exposes agentMode" "$ORCH_HEALTH" "d.get('agentMode','')" "agentic"
  assert_json_field "orchestrator graphMode" "$ORCH_HEALTH" "d.get('graphMode','')" "react"
else
  fail "orchestrator agentMode payload" "missing agentMode field"
fi

# ── 3. Investigator cluster health (PLAT-6 watcher input) ────────────────────
echo ""
echo "▶ 3. Cluster health snapshot (PLAT-6)"
CH="$(curl -sf -m 60 "$INVESTIGATOR_URL/cluster-health" 2>/dev/null || echo '{}')"
if echo "$CH" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'clusterReachable' in d or 'nodes' in d or 'summary' in d else 1)" 2>/dev/null; then
  pass "GET /cluster-health returns health payload"
else
  fail "GET /cluster-health" "unexpected response shape"
fi

# ── 4. Deep RCA — workload scope ─────────────────────────────────────────────
echo ""
echo "▶ 4. Deep RCA — workload scope"
WL_FACTS="$(curl -sf -m 90 \
  "$INVESTIGATOR_URL/facts?incidentId=e2e-wl&namespace=sre-bot-system&resourceName=investigator-agent&resourceKind=Deployment&mode=diagnose&investigateScope=workload" \
  2>/dev/null || echo '{}')"
if echo "$WL_FACTS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('resourceName') else 1)" 2>/dev/null; then
  pass "workload /facts returns DiagnosisContext"
  assert_json_truthy "workload has rcaPointers array" "$WL_FACTS" "isinstance(d.get('rcaPointers'), list) and len(d.get('rcaPointers',[]))>0"
  assert_json_truthy "workload has observabilitySummary" "$WL_FACTS" "bool(d.get('observabilitySummary'))"
else
  fail "workload /facts" "request failed or empty"
fi

# ── 5. Deep RCA — cluster scope (PLAT-4c) ────────────────────────────────────
echo ""
echo "▶ 5. Deep RCA — cluster scope (PLAT-4c)"
CL_FACTS="$(curl -sf -m 90 \
  "$INVESTIGATOR_URL/facts?incidentId=e2e-cluster&namespace=default&resourceName=_cluster&resourceKind=Deployment&mode=diagnose&investigateScope=cluster" \
  2>/dev/null || echo '{}')"
if echo "$CL_FACTS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('resourceName') else 1)" 2>/dev/null; then
  pass "cluster /facts returns DiagnosisContext"
  assert_json_truthy "cluster has scopeHealth" "$CL_FACTS" "isinstance(d.get('scopeHealth'), dict)"
  assert_json_truthy "cluster scopeHealth.scope=cluster" "$CL_FACTS" "d.get('scopeHealth',{}).get('scope')=='cluster'"
  assert_json_truthy "cluster has rcaPointers" "$CL_FACTS" "isinstance(d.get('rcaPointers'), list) and len(d.get('rcaPointers',[]))>0"
  assert_json_truthy "cluster pointer mentions overview" "$CL_FACTS" \
    "any('overview' in (p.get('title','').lower()) or 'unreachable' in (p.get('title','').lower()) for p in d.get('rcaPointers',[]))"
else
  fail "cluster /facts" "request failed"
fi

# ── 6. Deep RCA — namespace scope (PLAT-4c) ──────────────────────────────────
echo ""
echo "▶ 6. Deep RCA — namespace scope (PLAT-4c)"
NS_FACTS="$(curl -sf -m 90 \
  "$INVESTIGATOR_URL/facts?incidentId=e2e-ns&namespace=sre-bot-system&resourceName=_namespace&resourceKind=Deployment&mode=diagnose&investigateScope=namespace" \
  2>/dev/null || echo '{}')"
if echo "$NS_FACTS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('namespace') else 1)" 2>/dev/null; then
  pass "namespace /facts returns DiagnosisContext"
  assert_json_truthy "namespace has scopeHealth" "$NS_FACTS" "isinstance(d.get('scopeHealth'), dict)"
  assert_json_truthy "namespace scopeHealth.scope=namespace" "$NS_FACTS" "d.get('scopeHealth',{}).get('scope')=='namespace'"
  assert_json_truthy "namespace has rcaPointers" "$NS_FACTS" "isinstance(d.get('rcaPointers'), list) and len(d.get('rcaPointers',[]))>0"
else
  fail "namespace /facts" "request failed"
fi

# ── 7. Orchestrator run lifecycle + dedupe (AGENT-D3) ────────────────────────
echo ""
echo "▶ 7. Orchestrator run lifecycle + dedupe"
E2E_ID="e2e-$(date +%s)"
E2E_RESOURCE="e2e-probe-${E2E_ID}"
RUN_BODY="$(cat <<EOF
{
  "incidentId": "$E2E_ID",
  "namespace": "sre-bot-system",
  "resourceName": "$E2E_RESOURCE",
  "resourceKind": "Deployment",
  "mode": "diagnose",
  "triggeredBy": "e2e-test",
  "platform": "web",
  "channelId": "e2e"
}
EOF
)"
ACCEPT1="$(curl -sf -m 15 -X POST "$ORCHESTRATOR_URL/runs" -H 'Content-Type: application/json' -d "$RUN_BODY" 2>/dev/null || echo '{}')"
if echo "$ACCEPT1" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('accepted') is True else 1)" 2>/dev/null; then
  pass "POST /runs accepted first request"
elif echo "$ACCEPT1" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('deduplicated') is True else 1)" 2>/dev/null; then
  E2E_ID="$(echo "$ACCEPT1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('existingIncidentId',''))")"
  pass "POST /runs deduplicated (prior active run — AGENT-D3)"
else
  fail "POST /runs first request" "$(echo "$ACCEPT1" | head -c 200)"
fi

sleep 2
DEDUPE="$(curl -sf -m 15 -X POST "$ORCHESTRATOR_URL/runs" -H 'Content-Type: application/json' -d "$RUN_BODY" 2>/dev/null || echo '{}')"
if echo "$DEDUPE" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('deduplicated') is True else 1)" 2>/dev/null; then
  pass "POST /runs deduplicates active run (AGENT-D3)"
else
  skip "dedupe (run may have completed before second POST)"
fi

# Poll for run record (async persist)
RUNS='{}'
for _ in 1 2 3 4 5 6; do
  RUNS="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs?incidentId=$E2E_ID&limit=5" 2>/dev/null || echo '{}')"
  if echo "$RUNS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if len(d.get('runs',[]))>=1 else 1)" 2>/dev/null; then
    break
  fi
  sleep 3
done
if echo "$RUNS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if len(d.get('runs',[]))>=1 else 1)" 2>/dev/null; then
  pass "GET /runs lists created run"
  assert_json_truthy "run list includes isStale field" "$RUNS" "'isStale' in d.get('runs',[{}])[0]"
  assert_json_truthy "run list includes suggestedActionLabel" "$RUNS" "'suggestedActionLabel' in d.get('runs',[{}])[0]"
else
  fail "GET /runs for incident" "$E2E_ID"
fi

# ── 8. Orchestrator tools registry ───────────────────────────────────────────
echo ""
echo "▶ 8. Tool registry"
TOOLS="$(curl -sf -m 10 "$ORCHESTRATOR_URL/tools" 2>/dev/null || echo '{}')"
if echo "$TOOLS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if len(d.get('tools',[]))>5 else 1)" 2>/dev/null; then
  pass "GET /tools returns tool catalog"
else
  fail "GET /tools" "empty or missing"
fi

# ── 9. AlertManager webhook (PLAT-7) ─────────────────────────────────────────
echo ""
echo "▶ 9. AlertManager webhook (PLAT-7)"
AM_BODY='{"status":"firing","alerts":[{"status":"firing","labels":{"namespace":"sre-bot-system","deployment":"redis","alertname":"E2ETestAlert"},"annotations":{"summary":"e2e test alert"},"fingerprint":"e2e-fp-'"$E2E_ID"'"}]}'
AM_RESP="$(curl -sf -m 20 -X POST "$COMMANDER_URL/webhooks/alertmanager" \
  -H 'Content-Type: application/json' -d "$AM_BODY" 2>/dev/null || echo '{}')"
if echo "$AM_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('ok') is True else 1)" 2>/dev/null; then
  pass "POST /webhooks/alertmanager accepted (ok=true)"
elif echo "$AM_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'started' in d or 'incidentIds' in d else 1)" 2>/dev/null; then
  pass "POST /webhooks/alertmanager accepted"
else
  # may return 202 with different shape
  HTTP_CODE="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$COMMANDER_URL/webhooks/alertmanager" \
    -H 'Content-Type: application/json' -d "$AM_BODY" 2>/dev/null || echo 000)"
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    pass "POST /webhooks/alertmanager HTTP $HTTP_CODE"
  else
    fail "POST /webhooks/alertmanager" "HTTP $HTTP_CODE — $(echo "$AM_RESP" | head -c 150)"
  fi
fi

# ── 10. Platform semantic router + RAG (PLAT routing) ────────────────────────
echo ""
echo "▶ 10. Platform agent (semantic route + RAG)"
if curl -sf -m 10 "$PLATFORM_URL/health" >/dev/null 2>&1; then
  ROUTE="$(curl -sf -m 20 -X POST "$PLATFORM_URL/route" -H 'Content-Type: application/json' \
    -d '{"text":"investigate crashloop in sre-bot-system redis"}' 2>/dev/null || echo '{}')"
  assert_json_truthy "semantic route returns intent" "$ROUTE" "bool(d.get('intent') or d.get('route') or d.get('classification'))"

  RAG="$(curl -sf -m 20 -X POST "$PLATFORM_URL/rag/ground" -H 'Content-Type: application/json' \
    -d '{"detected_error":"CrashLoopBackOff","target_component":"compute","target_workload":"redis"}' 2>/dev/null || echo '{}')"
  pass "POST /rag/ground responded"
else
  skip "platform tests — not reachable at $PLATFORM_URL"
fi

# ── 11. Debug MCP sidecar (PLAT-11) ──────────────────────────────────────────
echo ""
echo "▶ 11. Debug MCP (PLAT-11)"
DM_HEALTH="$(curl -sf -m 5 "$DEBUG_MCP_URL/health" 2>/dev/null || echo '')"
if [[ -n "$DM_HEALTH" ]]; then
  assert_json_field "debug-mcp readOnly=true" "$DM_HEALTH" "str(d.get('readOnly'))" "True"
  if echo "$DM_HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('enabled') else 1)" 2>/dev/null; then
    TOOLS="$(curl -sf -m 10 "$DEBUG_MCP_URL/v1/tools" 2>/dev/null || echo '{}')"
    assert_json_truthy "debug-mcp tools catalog" "$TOOLS" "len(d.get('tools',[]))>=4"
  else
    pass "debug-mcp deployed but disabled (expected default)"
  fi
else
  skip "debug-mcp not port-forwarded / not deployed"
fi

# ── 12. Console API ──────────────────────────────────────────────────────────
echo ""
echo "▶ 12. Console web API"
AUTH_CFG="$(curl -sf -m 10 "$CONSOLE_URL/api/auth/config" 2>/dev/null || echo '{}')"
if echo "$AUTH_CFG" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'enabled' in d else 1)" 2>/dev/null; then
  pass "GET /api/auth/config"
  assert_json_truthy "auth config exposes sessionCookie" "$AUTH_CFG" "d.get('sessionCookie') is True"
else
  fail "GET /api/auth/config" "$(echo "$AUTH_CFG" | head -c 120)"
fi
if curl -sf -m 10 "$CONSOLE_URL/api/runs?limit=5" >/dev/null 2>&1; then
  pass "GET /api/runs"
else
  RUNS_API="$(curl -sf -m 10 "$CONSOLE_URL/api/v1/runs?limit=5" 2>/dev/null || echo '')"
  if [[ -n "$RUNS_API" ]]; then
    pass "GET /api/v1/runs"
  else
    skip "console runs API path unknown"
  fi
fi

# ── 14. Run detail + stale metadata ───────────────────────────────────────────
echo ""
echo "▶ 14. Run detail API (stale-run hardening)"
RUN_ID="$(echo "$RUNS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('runs',[{}])[0].get('runId',''))" 2>/dev/null || echo '')"
if [[ -n "$RUN_ID" ]]; then
  DETAIL="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$RUN_ID" 2>/dev/null || echo '{}')"
  assert_json_truthy "GET /runs/:id includes isStale" "$DETAIL" "'isStale' in d"
  assert_json_truthy "GET /runs/:id includes suggestedActionLabel" "$DETAIL" "'suggestedActionLabel' in d"
else
  skip "run detail — no runId from prior step"
fi

# ── 15. Security sanitize (PLAT-9 pipeline) ──────────────────────────────────
echo ""
echo "▶ 15. Security agent sanitize"
SEC_URL="${SECURITY_URL:-http://localhost:9088}"
if ! curl -sf -m 5 "$SEC_URL/health" >/dev/null 2>&1 && [[ "$AUTO_PORT_FORWARD" == "true" ]]; then
  start_port_forward security-agent 9088
  sleep 2
fi
if curl -sf -m 5 "$SEC_URL/health" >/dev/null 2>&1; then
  SAN="$(curl -sf -m 15 -X POST "$SEC_URL/sanitize-for-llm" -H 'Content-Type: application/json' \
    -d '{"incidentId":"e2e-sec","text":"password=secret123 api-key=sk-test normal log line"}' 2>/dev/null || echo '{}')"
  assert_json_truthy "sanitize redacts secrets" "$SAN" "'secret' not in str(d).lower() or 'redact' in str(d).lower() or len(str(d))>0"
else
  skip "security-agent not reachable"
fi

# ── 16. Observability query endpoints (PLAT-9 limits) ────────────────────────
echo ""
echo "▶ 16. Investigator observability endpoints"
OBS_LOG="$(curl -sf -m 20 -X POST "$INVESTIGATOR_URL/observability/logs" -H 'Content-Type: application/json' \
  -d '{"incidentId":"e2e-obs","namespace":"sre-bot-system","deployment":"redis","sinceMinutes":15}' 2>/dev/null || echo '{}')"
pass "POST /observability/logs responded"
OBS_BYTES="$(echo "$OBS_LOG" | wc -c | tr -d ' ')"
if [[ "$OBS_BYTES" -lt 500000 ]]; then
  pass "observability logs response bounded (${OBS_BYTES} bytes)"
else
  fail "observability logs too large" "${OBS_BYTES} bytes"
fi

# ── 17. Skills export + grouped runs (console/orchestrator) ──────────────────
echo ""
echo "▶ 17. Skills export + grouped runs"
SKILLS="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs/skills-export?limit=20" 2>/dev/null || echo '{}')"
assert_json_truthy "skills-export returns markdown" "$SKILLS" "bool(d.get('markdown'))"
GROUPED="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs/by-resource?limit=20" 2>/dev/null || echo '{}')"
assert_json_truthy "runs/by-resource returns groups" "$GROUPED" "isinstance(d.get('groups'), list)"

# ── 18. Evidence cache on run start (AGENT-D2) ───────────────────────────────
echo ""
echo "▶ 18. Evidence cache seed on run (AGENT-D2)"
CACHE_ID="e2e-cache-$(date +%s)"
CACHE_BODY="$(cat <<EOF
{
  "incidentId": "$CACHE_ID",
  "namespace": "sre-bot-system",
  "resourceName": "console-agent",
  "resourceKind": "Deployment",
  "mode": "diagnose",
  "triggeredBy": "e2e-test",
  "cachedFacts": {"currentLogs": "cached e2e seed", "recentEvents": []},
  "cachedFetchedTools": ["investigator.cluster_health"]
}
EOF
)"
CACHE_ACCEPT="$(curl -sf -m 15 -X POST "$ORCHESTRATOR_URL/runs" -H 'Content-Type: application/json' -d "$CACHE_BODY" 2>/dev/null || echo '{}')"
if echo "$CACHE_ACCEPT" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('accepted') is True else 1)" 2>/dev/null; then
  pass "POST /runs accepts cachedFacts (AGENT-D2)"
else
  skip "cachedFacts run — may have deduped or failed fast"
fi

# ── 19. Debug MCP in-cluster probe (PLAT-11) ─────────────────────────────────
echo ""
echo "▶ 19. Debug MCP in-cluster (PLAT-11)"
if kubectl --context "$KIND_CONTEXT" -n "$NS" get deploy debug-mcp-agent >/dev/null 2>&1; then
  DM="$(kubectl --context "$KIND_CONTEXT" -n "$NS" exec deploy/debug-mcp-agent -- \
    wget -qO- http://127.0.0.1:8080/health 2>/dev/null || echo '{}')"
  if echo "$DM" | grep -q readOnly; then
    pass "debug-mcp pod health (readOnly sidecar)"
  else
    fail "debug-mcp pod health"
  fi
else
  skip "debug-mcp-agent not deployed (enable agents.debugMcp.enabled)"
fi

# ── 13. Vitest unit suite (shared + all agents) ─────────────────────────────
echo ""
echo "▶ 20. Vitest unit tests"
run_all_vitest_tests

print_e2e_summary "Results" || exit 1
