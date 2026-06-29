#!/usr/bin/env bash
# Apply Kind/OpenShift eval fixtures for runbook corpus testing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECTL="${KUBECTL:-kubectl}"
NS="sre-fixture-lab"

echo "Applying namespace and failure fixtures to cluster..."
"$KUBECTL" apply -f "$DIR/namespace.yaml"

for manifest in "$DIR/manifests"/*.yaml; do
  echo "  → $(basename "$manifest")"
  "$KUBECTL" apply -f "$manifest"
done

echo ""
echo "Fixtures applied in namespace: $NS"
echo "List pods: $KUBECTL get pods -n $NS"
echo "Investigate example: investigate pod fixture-crash-loop in $NS"
