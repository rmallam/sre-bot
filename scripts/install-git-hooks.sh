#!/usr/bin/env bash
# Install a pre-commit hook that runs CI-equivalent tests before every commit.
# Usage: ./scripts/install-git-hooks.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# sre-bot pre-commit — unit + platform tests (fast CI gate)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
echo "pre-commit: npm test"
npm test
echo "pre-commit: npm run test:platform"
npm run test:platform
echo "pre-commit: OK"
EOF

chmod +x "$HOOK"
echo "Installed $HOOK"
echo ""
echo "Optional full E2E before push (Kind required):"
echo "  ./scripts/test-all.sh"
