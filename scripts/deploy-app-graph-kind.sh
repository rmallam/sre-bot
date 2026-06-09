#!/usr/bin/env bash
# Build and rollout app-graph related agents to kind (fast path, no full helm).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KIND_CLUSTER="${1:-test-upgrade-cluster}"
KIND_CONTEXT="kind-${KIND_CLUSTER}"
IMAGE_TAG="${IMAGE_TAG:-kind-local}"
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${OWNER:-rmallam}"
NS="${NAMESPACE:-sre-bot-system}"

if ! kubectl --context "$KIND_CONTEXT" get nodes >/dev/null 2>&1; then
  echo "Cannot reach $KIND_CONTEXT" >&2
  exit 1
fi

build_load() {
  local dockerfile="$1"
  local image="$2"
  local archive
  archive="$(mktemp "${TMPDIR:-/tmp}/sre-bot-app-graph.XXXXXX.tar")"
  echo "==> build ${image}"
  podman build -q -t "$image" -f "$dockerfile" "$ROOT"
  podman save -q "$image" -o "$archive"
  kind load image-archive --name "$KIND_CLUSTER" "$archive"
  rm -f "$archive"
}

AGENTS=(
  "agents/investigator/Dockerfile|${REGISTRY}/${OWNER}/sre-bot-investigator:${IMAGE_TAG}|investigator-agent"
  "agents/commander/Dockerfile|${REGISTRY}/${OWNER}/sre-bot-commander:${IMAGE_TAG}|commander-agent"
  "agents/orchestrator/Dockerfile|${REGISTRY}/${OWNER}/sre-bot-orchestrator:${IMAGE_TAG}|orchestrator-agent"
  "agents/console/Dockerfile|${REGISTRY}/${OWNER}/sre-bot-console:${IMAGE_TAG}|console-agent"
)

for entry in "${AGENTS[@]}"; do
  IFS='|' read -r df img dep <<< "$entry"
  build_load "$df" "$img"
  echo "==> rollout restart ${dep}"
  kubectl --context "$KIND_CONTEXT" -n "$NS" rollout restart "deployment/${dep}"
  kubectl --context "$KIND_CONTEXT" -n "$NS" rollout status "deployment/${dep}" --timeout=180s
done

echo ""
echo "Deployed app-graph agents to ${KIND_CONTEXT}/${NS}"
echo "Run: ./scripts/test-app-graph.sh"
