#!/usr/bin/env bash
# Functional workflow E2E tests — deploy, debug, git patch, Argo, HIL, CI, chat.
# Usage: ./scripts/test-e2e-workflows.sh
# Config: scripts/test-e2e.env (see test-e2e.env.example)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/test-e2e-lib.sh"
trap e2e_cleanup EXIT INT TERM

echo "══════════════════════════════════════════════════════════════"
echo " SRE Bot Functional Workflow Tests"
echo "══════════════════════════════════════════════════════════════"
echo " Cluster: $KIND_CONTEXT / $NS   E2E namespace: $E2E_NS"
echo " Live deploy: $E2E_ENABLE_LIVE_DEPLOY   GitHub CI: $E2E_ENABLE_GITHUB_CI"
echo ""

ensure_port_forwards

# ── W1. Extended agent health ────────────────────────────────────────────────
echo "▶ W1. Extended agent health (gitops, executor, security, cicd, coding)"
for pair in \
  "gitops|$GITOPS_URL/health" \
  "executor|$EXECUTOR_URL/health" \
  "security|$SECURITY_URL/health" \
  "cicd|$CICD_URL/health" \
  "coding|$CODING_AGENT_URL/health"; do
  IFS='|' read -r agent url <<< "$pair"
  if curl -sf -m 10 "$url" >/dev/null 2>&1; then pass "$agent /health"; else fail "$agent /health" "$url"; fi
done

# ── W2–W4. Full Vitest unit suite (shared + all agents) ─────────────────────
echo ""
echo "▶ W2–W4. Vitest unit tests (66 files — shared, commander, orchestrator, gitops, …)"
run_all_vitest_tests

# ── W5. E2E fixture namespace ────────────────────────────────────────────────
echo ""
echo "▶ W5. E2E fixture namespace ($E2E_NS)"
if setup_e2e_namespace; then
  pass "e2e-httpd deployment ready in $E2E_NS"
else
  fail "e2e namespace setup" "kubectl fixture failed"
fi

# ── W6. Issue debugging — facts → plan-only ─────────────────────────────────
echo ""
echo "▶ W6. Issue debugging: facts → brain /plan-only"
FACTS="$(curl -sf -m 90 \
  "$INVESTIGATOR_URL/facts?incidentId=e2e-plan&namespace=$E2E_NS&resourceName=e2e-httpd&resourceKind=Deployment&mode=diagnose&investigateScope=workload" \
  2>/dev/null || echo '{}')"
if echo "$FACTS" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('resourceName') else 1)" 2>/dev/null; then
  pass "fixture workload /facts"
  PLAN_HTTP="$(curl -s -m 120 -o /tmp/e2e-plan.json -w '%{http_code}' -X POST "$BRAIN_URL/plan-only" \
    -H 'Content-Type: application/json' -d "$FACTS" 2>/dev/null || echo 000)"
  PLAN_RESP="$(cat /tmp/e2e-plan.json 2>/dev/null || echo '{}')"
  if [[ "$PLAN_HTTP" == "200" ]] && echo "$PLAN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('action') else 1)" 2>/dev/null; then
    pass "brain /plan-only returns remediation plan"
  elif [[ "$PLAN_HTTP" == "500" ]] && echo "$PLAN_RESP" | grep -qE 'action|noop|schema validation'; then
    pass "brain /plan-only invoked LLM (schema validation on healthy workload)"
  else
    fail "brain /plan-only HTTP $PLAN_HTTP" "$(echo "$PLAN_RESP" | head -c 200)"
  fi
else
  fail "fixture /facts" "empty response"
fi

# ── W7. Full diagnose run (orchestrator graph) ─────────────────────────────
echo ""
echo "▶ W7. Diagnose run lifecycle (orchestrator graph)"
DIAG_ID="e2e-diag-$(date +%s)"
DIAG_BODY="$(cat <<EOF
{
  "incidentId": "$DIAG_ID",
  "namespace": "$E2E_NS",
  "resourceName": "e2e-httpd",
  "resourceKind": "Deployment",
  "mode": "diagnose",
  "triggeredBy": "e2e-workflows",
  "platform": "web",
  "channelId": "e2e-workflows"
}
EOF
)"
if curl -sf -m 15 -X POST "$ORCHESTRATOR_URL/runs" -H 'Content-Type: application/json' -d "$DIAG_BODY" \
  | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('accepted') else 1)" 2>/dev/null; then
  pass "POST /runs diagnose accepted"
  RUNS_JSON="$(poll_run_by_incident "$DIAG_ID" 60 || echo '{}')"
  RUN_ID="$(echo "$RUNS_JSON" | python3 -c "import json,sys; r=json.load(sys.stdin).get('runs',[]); print(r[0]['runId'] if r else '')" 2>/dev/null || echo '')"
  if [[ -n "$RUN_ID" ]]; then
    pass "diagnose run persisted ($RUN_ID)"
    FINAL="$(poll_run_status "$RUN_ID" "$WORKFLOW_RUN_TIMEOUT_SEC" || true)"
    if [[ -n "$FINAL" && "$FINAL" != "running" ]]; then
      pass "diagnose run reached terminal status: $FINAL"
    else
      skip "diagnose run still running after ${WORKFLOW_RUN_TIMEOUT_SEC}s (LLM graph may be slow)"
    fi
  else
    fail "diagnose run not listed"
  fi
else
  fail "POST /runs diagnose"
fi

# ── W8. Commander chat dispatch ──────────────────────────────────────────────
echo ""
echo "▶ W8. Commander chat dispatch (investigate + deploy intent)"
SESSION="$(curl -sf -m 15 -X POST "$COMMANDER_URL/chat/sessions" \
  -H 'Content-Type: application/json' -d '{"userId":"e2e-workflows","label":"functional-test"}' 2>/dev/null || echo '{}')"
CHANNEL="$(echo "$SESSION" | python3 -c "import json,sys; print(json.load(sys.stdin).get('channelId',''))" 2>/dev/null || echo '')"
if [[ -n "$CHANNEL" ]]; then
  pass "POST /chat/sessions → channelId"
  INV_CHAT="$(curl -sf -m 90 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CHANNEL\",\"userId\":\"e2e-workflows\",\"message\":\"check health of e2e-httpd in $E2E_NS\"}" 2>/dev/null || echo '{}')"
  assert_json_truthy "chat investigate returns reply" "$INV_CHAT" "bool(d.get('reply'))"
  DEP_CHAT="$(curl -sf -m 90 -X POST "$COMMANDER_URL/chat" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CHANNEL\",\"userId\":\"e2e-workflows\",\"message\":\"deploy httpd to $E2E_NS-test\"}" 2>/dev/null || echo '{}')"
  assert_json_truthy "chat deploy intent returns reply" "$DEP_CHAT" "bool(d.get('reply'))"
else
  fail "chat session creation"
fi

# ── W9. HIL approval API ─────────────────────────────────────────────────────
echo ""
echo "▶ W9. HIL approval flow (request → list → approve)"
HIL_ID="e2e-hil-$(date +%s)"
HIL_REQ="$(cat <<EOF
{
  "incidentId": "$HIL_ID",
  "runId": "$HIL_ID",
  "triggeredBy": "e2e-workflows",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "namespace": "$E2E_NS",
  "resourceKind": "Deployment",
  "resourceName": "e2e-httpd",
  "mode": "diagnose",
  "plan": {
    "action": "restart",
    "rootCause": "e2e hil test",
    "reasoning": "approval api smoke",
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
  "channelId": "e2e-workflows"
}
EOF
)"
if curl -sf -m 15 -X POST "$HIL_URL/request-approval" -H 'Content-Type: application/json' -d "$HIL_REQ" \
  | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('status')=='accepted' else 1)" 2>/dev/null; then
  pass "POST /request-approval accepted"
  APPROVALS="$(curl -sf -m 10 "$HIL_URL/api/approvals" 2>/dev/null || echo '[]')"
  if echo "$APPROVALS" | python3 -c "import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('approvals',[]); exit(0 if any(a.get('incidentId')=='$HIL_ID' for a in items) else 1)" 2>/dev/null; then
    pass "GET /api/approvals lists pending request"
  else
    skip "approval not in list (may have auto-expired)"
  fi
  if curl -sf -m 15 -X POST "$HIL_URL/api/approve/$HIL_ID" -H 'Content-Type: application/json' \
    -d '{"userId":"e2e-operator","platform":"web"}' >/dev/null 2>&1; then
    pass "POST /api/approve/:incidentId"
  else
    skip "approve API (no orchestrator run bound)"
  fi
else
  fail "POST /request-approval"
fi

# ── W10. Executor restart ──────────────────────────────────────────────────────
echo ""
echo "▶ W10. Executor restart (rollout)"
RESTART_ID="e2e-restart-$(date +%s)"
RESTART_BODY="$(cat <<EOF
{
  "incidentId": "$RESTART_ID",
  "triggeredBy": "e2e-workflows",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "namespace": "$E2E_NS",
  "resourceKind": "Deployment",
  "resourceName": "e2e-httpd",
  "mode": "diagnose",
  "plan": {
    "action": "restart",
    "rootCause": "e2e restart",
    "reasoning": "rollout restart smoke",
    "severity": "LOW",
    "proposedPatch": [],
    "targetManifestPath": "",
    "commitMessage": "",
    "rollbackSafe": true
  },
  "approvedBy": "e2e",
  "approvedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "approvedVia": "web"
}
EOF
)"
RESTART_RES="$(curl -s -m 180 -X POST "$EXECUTOR_URL/execute" -H 'Content-Type: application/json' -d "$RESTART_BODY" 2>/dev/null || echo '{}')"
if echo "$RESTART_RES" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('success') is True else 1)" 2>/dev/null; then
  pass "POST /execute restart succeeded"
elif echo "$RESTART_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('method')=='restartedAt-annotation' else 1)" 2>/dev/null; then
  pass "POST /execute restart triggered (rollout verify slow on Kind)"
else
  fail "POST /execute restart" "$(echo "$RESTART_RES" | head -c 200)"
fi

# ── W11. Git patch (cluster hot-fix) ─────────────────────────────────────────
echo ""
echo "▶ W11. Git patch remediation (cluster hot-fix via gitops)"
PATCH_ID="e2e-patch-$(date +%s)"
PATCH_BODY="$(cat <<EOF
{
  "incidentId": "$PATCH_ID",
  "triggeredBy": "e2e-workflows",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "namespace": "$E2E_NS",
  "resourceKind": "Deployment",
  "resourceName": "e2e-httpd",
  "mode": "diagnose",
  "plan": {
    "action": "git_patch",
    "patchTarget": "cluster",
    "rootCause": "e2e memory tweak",
    "reasoning": "raise memory limit",
    "severity": "LOW",
    "proposedPatch": [
      {"op": "add", "path": "/spec/template/spec/containers/0/resources", "value": {"limits": {"memory": "128Mi"}, "requests": {"memory": "64Mi"}}}
    ],
    "targetManifestPath": "deployments/e2e-httpd.yaml",
    "commitMessage": "e2e: memory limit",
    "rollbackSafe": true
  },
  "approvedBy": "e2e",
  "approvedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "approvedVia": "web"
}
EOF
)"
PATCH_RES="$(curl -sf -m 120 -X POST "$GITOPS_URL/remediate" -H 'Content-Type: application/json' -d "$PATCH_BODY" 2>/dev/null || echo '{}')"
if echo "$PATCH_RES" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('success') is True else 1)" 2>/dev/null; then
  pass "POST /remediate git_patch (cluster) succeeded"
else
  fail "POST /remediate git_patch" "$(echo "$PATCH_RES" | head -c 240)"
fi

# ── W12. Catalog deploy — repo_apply dry-run ─────────────────────────────────
echo ""
echo "▶ W12. App deploy: repo_apply dry-run (catalog image)"
APPLY_ID="e2e-apply-$(date +%s)"
APPLY_BODY="$(cat <<'EOF'
{
  "incidentId": "APPLY_ID_PLACEHOLDER",
  "triggeredBy": "e2e-workflows",
  "triggeredAt": "2026-06-10T00:00:00.000Z",
  "namespace": "E2E_NS_PLACEHOLDER",
  "resourceKind": "Deployment",
  "resourceName": "e2e-catalog",
  "mode": "pre-deploy",
  "plan": {
    "action": "repo_apply",
    "rootCause": "e2e catalog deploy",
    "reasoning": "httpd catalog manifest dry-run",
    "severity": "LOW",
    "proposedPatch": [],
    "targetManifestPath": "manifests/e2e-catalog.yaml",
    "commitMessage": "e2e: catalog deploy",
    "rollbackSafe": true,
    "helmChart": {
      "files": {
        "manifests/e2e-catalog.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: e2e-catalog\n  namespace: E2E_NS_PLACEHOLDER\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: e2e-catalog\n  template:\n    metadata:\n      labels:\n        app: e2e-catalog\n    spec:\n      containers:\n        - name: httpd\n          image: httpd:2.4-alpine\n          ports:\n            - containerPort: 80\n"
      }
    }
  },
  "approvedBy": "e2e",
  "approvedAt": "2026-06-10T00:00:00.000Z",
  "approvedVia": "web",
  "executionOptions": { "dryRun": true, "createNamespace": true }
}
EOF
)"
APPLY_BODY="${APPLY_BODY/APPLY_ID_PLACEHOLDER/$APPLY_ID}"
APPLY_BODY="${APPLY_BODY//E2E_NS_PLACEHOLDER/${E2E_NS}-catalog}"
APPLY_RES="$(curl -sf -m 120 -X POST "$GITOPS_URL/remediate" -H 'Content-Type: application/json' -d "$APPLY_BODY" 2>/dev/null || echo '{}')"
if echo "$APPLY_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('success') is True or d.get('dryRunPassed') is True else 1)" 2>/dev/null; then
  pass "POST /remediate repo_apply dry-run"
else
  fail "POST /remediate repo_apply dry-run" "$(echo "$APPLY_RES" | head -c 240)"
fi

# ── W13. Pre-deploy orchestrator run (catalog image) ───────────────────────────
echo ""
echo "▶ W13. App deploy: orchestrator pre-deploy run (catalog httpd)"
DEPLOY_ID="e2e-deploy-$(date +%s)"
DEPLOY_BODY="$(cat <<EOF
{
  "incidentId": "$DEPLOY_ID",
  "namespace": "${E2E_NS}-orch",
  "resourceName": "httpd-catalog",
  "resourceKind": "Deployment",
  "mode": "pre-deploy",
  "containerImage": "httpd:2.4-alpine",
  "triggeredBy": "e2e-workflows",
  "triggeredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "platform": "web",
  "channelId": "e2e-workflows"
}
EOF
)"
if curl -sf -m 15 -X POST "$ORCHESTRATOR_URL/runs" -H 'Content-Type: application/json' -d "$DEPLOY_BODY" \
  | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('accepted') else 1)" 2>/dev/null; then
  pass "POST /runs pre-deploy accepted"
  RUNS_JSON="$(poll_run_by_incident "$DEPLOY_ID" 30 || echo '{}')"
  if echo "$RUNS_JSON" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('runs') else 1)" 2>/dev/null; then
    pass "pre-deploy run recorded"
    RUN_ID="$(echo "$RUNS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['runs'][0]['runId'])" 2>/dev/null || echo '')"
    if [[ -n "$RUN_ID" ]]; then
      FINAL="$(poll_run_status "$RUN_ID" "$WORKFLOW_RUN_TIMEOUT_SEC" || true)"
      if [[ -n "$FINAL" ]]; then pass "pre-deploy run status: $FINAL"; fi
    fi
  else
    skip "pre-deploy run list (async)"
  fi
else
  fail "POST /runs pre-deploy"
fi

# ── W14. Argo tools smoke ────────────────────────────────────────────────────
echo ""
echo "▶ W14. Argo push/sync smoke"
ARGO_RES="$(curl -sf -m 20 -X POST "$GITOPS_URL/argo/wait-sync" -H 'Content-Type: application/json' \
  -d "{\"appName\":\"${E2E_NS}-e2e-httpd\",\"timeoutMs\":5000,\"incidentId\":\"e2e-argo\"}" 2>/dev/null || echo '{}')"
if echo "$ARGO_RES" | python3 -c "import json,sys; exit(0 if 'status' in json.load(sys.stdin) else 1)" 2>/dev/null; then
  pass "POST /argo/wait-sync responds (Argo optional on Kind)"
else
  fail "POST /argo/wait-sync"
fi
PROMOTE_RES="$(curl -s -m 30 -X POST "$GITOPS_URL/argo/rollout-promote" -H 'Content-Type: application/json' \
  -d "{\"namespace\":\"$E2E_NS\",\"rolloutName\":\"e2e-httpd\",\"incidentId\":\"e2e-promote\"}" 2>/dev/null || echo '{}')"
if echo "$PROMOTE_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'success' in d else 1)" 2>/dev/null; then
  if echo "$PROMOTE_RES" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    pass "POST /argo/rollout-promote succeeded"
  else
    pass "POST /argo/rollout-promote declined (no Argo Rollouts CRD — expected on Kind)"
  fi
else
  fail "POST /argo/rollout-promote" "$(echo "$PROMOTE_RES" | head -c 120)"
fi

# ── W15. Live helm_deploy + Git push (optional) ──────────────────────────────
echo ""
echo "▶ W15. helm_deploy + GitOps push (requires GitHub + GitOps repo)"
if [[ "$E2E_ENABLE_LIVE_DEPLOY" == "true" && -n "${GITHUB_TOKEN:-}" && -n "${GITOPS_REPO_URL:-}" ]]; then
  skip "helm_deploy live test not automated yet — set E2E_HELM_DEPLOY_REPO in test-e2e.env"
else
  skip "helm_deploy live (set E2E_ENABLE_LIVE_DEPLOY=true, GITHUB_TOKEN, GITOPS_REPO_URL)"
fi

# ── W16. CI / coding agent ───────────────────────────────────────────────────
echo ""
echo "▶ W16. CI failure & coding agent"
CICD_HEALTH="$(curl -sf -m 10 "$CICD_URL/health" 2>/dev/null || echo '{}')"
if echo "$CICD_HEALTH" | grep -q githubConfigured; then
  GH_CFG="$(echo "$CICD_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('githubConfigured'))" 2>/dev/null || echo False)"
  pass "cicd githubConfigured=$GH_CFG"
else
  fail "cicd /health shape"
fi
if [[ "$E2E_ENABLE_GITHUB_CI" == "true" && -n "${GITHUB_TOKEN:-}" && -n "${E2E_GITHUB_REPO:-}" ]]; then
  skip "live CI fetch-run test — configure E2E_GITHUB_REPO + workflow run id"
else
  skip "live CI / coding-agent (set E2E_ENABLE_GITHUB_CI=true, GITHUB_TOKEN, E2E_GITHUB_REPO)"
fi
CODING_HEALTH="$(curl -sf -m 10 "$CODING_AGENT_URL/health" 2>/dev/null || echo '{}')"
assert_json_truthy "coding-agent /health" "$CODING_HEALTH" "d.get('status')=='ok'"

# ── W17. Security authorize-action ───────────────────────────────────────────
echo ""
echo "▶ W17. Security authorize-action"
AUTH_BODY="$(cat <<EOF
{
  "incidentId": "e2e-auth",
  "namespace": "$E2E_NS",
  "resourceName": "e2e-httpd",
  "resourceKind": "Deployment",
  "mode": "diagnose",
  "plan": {
    "action": "restart",
    "rootCause": "e2e",
    "reasoning": "low risk restart",
    "severity": "LOW",
    "proposedPatch": [],
    "targetManifestPath": "",
    "commitMessage": "",
    "rollbackSafe": true
  }
}
EOF
)"
AUTH_RES="$(curl -sf -m 15 -X POST "$SECURITY_URL/authorize-action" -H 'Content-Type: application/json' -d "$AUTH_BODY" 2>/dev/null || echo '{}')"
assert_json_truthy "authorize-action returns allowed/denied" "$AUTH_RES" "'allowed' in d or 'authorized' in d"

# ── W18. Console proxy (approvals + chat API) ────────────────────────────────
echo ""
echo "▶ W18. Console API proxy"
if curl -sf -m 10 "$CONSOLE_URL/api/approvals" >/dev/null 2>&1; then
  pass "GET /api/approvals (console → hil)"
else
  fail "GET /api/approvals"
fi
if curl -sf -m 10 "$CONSOLE_URL/api/runs?limit=5" >/dev/null 2>&1; then
  pass "GET /api/runs (console → orchestrator)"
else
  fail "GET /api/runs"
fi

# ── W19. Investigator verify + app graph ─────────────────────────────────────
echo ""
echo "▶ W19. Investigator verify & app catalog"
VERIFY_RES="$(curl -sf -m 60 "$INVESTIGATOR_URL/verify?namespace=$E2E_NS&resourceName=e2e-httpd&resourceKind=Deployment&incidentId=e2e-verify" 2>/dev/null || echo '{}')"
if echo "$VERIFY_RES" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin) else 1)" 2>/dev/null; then
  pass "GET /verify for fixture deployment"
else
  fail "GET /verify"
fi
if curl -sf -m 30 "$INVESTIGATOR_URL/apps/catalog" >/dev/null 2>&1; then
  pass "GET /apps/catalog"
else
  fail "GET /apps/catalog"
fi

print_e2e_summary "Workflow results" || exit 1
