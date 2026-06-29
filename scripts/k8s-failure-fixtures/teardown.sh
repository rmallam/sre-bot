#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECTL="${KUBECTL:-kubectl}"
NS="sre-fixture-lab"

echo "Removing fixture namespace $NS..."
"$KUBECTL" delete namespace "$NS" --ignore-not-found --wait=false
echo "Done."
