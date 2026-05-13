#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${ZEKO_LOCAL_NAMESPACE:-zeko-m-local}"

helm uninstall zeko-explorer-local --namespace "${NAMESPACE}" --ignore-not-found
