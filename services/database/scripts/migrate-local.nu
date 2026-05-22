#!/usr/bin/env nu

let surreal_url = ($env.SURREAL_URL? | default "http://localhost:8000")
let surreal_user = ($env.SURREAL_USER? | default "root")
let surreal_pass = ($env.SURREAL_PASS? | default "root")
let surreal_namespace = ($env.SURREAL_NAMESPACE? | default "zeko")
let surreal_database = ($env.SURREAL_DATABASE? | default "explorer")
let root_dir = ($env.FILE_PWD | path join "../../.." | path expand)
let surrealkit_image = ($env.SURREALKIT_IMAGE? | default "ghcr.io/surrealdb/surrealkit:latest")
let docker_host_url = ($surreal_url | str replace "localhost" "host.docker.internal")
let surrealkit_dir = ($root_dir | path join "services/database/surrealkit")

docker run --rm --add-host "host.docker.internal:host-gateway" --volume $"($surrealkit_dir):/work" --workdir /work $surrealkit_image --host $docker_host_url --ns $surreal_namespace --db $surreal_database --user $surreal_user --pass $surreal_pass sync --fail-fast
