#!/usr/bin/env bash
# Port-forward sre-bot on kind to localhost using 908x ports (compose uses 808x).
# Run alongside podman compose — no port conflicts.
#
# Usage: ./scripts/kind-port-forward.sh [kind-cluster-name]
set -euo pipefail

KIND_CLUSTER="${1:-test-upgrade-cluster}"
KIND_CONTEXT="kind-${KIND_CLUSTER}"
NS="${NS:-sre-bot-system}"

P_CMD="${KIND_CMD_PORT:-9081}"
P_INV="${KIND_INV_PORT:-9082}"
P_BRAIN="${KIND_BRAIN_PORT:-9083}"
P_ORCH="${KIND_ORCH_PORT:-9084}"
P_HIL="${KIND_HIL_PORT:-9085}"
P_GIT="${KIND_GITOPS_PORT:-9086}"
P_EXEC="${KIND_EXECUTOR_PORT:-9087}"
P_SEC="${KIND_SECURITY_PORT:-9088}"
P_CICD="${KIND_CICD_PORT:-9089}"
P_PLAT="${KIND_PLATFORM_PORT:-9090}"
P_CONSOLE="${KIND_CONSOLE_PORT:-9091}"
P_CODING="${KIND_CODING_PORT:-9092}"

echo "Forwarding ${KIND_CONTEXT}/${NS} → localhost 908x (compose stays on 808x). Ctrl+C to stop."
echo ""
echo "  Console:      http://localhost:${P_CONSOLE}"
echo "  Commander:    http://localhost:${P_CMD}"
echo "  Orchestrator: http://localhost:${P_ORCH}"
echo "  HIL:          http://localhost:${P_HIL}"
echo "  Platform:     http://localhost:${P_PLAT}"
echo "  Investigator: http://localhost:${P_INV}"
echo ""

echo "Waiting for deployments to be ready..."
kubectl --context "$KIND_CONTEXT" wait -n "$NS" \
  --for=condition=available \
  deployment --all \
  --timeout=180s

pids=()

forward() {
  local svc="$1"
  local local_port="$2"
  kubectl --context "$KIND_CONTEXT" port-forward -n "$NS" "svc/${svc}" "${local_port}:8080" >/dev/null &
  pids+=("$!")
}

forward console-agent "$P_CONSOLE"
forward commander-agent "$P_CMD"
forward orchestrator-agent "$P_ORCH"
forward hil-agent "$P_HIL"
forward platform-agent "$P_PLAT"
forward investigator-agent "$P_INV"
forward brain-agent "$P_BRAIN"
forward gitops-agent "$P_GIT"
forward executor-agent "$P_EXEC"
forward security-agent "$P_SEC"
forward cicd-agent "$P_CICD"
forward coding-agent "$P_CODING"

cleanup() {
  local pid
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# Fail fast if any forward dies immediately (bad svc name, port in use, etc.)
sleep 1
for pid in "${pids[@]}"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "error: a port-forward failed to start (port already in use or service missing?)" >&2
    exit 1
  fi
done

echo "All forwards running."
echo "Note: if a pod restarts, re-run this script (port-forwards do not auto-reconnect)."
wait
