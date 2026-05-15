#!/usr/bin/env nu

let root_dir = ($env.FILE_PWD | path join "../../.." | path expand)

let targets = [
  [project, image];
  ["services/l1-watcher", "l1-watcher"]
  ["services/zeko-indexer", "zeko-indexer"]
  ["services/explorer-api", "explorer-api"]
  ["services/bridge-api", "bridge-api"]
]

for target in $targets {
  docker build --file ($root_dir | path join $target.project "Dockerfile") --tag $"zeko/($target.image):local" $root_dir
}
