#!/usr/bin/env nu

let namespace = ($env.ZEKO_LOCAL_NAMESPACE? | default "zeko-m-local")

let jobs = [
  (job spawn { kubectl port-forward --namespace $namespace service/explorer-api 4101:4101 })
  (job spawn { kubectl port-forward --namespace $namespace service/bridge-api 4102:4102 })
  (job spawn { kubectl port-forward --namespace $namespace service/nats 4222:4222 })
  (job spawn { kubectl port-forward --namespace $namespace service/surrealdb 8000:8000 })
]

def cleanup [jobs: list<int>] {
  for job_id in $jobs {
    do --ignore-errors { job kill $job_id }
  }
}

print "Local bindings:"
print "  localhost:4101 -> service/explorer-api"
print "  localhost:4102 -> service/bridge-api"
print "  localhost:4222 -> service/nats"
print "  localhost:8000 -> service/surrealdb"

try {
  loop {
    sleep 1sec
  }
} catch {
  cleanup $jobs
}
