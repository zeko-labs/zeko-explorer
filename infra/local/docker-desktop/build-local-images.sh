#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DOCKERFILE="${ROOT_DIR}/infra/docker/Dockerfile.node-service"

declare -A IMAGES=(
  ["@zeko/l1-watcher"]="zeko/l1-watcher:local"
  ["@zeko/zeko-indexer"]="zeko/zeko-indexer:local"
  ["@zeko/explorer-api"]="zeko/explorer-api:local"
  ["@zeko/bridge-api"]="zeko/bridge-api:local"
)

for filter in "${!IMAGES[@]}"; do
  docker build \
    --file "${DOCKERFILE}" \
    --build-arg "PNPM_FILTER=${filter}" \
    --tag "${IMAGES[$filter]}" \
    "${ROOT_DIR}"
done
