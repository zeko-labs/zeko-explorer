#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

TARGETS=(
  "l1-watcher"
  "zeko-indexer"
  "explorer-api"
  "bridge-api"
)

for target in "${TARGETS[@]}"; do
  docker build \
    --file "${ROOT_DIR}/infra/docker/${target}.Dockerfile" \
    --tag "zeko/${target}:local" \
    "${ROOT_DIR}"
done
