# Shared helpers for E2E / functional test scripts.
# shellcheck shell=bash
[[ -n "${TEST_E2E_LIB_LOADED:-}" ]] && return 0
TEST_E2E_LIB_LOADED=1

if [[ -z "${ROOT:-}" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ── Defaults (Kind port-forwards 908x) ───────────────────────────────────────
: "${KIND_CONTEXT:=kind-test-upgrade-cluster}"
: "${NS:=sre-bot-system}"
: "${E2E_NS:=sre-bot-e2e}"
: "${AUTO_PORT_FORWARD:=true}"

: "${COMMANDER_URL:=http://localhost:9081}"
: "${INVESTIGATOR_URL:=http://localhost:9082}"
: "${BRAIN_URL:=http://localhost:9083}"
: "${ORCHESTRATOR_URL:=http://localhost:9084}"
: "${HIL_URL:=http://localhost:9085}"
: "${GITOPS_URL:=http://localhost:9086}"
: "${EXECUTOR_URL:=http://localhost:9087}"
: "${SECURITY_URL:=http://localhost:9088}"
: "${CICD_URL:=http://localhost:9089}"
: "${PLATFORM_URL:=http://localhost:9090}"
: "${CONSOLE_URL:=http://localhost:9091}"
: "${CODING_AGENT_URL:=http://localhost:9092}"
: "${DEBUG_MCP_URL:=http://localhost:9093}"

: "${WORKFLOW_RUN_TIMEOUT_SEC:=120}"
: "${GOLDEN_FULL_TIMEOUT_SEC:=240}"
: "${E2E_ENABLE_LIVE_DEPLOY:=false}"
: "${E2E_DEPLOY_GIT_REPO:=github.com/rmallam/sre-bot}"

if [[ -f "$ROOT/scripts/test-e2e.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/test-e2e.env"
fi

PASS=0
FAIL=0
SKIP=0
PF_PIDS=()

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "    $2"; }
skip() { SKIP=$((SKIP + 1)); echo "  ○ $1 (skipped)"; }

load_e2e_internal_token() {
  [[ -n "${SRE_INTERNAL_TOKEN:-}" ]] && return 0
  command -v kubectl >/dev/null || return 0
  local kctl="${KUBECTL:-kubectl}"
  local ctx=()
  [[ -n "${KIND_CONTEXT:-}" ]] && ctx=(--context "$KIND_CONTEXT")
  [[ -n "${KUBECONFIG:-}" ]] && kctl="${KUBECTL:-/opt/homebrew/bin/kubectl}"
  $kctl "${ctx[@]}" get ns "$NS" >/dev/null 2>&1 || return 0
  SRE_INTERNAL_TOKEN="$(
    $kctl "${ctx[@]}" -n "$NS" get secret sre-bot-secrets \
      -o jsonpath='{.data.sre_internal_token}' 2>/dev/null | base64 -d 2>/dev/null || true
  )"
  export SRE_INTERNAL_TOKEN
}

# curl wrapper — adds Bearer token for inter-agent APIs when SRE_AUTH_STRICT=true.
e2e_curl() {
  if [[ -n "${SRE_INTERNAL_TOKEN:-}" ]]; then
    curl -H "Authorization: Bearer ${SRE_INTERNAL_TOKEN}" "$@"
  else
    curl "$@"
  fi
}

assert_json_field() {
  local name="$1" json="$2" py_expr="$3" expected="$4"
  local val
  val="$(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); v=$py_expr; print(v)" 2>/dev/null)" || { fail "$name" "parse error"; return 1; }
  if [[ "$val" == "$expected" ]]; then pass "$name (= $expected)"; else fail "$name" "expected '$expected', got '$val'"; fi
}

assert_json_truthy() {
  local name="$1" json="$2" py_expr="$3"
  local val
  val="$(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); v=$py_expr; print('true' if v else 'false')" 2>/dev/null)" || { fail "$name" "parse error"; return 1; }
  if [[ "$val" == "true" ]]; then pass "$name"; else fail "$name" "expected truthy, got '$val'"; fi
}

e2e_cleanup() {
  local pid
  for pid in ${PF_PIDS[@]+"${PF_PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
}

start_port_forward() {
  local svc="$1" local_port="$2"
  if curl -sf -m 2 "http://localhost:${local_port}/health" >/dev/null 2>&1; then
    return 0
  fi
  command -v kubectl >/dev/null || return 1
  kubectl --context "$KIND_CONTEXT" -n "$NS" port-forward "svc/$svc" "${local_port}:8080" >/dev/null 2>&1 &
  PF_PIDS+=("$!")
}

ensure_port_forwards() {
  [[ "$AUTO_PORT_FORWARD" == "true" ]] || return 0
  command -v kubectl >/dev/null || return 0
  kubectl --context "$KIND_CONTEXT" get ns "$NS" >/dev/null 2>&1 || return 0
  load_e2e_internal_token
  start_port_forward commander-agent 9081
  start_port_forward investigator-agent 9082
  start_port_forward brain-agent 9083
  start_port_forward orchestrator-agent 9084
  start_port_forward hil-agent 9085
  start_port_forward gitops-agent 9086
  start_port_forward executor-agent 9087
  start_port_forward security-agent 9088
  start_port_forward cicd-agent 9089
  start_port_forward platform-agent 9090
  start_port_forward console-agent 9091
  start_port_forward coding-agent 9092
  sleep 3
}

run_unit_test() {
  local rel="$1"
  if (cd "$ROOT" && npx vitest run "$rel" >/dev/null 2>&1); then
    pass "unit: $(basename "$rel")"
  else
    fail "unit: $(basename "$rel")"
  fi
}

run_unit_tests() {
  local t
  for t in "$@"; do run_unit_test "$t"; done
}

# Run the full Vitest suite (shared + all agents).
run_all_vitest_tests() {
  echo "  Running full vitest suite (shared + agents)…"
  if (cd "$ROOT" && npm test >/dev/null 2>&1); then
    pass "vitest: all unit tests"
  else
    fail "vitest: all unit tests" "npm test — run locally for details"
    return 1
  fi
}

poll_run_by_incident() {
  local incident_id="$1" max_sec="${2:-$WORKFLOW_RUN_TIMEOUT_SEC}"
  local elapsed=0 runs='{}'
  while [[ "$elapsed" -lt "$max_sec" ]]; do
    runs="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs?incidentId=$incident_id&limit=3" 2>/dev/null || echo '{}')"
    if echo "$runs" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('runs') else 1)" 2>/dev/null; then
      echo "$runs"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "$runs"
  return 1
}

poll_run_status() {
  local run_id="$1" max_sec="${2:-$WORKFLOW_RUN_TIMEOUT_SEC}"
  local elapsed=0 status="running"
  while [[ "$elapsed" -lt "$max_sec" ]]; do
    status="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$run_id" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo '')"
    if [[ -n "$status" && "$status" != "running" ]]; then
      echo "$status"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "${status:-timeout}"
  return 1
}

poll_run_terminal_by_incident() {
  local incident_id="$1" max_sec="${2:-$GOLDEN_FULL_TIMEOUT_SEC}"
  local elapsed=0 runs='{}' run_id="" status="running"
  while [[ "$elapsed" -lt "$max_sec" ]]; do
    runs="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs?incidentId=$incident_id&limit=3" 2>/dev/null || echo '{}')"
    run_id="$(echo "$runs" | python3 -c "import json,sys; r=json.load(sys.stdin).get('runs',[]); print(r[0]['runId'] if r else '')" 2>/dev/null || echo '')"
    if [[ -n "$run_id" ]]; then
      status="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$run_id" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo '')"
      if [[ -n "$status" && "$status" != "running" ]]; then
        echo "$status|$run_id"
        return 0
      fi
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "${status:-timeout}|${run_id}"
  return 1
}

kubectl_deployment_ready() {
  local namespace="$1" name="$2" timeout_sec="${3:-120}"
  command -v kubectl >/dev/null || return 1
  kubectl --context "$KIND_CONTEXT" -n "$namespace" wait --for=condition=available "deployment/$name" --timeout="${timeout_sec}s" >/dev/null 2>&1
}

kubectl_deployment_image() {
  local namespace="$1" name="$2"
  command -v kubectl >/dev/null || return 1
  kubectl --context "$KIND_CONTEXT" -n "$namespace" get deploy "$name" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true
}

run_has_break_glass() {
  local run_id="$1"
  e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$run_id" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); m=d.get('metadata') or {}; exit(0 if m.get('breakGlassPlan') else 1)" 2>/dev/null
}

poll_run_awaiting_human_by_incident() {
  local incident_id="$1" max_sec="${2:-$GOLDEN_FULL_TIMEOUT_SEC}"
  local elapsed=0 runs='{}' run_id="" status=""
  while [[ "$elapsed" -lt "$max_sec" ]]; do
    runs="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs?incidentId=$incident_id&limit=3" 2>/dev/null || echo '{}')"
    run_id="$(echo "$runs" | python3 -c "import json,sys; r=json.load(sys.stdin).get('runs',[]); print(r[0]['runId'] if r else '')" 2>/dev/null || echo '')"
    if [[ -n "$run_id" ]]; then
      status="$(e2e_curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$run_id" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo '')"
      if [[ "$status" == "awaiting_human" ]]; then
        echo "$status|$run_id"
        return 0
      fi
      if [[ -n "$status" && "$status" != "running" ]]; then
        echo "$status|$run_id"
        return 0
      fi
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "${status:-timeout}|${run_id}"
  return 1
}

hil_approve_incident() {
  local incident_id="$1" user_id="${2:-golden-e2e}"
  e2e_curl -sf -m 60 -X POST "$HIL_URL/api/approve/$incident_id" \
    -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$user_id\",\"platform\":\"web\"}" 2>/dev/null || echo '{}'
}

console_approve_incident() {
  local incident_id="$1"
  curl -sf -m 60 -X POST "$CONSOLE_URL/api/approvals/$incident_id/approve" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || echo '{}'
}

wait_hil_pending() {
  local incident_id="$1" max_sec="${2:-30}"
  local elapsed=0
  while [[ "$elapsed" -lt "$max_sec" ]]; do
    if INCIDENT_ID="$incident_id" e2e_curl -sf -m 10 "$HIL_URL/api/approvals" 2>/dev/null \
      | python3 -c "import json,sys,os; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('approvals',[]); iid=os.environ['INCIDENT_ID']; exit(0 if any(a.get('incidentId')==iid for a in items) else 1)" 2>/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

e2e_fixtures_enabled() {
  e2e_curl -sf -m 10 "$ORCHESTRATOR_URL/health" 2>/dev/null \
    | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('e2eFixturesEnabled') else 1)" 2>/dev/null
}

e2e_seed_awaiting_hil() {
  local incident_id="${1:-}"
  local body='{}'
  if [[ -n "$incident_id" ]]; then
    body="$(INCIDENT_ID="$incident_id" python3 -c 'import json,os; print(json.dumps({"incidentId": os.environ["INCIDENT_ID"]}))')"
  fi
  e2e_curl -sf -m 30 -X POST "$ORCHESTRATOR_URL/e2e/seed-awaiting-hil" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null || echo '{}'
}

e2e_seed_break_glass() {
  local incident_id="${1:-}"
  local body='{}'
  if [[ -n "$incident_id" ]]; then
    body="$(INCIDENT_ID="$incident_id" python3 -c 'import json,os; print(json.dumps({"incidentId": os.environ["INCIDENT_ID"]}))')"
  fi
  e2e_curl -sf -m 30 -X POST "$ORCHESTRATOR_URL/e2e/seed-break-glass" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null || echo '{}'
}

e2e_seed_chat_ui() {
  local channel_id="$1" variant="${2:-hil_required}"
  CHANNEL_ID="$channel_id" VARIANT="$variant" e2e_curl -sf -m 45 -X POST "$ORCHESTRATOR_URL/e2e/seed-chat-ui" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,os; print(json.dumps({"channelId": os.environ["CHANNEL_ID"], "variant": os.environ["VARIANT"]}))')" \
    2>/dev/null || echo '{}'
}

kubectl_clusterrole_exists() {
  local name="$1"
  command -v kubectl >/dev/null || return 1
  kubectl --context "$KIND_CONTEXT" get clusterrole "$name" >/dev/null 2>&1
}

kubectl_delete_clusterrole() {
  local name="$1"
  command -v kubectl >/dev/null || return 0
  kubectl --context "$KIND_CONTEXT" delete clusterrole "$name" --ignore-not-found >/dev/null 2>&1 || true
}

approve_via_console_or_hil() {
  local incident_id="$1" user_id="${2:-golden-e2e}"
  if wait_hil_pending "$incident_id" 30; then
    local console_res
    console_res="$(console_approve_incident "$incident_id")"
    if echo "$console_res" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('status') in ('approved','accepted','DONE','done','ok','already_handled') or d.get('ok') else 1)" 2>/dev/null; then
      echo "console"
      return 0
    fi
  fi
  hil_approve_incident "$incident_id" "$user_id" >/dev/null 2>&1 || true
  echo "hil"
}

console_approve_ok() {
  local json="$1"
  echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('status') in ('approved','accepted','DONE','done','ok','already_handled') or d.get('ok') else 1)" 2>/dev/null
}

commander_chat() {
  local channel_id="$1" user_id="$2" message="$3"
  local body
  body="$(CHANNEL_ID="$channel_id" USER_ID="$user_id" MESSAGE="$message" python3 -c '
import json, os
print(json.dumps({
  "channelId": os.environ["CHANNEL_ID"],
  "userId": os.environ["USER_ID"],
  "message": os.environ["MESSAGE"],
}))
')"
  curl -sf -m 120 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' -d "$body" 2>/dev/null || echo '{}'
}

setup_e2e_namespace() {
  command -v kubectl >/dev/null || return 1
  kubectl --context "$KIND_CONTEXT" create namespace "$E2E_NS" --dry-run=client -o yaml \
    | kubectl --context "$KIND_CONTEXT" apply -f - >/dev/null
  if ! kubectl --context "$KIND_CONTEXT" -n "$E2E_NS" get deploy e2e-httpd >/dev/null 2>&1; then
    kubectl --context "$KIND_CONTEXT" -n "$E2E_NS" create deployment e2e-httpd \
      --image=httpd:2.4-alpine --replicas=1 --port=80 \
      --dry-run=client -o yaml | kubectl --context "$KIND_CONTEXT" apply -f - >/dev/null
  fi
  kubectl --context "$KIND_CONTEXT" -n "$E2E_NS" wait --for=condition=available deployment/e2e-httpd --timeout=120s >/dev/null 2>&1
}

print_e2e_summary() {
  local title="${1:-Results}"
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo " $title: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
  echo "══════════════════════════════════════════════════════════════"
  [[ "$FAIL" -eq 0 ]]
}
