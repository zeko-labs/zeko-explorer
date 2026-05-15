#!/usr/bin/env nu

let root_dir = ($env.FILE_PWD | path join "../../.." | path expand)
let bin_dir = ($root_dir | path join ".moon/cache/tools/bin")
let chart_dir = ($root_dir | path join "infra/k8s/chart/zeko-explorer")
let local_values = ($root_dir | path join "infra/k8s/values/local/docker-desktop.kyaml")
let rendered_dir = ($root_dir | path join ".moon/cache/k8s")
let rendered = ($rendered_dir | path join "zeko-explorer.rendered.kyaml")

$env.PATH = ([$bin_dir] ++ $env.PATH)

mkdir $rendered_dir

yamlfmt -d ($chart_dir | path join "Chart.yaml")
yamlfmt -d -o kyaml ($chart_dir | path join "values.kyaml") $local_values

helm lint $chart_dir --values ($chart_dir | path join "values.kyaml") --values $local_values
helm template zeko-explorer-local $chart_dir --values ($chart_dir | path join "values.kyaml") --values $local_values o> $rendered

open --raw $rendered | kubeconform -summary -strict
