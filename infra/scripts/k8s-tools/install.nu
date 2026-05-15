#!/usr/bin/env nu

let root_dir = ($env.FILE_PWD | path join "../../.." | path expand)
let bin_dir = ($root_dir | path join ".moon/cache/tools/bin")

mkdir $bin_dir

$env.GOBIN = $bin_dir

go install sigs.k8s.io/yaml/yamlfmt@v1.6.0
go install helm.sh/helm/v4/cmd/helm@v4.2.0
go install github.com/yannh/kubeconform/cmd/kubeconform@latest
