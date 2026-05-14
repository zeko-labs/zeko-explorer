#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DOCKERFILE="${ROOT_DIR}/infra/docker/Dockerfile.node-service"

declare -A IMAGES=(
  ["l1-watcher"]="zeko/l1-watcher:local"
  ["zeko-indexer"]="zeko/zeko-indexer:local"
  ["explorer-api"]="zeko/explorer-api:local"
  ["bridge-api"]="zeko/bridge-api:local"
)

for target in "${!IMAGES[@]}"; do
  docker build \
    --file "${DOCKERFILE}" \
    --build-arg "MOON_TARGET=${target}" \
    --tag "${IMAGES[$target]}" \
    "${ROOT_DIR}"
done
