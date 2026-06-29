#!/usr/bin/env bash
# Port-forward sre-bot on k3s to localhost 908x.
# Usage: export KUBECONFIG=~/.kube/k3s.yaml && ./scripts/k3s-port-forward.sh
set -euo pipefail

export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/k3s.yaml}"
KUBECTL="${KUBECTL:-/opt/homebrew/bin/kubectl}"
NS="${NS:-sre-bot-system}"

P_CMD="${K3S_CMD_PORT:-9081}"
P_INV="${K3S_INV_PORT:-9082}"
P_BRAIN="${K3S_BRAIN_PORT:-9083}"
P_ORCH="${K3S_ORCH_PORT:-9084}"
P_HIL="${K3S_HIL_PORT:-9085}"
P_GIT="${K3S_GITOPS_PORT:-9086}"
P_EXEC="${K3S_EXECUTOR_PORT:-9087}"
P_SEC="${K3S_SECURITY_PORT:-9088}"
P_CICD="${K3S_CICD_PORT:-9089}"
P_PLAT="${K3S_PLATFORM_PORT:-9090}"
P_CONSOLE="${K3S_CONSOLE_PORT:-9091}"
P_CODING="${K3S_CODING_PORT:-9092}"

echo "Forwarding k3s/${NS} → localhost 908x (KUBECONFIG=${KUBECONFIG})"
echo "  Console: http://localhost:${P_CONSOLE}"

"$KUBECTL" wait -n "$NS" --for=condition=available deployment --all --timeout=300s

pids=()
forward() {
  "$KUBECTL" port-forward -n "$NS" "svc/$1" "$2:8080" >/dev/null &
  pids+=("$!")
}

forward console-agent "$P_CONSOLE"
forward commander-agent "$P_CMD"
forward investigator-agent "$P_INV"
forward brain-agent "$P_BRAIN"
forward orchestrator-agent "$P_ORCH"
forward hil-agent "$P_HIL"
forward gitops-agent "$P_GIT"
forward executor-agent "$P_EXEC"
forward security-agent "$P_SEC"
forward cicd-agent "$P_CICD"
forward platform-agent "$P_PLAT"
forward coding-agent "$P_CODING"

trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM
echo "Port-forwards active. Ctrl+C to stop."
wait
