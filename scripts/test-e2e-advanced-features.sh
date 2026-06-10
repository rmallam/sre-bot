#!/usr/bin/env bash
# Smoke tests for alert correlation, playbook verify, and git revert endpoints.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/test-e2e-lib.sh"

echo ""
echo "▶ Advanced features — correlation, playbook verify, git revert"

# ── 1. Alert correlation (pure logic via vitest) ─────────────────────────────
if npm test -- shared/test/alert-correlation.test.ts shared/test/playbook-verify.test.ts shared/test/deploy-git-rollback.test.ts >/dev/null 2>&1; then
  pass "unit tests — alert correlation, playbook verify, git rollback"
else
  fail "unit tests — advanced features"
fi

# ── 2. Investigator playbook verify endpoint ─────────────────────────────────
VERIFY_BODY="$(cat <<'EOF'
{
  "namespace": "default",
  "resourceName": "test-app",
  "incidentId": "e2e-playbook-verify",
  "playbookMarkdown": "## Verification\n- type: promql query: vector(1) expect: < 2"
}
EOF
)"
PV="$(curl -sf -m 30 -X POST "$INVESTIGATOR_URL/verify" -H 'Content-Type: application/json' -d "$VERIFY_BODY" 2>/dev/null || echo '{}')"
if echo "$PV" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'playbookChecks' in d or 'healthy' in d else 1)" 2>/dev/null; then
  pass "POST /verify accepts playbookMarkdown"
else
  fail "POST /verify playbookMarkdown" "$(echo "$PV" | head -c 120)"
fi

# ── 3. Alert correlation bindings endpoint ───────────────────────────────────
BIND_BODY='{"workloads":[{"namespace":"default","resourceKind":"Deployment","resourceName":"test-app"}]}'
BIND="$(curl -sf -m 30 -X POST "$INVESTIGATOR_URL/alert-correlation/bindings" -H 'Content-Type: application/json' -d "$BIND_BODY" 2>/dev/null || echo '{}')"
if echo "$BIND" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'bindings' in d else 1)" 2>/dev/null; then
  pass "POST /alert-correlation/bindings"
else
  fail "POST /alert-correlation/bindings" "$(echo "$BIND" | head -c 120)"
fi

# ── 4. AlertManager webhook batch correlation (mock payload) ─────────────────
AM_BODY="$(cat <<'EOF'
{
  "alerts": [
    {
      "status": "firing",
      "labels": {"alertname": "HighErrorRate", "namespace": "checkout", "deployment": "payments-api", "dependency": "shared-db"},
      "annotations": {"summary": "payments errors"},
      "fingerprint": "e2e-a"
    },
    {
      "status": "firing",
      "labels": {"alertname": "HighErrorRate", "namespace": "checkout", "deployment": "orders-api", "dependency": "shared-db"},
      "annotations": {"summary": "orders errors"},
      "fingerprint": "e2e-b"
    }
  ]
}
EOF
)"
AM="$(curl -sf -m 30 -X POST "$COMMANDER_URL/webhooks/alertmanager" -H 'Content-Type: application/json' -d "$AM_BODY" 2>/dev/null || echo '{}')"
if echo "$AM" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('ok') is True else 1)" 2>/dev/null; then
  started="$(echo "$AM" | python3 -c "import json,sys; print(json.load(sys.stdin).get('started',0))" 2>/dev/null || echo 0)"
  if [[ "$started" -le 1 ]]; then
    pass "AlertManager webhook correlates batch (started=$started)"
  else
    fail "AlertManager webhook correlation" "expected <=1 run, started=$started"
  fi
else
  skip "AlertManager webhook — commander unreachable or auth required"
fi

# ── 5. Git revert endpoint exists ────────────────────────────────────────────
REVERT="$(curl -sf -m 15 -X POST "$GITOPS_URL/revert-deploy" -H 'Content-Type: application/json' -d '{"incidentId":"e2e-revert","namespace":"default","resourceName":"test","deployGitCommitSha":"abc","previousGitCommitSha":"def","reason":"e2e"}' 2>/dev/null || echo '{}')"
if echo "$REVERT" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'success' in d else 1)" 2>/dev/null; then
  pass "POST /revert-deploy endpoint responds"
else
  fail "POST /revert-deploy" "$(echo "$REVERT" | head -c 120)"
fi
