#!/usr/bin/env bash
set -euo pipefail

SURREAL_URL="${SURREAL_URL:-http://localhost:8000}"
SURREAL_USER="${SURREAL_USER:-root}"
SURREAL_PASS="${SURREAL_PASS:-root}"
SURREAL_NAMESPACE="${SURREAL_NAMESPACE:-zeko}"
SURREAL_DATABASE="${SURREAL_DATABASE:-explorer}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

surreal sql \
  --conn "${SURREAL_URL}" \
  --user "${SURREAL_USER}" \
  --pass "${SURREAL_PASS}" \
  --namespace "${SURREAL_NAMESPACE}" \
  --database "${SURREAL_DATABASE}" \
  --file "${SCRIPT_DIR}/001-da-status.surql"
