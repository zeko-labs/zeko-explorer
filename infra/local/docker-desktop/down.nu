#!/usr/bin/env nu

let namespace = ($env.ZEKO_LOCAL_NAMESPACE? | default "zeko-m-local")

helm uninstall zeko-explorer-local --namespace $namespace --ignore-not-found
