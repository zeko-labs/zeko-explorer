#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${ZEKO_LOCAL_NAMESPACE:-zeko-m-local}"

declare -a PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
}

trap cleanup EXIT INT TERM

kubectl port-forward --namespace "${NAMESPACE}" service/explorer-api 4101:4101 &
PIDS+=("$!")
kubectl port-forward --namespace "${NAMESPACE}" service/bridge-api 4102:4102 &
PIDS+=("$!")
kubectl port-forward --namespace "${NAMESPACE}" service/nats 4222:4222 &
PIDS+=("$!")
kubectl port-forward --namespace "${NAMESPACE}" service/surrealdb 8000:8000 &
PIDS+=("$!")

echo "Local bindings:"
echo "  localhost:4101 -> service/explorer-api"
echo "  localhost:4102 -> service/bridge-api"
echo "  localhost:4222 -> service/nats"
echo "  localhost:8000 -> service/surrealdb"

wait
