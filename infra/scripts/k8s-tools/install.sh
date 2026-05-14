#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN_DIR="${ROOT_DIR}/.moon/cache/tools/bin"

mkdir -p "${BIN_DIR}"

export GOBIN="${BIN_DIR}"

go install sigs.k8s.io/yaml/yamlfmt@v1.6.0
go install helm.sh/helm/v3/cmd/helm@v3.21.0
go install github.com/yannh/kubeconform/cmd/kubeconform@latest
