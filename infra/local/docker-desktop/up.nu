#!/usr/bin/env nu

let root_dir = ($env.FILE_PWD | path join "../../.." | path expand)
let namespace = ($env.ZEKO_LOCAL_NAMESPACE? | default "zeko-m-local")

let context = (kubectl config current-context)
if not ($context | str contains "docker-desktop") {
  print --stderr "Refusing to install local stack outside the docker-desktop Kubernetes context."
  print --stderr "Set kubectl context to docker-desktop, or set ZEKO_ALLOW_NON_DOCKER_DESKTOP=1."
  if (($env.ZEKO_ALLOW_NON_DOCKER_DESKTOP? | default "0") != "1") {
    exit 1
  }
}

kubectl create namespace $namespace --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install zeko-explorer-local ($root_dir | path join "infra/k8s/chart/zeko-explorer") --namespace $namespace --values ($root_dir | path join "infra/k8s/chart/zeko-explorer/values.kyaml") --values ($root_dir | path join "infra/k8s/values/local/docker-desktop.kyaml") --set "networkId=zeko-m-local"

kubectl rollout status statefulset/nats --namespace $namespace --timeout=120s
kubectl rollout status statefulset/surrealdb --namespace $namespace --timeout=120s
kubectl rollout status deployment/zeko-indexer --namespace $namespace --timeout=120s
kubectl rollout status deployment/explorer-api --namespace $namespace --timeout=120s
kubectl rollout status deployment/bridge-api --namespace $namespace --timeout=120s
