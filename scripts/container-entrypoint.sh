#!/bin/sh
# Kube API access from containers:
#
# 1) KUBE_PROXY_URL set → use in-compose kubectl proxy (profile: kube-proxy)
# 2) Else rewrite host kubeconfig 127.0.0.1/localhost → KUBE_API_HOST
#    (default host.containers.internal for Podman Desktop e.g. :50750)
set -e

if [ -n "${KUBE_PROXY_URL:-}" ]; then
  mkdir -p /tmp/kube
  cat > /tmp/kube/config <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${KUBE_PROXY_URL}
    insecure-skip-tls-verify: true
  name: compose-proxy
contexts:
- context:
    cluster: compose-proxy
    user: default
  name: default
current-context: default
users:
- name: default
  user: {}
EOF
  export KUBECONFIG=/tmp/kube/config
elif [ -f /root/.kube/config ]; then
  KUBE_API_HOST="${KUBE_API_HOST:-host.containers.internal}"
  mkdir -p /tmp/kube
  sed \
    -e "s|127.0.0.1|${KUBE_API_HOST}|g" \
    -e "s|localhost|${KUBE_API_HOST}|g" \
    /root/.kube/config > /tmp/kube/config.raw
  export KUBECONFIG=/tmp/kube/config.raw
  # Minify so client-node does not choke on stale clusters (empty server / "NAME" rows).
  if command -v kubectl >/dev/null 2>&1; then
    kubectl config view --minify --flatten > /tmp/kube/config
  else
    cp /tmp/kube/config.raw /tmp/kube/config
  fi
  export KUBECONFIG=/tmp/kube/config
  # Forwarded API (Podman Desktop): server host != cert SAN — kubectl needs skip verify
  if [ "${KUBE_INSECURE_SKIP_TLS_VERIFY:-true}" != "false" ] && command -v kubectl >/dev/null 2>&1; then
    cluster="$(kubectl config view --minify -o jsonpath='{.clusters[0].name}' 2>/dev/null || true)"
    if [ -n "$cluster" ]; then
      kubectl config set-cluster "$cluster" --insecure-skip-tls-verify=true >/dev/null 2>&1 || true
    fi
  fi
fi

cd /app/agents/"${AGENT_DIR:?AGENT_DIR required}"
exec npm start
