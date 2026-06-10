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
: "${E2E_ENABLE_LIVE_DEPLOY:=false}"
: "${E2E_ENABLE_GITHUB_CI:=false}"

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
    runs="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs?incidentId=$incident_id&limit=3" 2>/dev/null || echo '{}')"
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
    status="$(curl -sf -m 15 "$ORCHESTRATOR_URL/runs/$run_id" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo '')"
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
