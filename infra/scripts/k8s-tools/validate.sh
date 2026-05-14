#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN_DIR="${ROOT_DIR}/.moon/cache/tools/bin"
CHART_DIR="${ROOT_DIR}/infra/k8s/chart/zeko-explorer"
LOCAL_VALUES="${ROOT_DIR}/infra/k8s/values/local/docker-desktop.kyaml"
RENDERED_DIR="${ROOT_DIR}/.moon/cache/k8s"
RENDERED="${RENDERED_DIR}/zeko-explorer.rendered.kyaml"

export PATH="${BIN_DIR}:${PATH}"

"${ROOT_DIR}/infra/scripts/k8s-tools/install.sh" >/dev/null

mkdir -p "${RENDERED_DIR}"

yamlfmt -d -o kyaml \
  "${CHART_DIR}/values.kyaml" \
  "${LOCAL_VALUES}"

node "${ROOT_DIR}/tools/validate-yaml.mjs" \
  "${CHART_DIR}/Chart.yaml" \
  "${CHART_DIR}/values.kyaml" \
  "${LOCAL_VALUES}"

helm lint "${CHART_DIR}" --values "${CHART_DIR}/values.kyaml" --values "${LOCAL_VALUES}"
helm template zeko-explorer-local "${CHART_DIR}" \
  --values "${CHART_DIR}/values.kyaml" \
  --values "${LOCAL_VALUES}" \
  >"${RENDERED}"

node "${ROOT_DIR}/tools/validate-yaml.mjs" "${RENDERED}"
kubeconform -summary -strict <"${RENDERED}"
