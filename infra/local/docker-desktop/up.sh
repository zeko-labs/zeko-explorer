#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${ZEKO_LOCAL_NAMESPACE:-zeko-m-local}"
TOOLS_DIR="${ROOT_DIR}/.moon/cache/tools/bin"

export PATH="${TOOLS_DIR}:${PATH}"

"${ROOT_DIR}/infra/scripts/k8s-tools/install.sh" >/dev/null

if ! kubectl config current-context | grep -q "docker-desktop"; then
  echo "Refusing to install local stack outside the docker-desktop Kubernetes context." >&2
  echo "Set kubectl context to docker-desktop, or export ZEKO_ALLOW_NON_DOCKER_DESKTOP=1." >&2
  if [[ "${ZEKO_ALLOW_NON_DOCKER_DESKTOP:-0}" != "1" ]]; then
    exit 1
  fi
fi

kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install zeko-explorer-local \
  "${ROOT_DIR}/infra/k8s/chart/zeko-explorer" \
  --namespace "${NAMESPACE}" \
  --values "${ROOT_DIR}/infra/k8s/chart/zeko-explorer/values.kyaml" \
  --values "${ROOT_DIR}/infra/k8s/values/local/docker-desktop.kyaml" \
  --set "networkId=zeko-m-local"

kubectl rollout status statefulset/nats --namespace "${NAMESPACE}" --timeout=120s
kubectl rollout status statefulset/surrealdb --namespace "${NAMESPACE}" --timeout=120s
kubectl rollout status deployment/zeko-indexer --namespace "${NAMESPACE}" --timeout=120s
kubectl rollout status deployment/explorer-api --namespace "${NAMESPACE}" --timeout=120s
kubectl rollout status deployment/bridge-api --namespace "${NAMESPACE}" --timeout=120s
