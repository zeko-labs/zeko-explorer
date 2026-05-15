#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

TARGETS=(
  "services/l1-watcher:l1-watcher"
  "services/zeko-indexer:zeko-indexer"
  "services/explorer-api:explorer-api"
  "services/bridge-api:bridge-api"
)

for entry in "${TARGETS[@]}"; do
  project="${entry%%:*}"
  image="${entry##*:}"

  docker build \
    --file "${ROOT_DIR}/${project}/Dockerfile" \
    --tag "zeko/${image}:local" \
    "${ROOT_DIR}"
done
