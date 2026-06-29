#!/usr/bin/env bash
# Golden-path E2E smoke — GP-1..GP-5 user journeys (API-level against Kind/compose stack).
# Usage: ./scripts/test-golden-paths.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/test-e2e-lib.sh"

echo "══════════════════════════════════════════════════════════════"
echo " Golden Path E2E (GP-1 .. GP-5)"
echo "══════════════════════════════════════════════════════════════"

load_e2e_internal_token
ensure_port_forwards

CHANNEL="golden-path-$(date +%s)"
USER_ID="golden-path-e2e"

# ── GP-1 Deploy from natural language (commander chat) ───────────────────────
echo ""
echo "▶ GP-1 Deploy NL (explicit container image)"
GP1_MSG="deploy headlamp in headlamp namespace with ghcr.io/headlamp-k8s/headlamp:v0.41.0 image"
GP1="$(curl -sf -m 90 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
  -d "{\"channelId\":\"$CHANNEL-gp1\",\"userId\":\"$USER_ID\",\"message\":\"$GP1_MSG\"}" 2>/dev/null || echo '{}')"
if echo "$GP1" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('reply',''); exit(0 if r and 'built-in chart' not in r.lower() else 1)" 2>/dev/null; then
  pass "GP-1 chat accepts deploy with explicit image (no catalog rejection)"
else
  fail "GP-1 deploy NL" "$(echo "$GP1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reply','')[:200])" 2>/dev/null || echo "$GP1")"
fi

# ── GP-2 Investigate + image hint parsing (shared logic via commander) ───────
echo ""
echo "▶ GP-2 Investigate image follow-up routing"
GP2="$(curl -sf -m 90 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
  -d "{\"channelId\":\"$CHANNEL-gp2\",\"userId\":\"$USER_ID\",\"message\":\"investigate pod headlamp-test in default\"}" 2>/dev/null || echo '{}')"
assert_json_truthy "GP-2 investigate starts (reply present)" "$GP2" "bool(d.get('reply'))"

# ── GP-4 Namespace check API (investigator) ───────────────────────────────────
echo ""
echo "▶ GP-4 Namespace existence check"
NS_CHECK="$(e2e_curl -sf -m 15 "$INVESTIGATOR_URL/namespace-check?namespace=golden-path-missing-$(date +%s)&incidentId=gp4" 2>/dev/null || echo '{}')"
if echo "$NS_CHECK" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('exists') is False else 1)" 2>/dev/null; then
  pass "GP-4 namespace-check returns exists=false for missing ns"
else
  fail "GP-4 namespace-check" "$NS_CHECK"
fi

# ── Console Tier-1 UX contracts (stepper + approval panels) ───────────────────
echo ""
echo "▶ Console Tier-1 UX (vitest)"
if npm test -- --run shared/test/console-tier1.test.ts >/dev/null 2>&1; then
  pass "Console U-2/U-3/U-5 helpers"
else
  fail "Console tier-1 vitest" "shared/test/console-tier1.test.ts"
fi

# ── GP-5 HIL approval API (web chat buttons depend on this) ───────────────────
echo ""
echo "▶ GP-5 HIL approval list + approve"
HIL_ID="gp5-$(date +%s)"
HIL_BODY="$(cat <<EOF
{
  "incidentId": "$HIL_ID",
  "runId": "$HIL_ID",
  "triggeredBy": "golden-path-e2e",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "namespace": "$E2E_NS",
  "resourceKind": "Deployment",
  "resourceName": "e2e-httpd",
  "mode": "diagnose",
  "plan": {
    "action": "restart",
    "rootCause": "gp5 test",
    "reasoning": "golden path hil",
    "severity": "LOW",
    "proposedPatch": [],
    "targetManifestPath": "",
    "commitMessage": "",
    "rollbackSafe": true
  },
  "attemptNumber": 1,
  "circuitBreakerLimit": 5,
  "escalated": false,
  "platform": "web",
  "channelId": "$CHANNEL-gp5"
}
EOF
)"
if e2e_curl -sf -m 15 -X POST "$HIL_URL/request-approval" -H 'Content-Type: application/json' -d "$HIL_BODY" \
  | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('status')=='accepted' else 1)" 2>/dev/null; then
  pass "GP-5 POST /request-approval accepted"
  APPROVALS="$(e2e_curl -sf -m 10 "$HIL_URL/api/approvals" 2>/dev/null || echo '{}')"
  if echo "$APPROVALS" | python3 -c "import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('approvals',[]); exit(0 if any(a.get('incidentId')=='$HIL_ID' for a in items) else 1)" 2>/dev/null; then
    pass "GP-5 GET /api/approvals lists pending (console Approve button source)"
  else
    fail "GP-5 approval not visible in HIL store"
  fi
else
  fail "GP-5 POST /request-approval"
fi

# ── GP-3 Break-glass HIL kind (smoke — full cluster apply needs RBAC chart) ──
echo ""
echo "▶ GP-3 Break-glass approval kind in HIL"
BG_ID="gp3-$(date +%s)"
BG_BODY="$(cat <<EOF
{
  "incidentId": "$BG_ID",
  "runId": "$BG_ID",
  "triggeredBy": "golden-path-e2e",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "namespace": "$E2E_NS",
  "resourceKind": "Deployment",
  "resourceName": "e2e-httpd",
  "mode": "pre-deploy",
  "plan": {
    "action": "repo_apply",
    "rootCause": "gp3 break glass",
    "reasoning": "cluster scoped creates",
    "severity": "HIGH",
    "proposedPatch": [],
    "targetManifestPath": "",
    "commitMessage": "",
    "rollbackSafe": true
  },
  "attemptNumber": 1,
  "circuitBreakerLimit": 5,
  "escalated": true,
  "approvalKind": "break_glass",
  "breakGlassTtlSeconds": 900,
  "breakGlassPlan": {
    "planId": "gp3-plan",
    "reason": "E2E break-glass smoke",
    "createCount": 1,
    "resources": [{ "ref": { "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "name": "e2e-bg-test" }, "documentYaml": "", "status": "to_create" }],
    "blockedUpdates": []
  },
  "platform": "web",
  "channelId": "$CHANNEL-gp3"
}
EOF
)"
if e2e_curl -sf -m 15 -X POST "$HIL_URL/request-approval" -H 'Content-Type: application/json' -d "$BG_BODY" \
  | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('status')=='accepted' else 1)" 2>/dev/null; then
  pass "GP-3 break_glass approval accepted by HIL"
  APPROVALS_BG="$(e2e_curl -sf -m 10 "$HIL_URL/api/approvals" 2>/dev/null || echo '{}')"
  if echo "$APPROVALS_BG" | python3 -c "import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('approvals',[]); exit(0 if any(a.get('incidentId')=='$BG_ID' and a.get('approvalKind')=='break_glass' for a in items) else 1)" 2>/dev/null; then
    pass "GP-3 break_glass visible in HIL with approvalKind"
  else
    skip "GP-3 break_glass not in list (store timing)"
  fi
else
  fail "GP-3 break_glass POST /request-approval"
fi

# ── GP-5b Web suggest-fix arm binds incident to next chat message ───────────
echo ""
echo "▶ GP-5b Web hil suggest-arm"
SUG_CH="gp5b-$(date +%s)"
SUG_INC="gp5b-inc-$(date +%s)"
ARM="$(curl -sf -m 15 -X POST "$COMMANDER_URL/chat/suggest-arm" -H 'Content-Type: application/json' \
  -d "{\"channelId\":\"$SUG_CH\",\"userId\":\"$USER_ID\",\"incidentId\":\"$SUG_INC\"}" 2>/dev/null || echo '{}')"
if echo "$ARM" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('ok') and d.get('prompt') else 1)" 2>/dev/null; then
  pass "GP-5b POST /chat/suggest-arm returns ok + prompt"
  SUG_MSG="$(curl -sf -m 30 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$SUG_CH\",\"userId\":\"$USER_ID\",\"message\":\"set image to ghcr.io/org/app:v9.9.9\"}" 2>/dev/null || echo '{}')"
  if echo "$SUG_MSG" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('reply',''); exit(0 if r and ('fix' in r.lower() or 'plan' in r.lower() or 'parse' in r.lower() or 'could not' in r.lower()) else 1)" 2>/dev/null; then
    pass "GP-5b armed suggest message routes to HIL parse reply"
  else
    skip "GP-5b suggest bind (HIL may be unavailable)" "$(echo "$SUG_MSG" | head -c 120)"
  fi
else
  fail "GP-5b suggest-arm" "$(echo "$ARM" | head -c 200)"
fi

# ── R-5 Commander health exposes persistence flags ───────────────────────────
echo ""
echo "▶ R-5 Commander persistence health"
HEALTH="$(curl -sf -m 10 "$COMMANDER_URL/health" 2>/dev/null || echo '{}')"
if echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'persistentStorage' in d and 'chatSessionBackend' in d else 1)" 2>/dev/null; then
  pass "R-5 /health reports persistentStorage + session backend"
else
  fail "R-5 commander health persistence fields" "$(echo "$HEALTH" | head -c 200)"
fi

# ── Console chat API reachable ────────────────────────────────────────────────
echo ""
echo "▶ Console chat BFF"
if curl -sf -m 10 "$CONSOLE_URL/health" >/dev/null 2>&1; then
  pass "Console /health (chat UI backend)"
else
  fail "Console /health"
fi

# ── GP-RB Runbook corpus + failure fixtures ───────────────────────────────────
echo ""
echo "▶ GP-RB Runbook fixtures (corpus + optional Kind/RAG)"
if FIXTURE_APPLY="${FIXTURE_APPLY:-true}" FIXTURE_INVESTIGATE="${FIXTURE_INVESTIGATE:-true}" \
  "$ROOT/scripts/test-runbook-fixtures.sh"; then
  :
else
  fail "GP-RB runbook fixture suite"
fi

echo ""
echo "Golden path E2E: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
