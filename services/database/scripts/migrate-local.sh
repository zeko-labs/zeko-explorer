#!/usr/bin/env bash
set -euo pipefail

SURREAL_URL="${SURREAL_URL:-http://localhost:8000}"
SURREAL_USER="${SURREAL_USER:-root}"
SURREAL_PASS="${SURREAL_PASS:-root}"
SURREAL_NAMESPACE="${SURREAL_NAMESPACE:-zeko}"
SURREAL_DATABASE="${SURREAL_DATABASE:-explorer}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SURREALKIT_IMAGE="${SURREALKIT_IMAGE:-ghcr.io/surrealdb/surrealkit:latest}"

docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  --volume "${ROOT_DIR}/services/database/surrealkit:/work" \
  --workdir /work \
  "${SURREALKIT_IMAGE}" \
  --host "${SURREAL_URL/localhost/host.docker.internal}" \
  --ns "${SURREAL_NAMESPACE}" \
  --db "${SURREAL_DATABASE}" \
  --user "${SURREAL_USER}" \
  --pass "${SURREAL_PASS}" \
  sync \
  --fail-fast
