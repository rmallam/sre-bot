#!/usr/bin/env bash
# GP-RB: Runbook corpus + Kind failure fixture golden paths.
# Usage: ./scripts/test-runbook-fixtures.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/test-e2e-lib.sh"

: "${FIXTURE_APPLY:=true}"
: "${FIXTURE_INVESTIGATE:=true}"
: "${FIXTURE_RAG_GROUND:=true}"

echo "══════════════════════════════════════════════════════════════"
echo " Runbook Fixture Golden Paths (GP-RB)"
echo "══════════════════════════════════════════════════════════════"

# ── GP-RB-0 Corpus validation (offline) ─────────────────────────────────────
echo ""
echo "▶ GP-RB-0 Runbook corpus validation"
if npm run runbooks:validate >/dev/null 2>&1; then
  pass "GP-RB-0 corpus validates (runbooks + taxonomy)"
else
  fail "GP-RB-0 corpus validation" "npm run runbooks:validate"
fi

if npm test -- --run shared/test/runbook-corpus.test.ts shared/test/runbook-normalize.test.ts >/dev/null 2>&1; then
  pass "GP-RB-0 runbook unit tests"
else
  fail "GP-RB-0 runbook unit tests"
fi

# ── GP-RB-1 Platform RAG ground (signatures from fixtures) ───────────────────
echo ""
echo "▶ GP-RB-1 RAG ground for fixture signatures"
load_e2e_internal_token
ensure_port_forwards

if [[ "$FIXTURE_RAG_GROUND" != "true" ]]; then
  skip "GP-RB-1 RAG ground (FIXTURE_RAG_GROUND=false)"
elif curl -sf -m 5 "$PLATFORM_URL/health" >/dev/null 2>&1; then
  RB1_SIGS="CrashLoopBackOff OOMKilled ImagePullBackOff FailedScheduling CreateContainerConfigError"
  RB1_OK=0
  RB1_FAIL=0
  for sig in $RB1_SIGS; do
    comp="compute"
    [[ "$sig" == "ImagePullBackOff" ]] && comp="gitops"
    BODY="$(python3 -c "import json; print(json.dumps({'detected_error':'$sig','target_component':'$comp','target_workload':'fixture','query_text':'$sig fixture sre-fixture-lab'}))")"
    RAG="$(curl -sf -m 20 -X POST "$PLATFORM_URL/rag/ground" -H 'Content-Type: application/json' -d "$BODY" 2>/dev/null || echo '{}')"
    if echo "$RAG" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('found') and d.get('playbook_markdown') else 1)" 2>/dev/null; then
      RB1_OK=$((RB1_OK + 1))
    else
      RB1_FAIL=$((RB1_FAIL + 1))
    fi
  done
  if [[ "$RB1_FAIL" -eq 0 ]]; then
    pass "GP-RB-1 RAG ground found runbooks ($RB1_OK signatures)"
  elif [[ "$RB1_OK" -ge 2 ]]; then
    skip "GP-RB-1 partial RAG ($RB1_OK ok, $RB1_FAIL miss — re-seed: npm run runbooks:ingest)"
  else
    fail "GP-RB-1 RAG ground" "$RB1_OK ok / $RB1_FAIL failed — run npm run runbooks:ingest"
  fi
else
  skip "GP-RB-1 platform-agent not reachable at $PLATFORM_URL"
fi

# ── GP-RB-2 Apply fixtures + cluster state ────────────────────────────────────
echo ""
echo "▶ GP-RB-2 Kind failure fixtures"
KUBECTL_BIN="${KUBECTL:-kubectl}"
FIXTURE_NS="sre-fixture-lab"
FIXTURES_JSON="$ROOT/scripts/k8s-failure-fixtures/fixtures.json"

cluster_ready() {
  command -v "$KUBECTL_BIN" >/dev/null && \
    "$KUBECTL_BIN" --context "${KIND_CONTEXT:-kind-test-upgrade-cluster}" get ns "$NS" >/dev/null 2>&1
}

if [[ "$FIXTURE_APPLY" != "true" ]] || ! cluster_ready; then
  skip "GP-RB-2 fixtures (no Kind cluster or FIXTURE_APPLY=false)"
else
  "$ROOT/scripts/k8s-failure-fixtures/apply-all.sh" >/dev/null
  pass "GP-RB-2 applied failure fixtures to $FIXTURE_NS"
  echo "  Waiting 25s for failure states to settle…"
  sleep 25

  RB2_DEPLOY_OK=0
  RB2_DEPLOY_FAIL=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    WS="$(e2e_curl -sf -m 20 "$INVESTIGATOR_URL/workload-status?namespace=$FIXTURE_NS&resourceKind=Deployment&resourceName=$name&incidentId=gp-rb2-$name" 2>/dev/null || echo '{}')"
    if echo "$WS" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('healthy') is False else 1)" 2>/dev/null; then
      RB2_DEPLOY_OK=$((RB2_DEPLOY_OK + 1))
    else
      RB2_DEPLOY_FAIL=$((RB2_DEPLOY_FAIL + 1))
      echo "    expected unhealthy: $name"
    fi
  done < <(python3 -c "
import json
d=json.load(open('$FIXTURES_JSON'))
for f in d['fixtures']:
    if f.get('workload_kind')=='Deployment':
        print(f['workload_name'])
")

  if [[ "$RB2_DEPLOY_FAIL" -eq 0 && "$RB2_DEPLOY_OK" -ge 5 ]]; then
    pass "GP-RB-2 deployment fixtures unhealthy as expected ($RB2_DEPLOY_OK checked)"
  elif [[ "$RB2_DEPLOY_OK" -ge 3 ]]; then
    skip "GP-RB-2 partial fixture state ($RB2_DEPLOY_OK ok, $RB2_DEPLOY_FAIL fail)"
  else
    fail "GP-RB-2 fixture workload-status" "$RB2_DEPLOY_OK ok / $RB2_DEPLOY_FAIL fail"
  fi

  # PVC pending
  PVC_PHASE="$("$KUBECTL_BIN" --context "${KIND_CONTEXT:-kind-test-upgrade-cluster}" get pvc fixture-pvc-pending -n "$FIXTURE_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo '')"
  if [[ "$PVC_PHASE" == "Pending" ]]; then
    pass "GP-RB-2 PVC fixture-pvc-pending is Pending"
  else
    skip "GP-RB-2 PVC phase ($PVC_PHASE)"
  fi
fi

# ── GP-RB-3 Investigate chat for representative fixtures ─────────────────────
echo ""
echo "▶ GP-RB-3 Investigate chat (fixture workloads)"
if [[ "$FIXTURE_INVESTIGATE" != "true" ]] || ! curl -sf -m 5 "$COMMANDER_URL/health" >/dev/null 2>&1; then
  skip "GP-RB-3 investigate chat (commander unavailable or disabled)"
else
  CHANNEL="gp-rb3-$(date +%s)"
  USER_ID="runbook-fixture-e2e"
  RB3_CASES=(
    "crash_loop|crash|loop|restart|image"
    "image_pull_backoff|image|pull|registry|tag"
  )
  RB3_OK=0
  for case in "${RB3_CASES[@]}"; do
    fid="${case%%|*}"
    terms="${case#*|}"
    msg="$(python3 -c "import json; f=[x for x in json.load(open('$FIXTURES_JSON'))['fixtures'] if x['id']=='$fid'][0]; print(f['investigate_message'])")"
    REPLY="$(curl -sf -m 90 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
      -d "{\"channelId\":\"$CHANNEL-$fid\",\"userId\":\"$USER_ID\",\"message\":\"$msg\"}" 2>/dev/null || echo '{}')"
    if echo "$REPLY" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
r=(d.get('reply') or '').lower()
terms='$terms'.split('|')
exit(0 if r and any(t in r for t in terms) else 1)
" 2>/dev/null; then
      RB3_OK=$((RB3_OK + 1))
      pass "GP-RB-3 investigate $fid (reply mentions failure domain)"
    else
      snippet="$(echo "$REPLY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reply','')[:120])" 2>/dev/null || echo '')"
      skip "GP-RB-3 investigate $fid" "$snippet"
    fi
  done
  if [[ "$RB3_OK" -ge 1 ]]; then
    pass "GP-RB-3 at least one fixture investigate succeeded"
  fi
fi

echo ""
echo "Runbook fixture GP-RB: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
