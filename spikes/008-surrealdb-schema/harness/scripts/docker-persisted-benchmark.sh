#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SPIKE008_DOCKER_IMAGE:-surrealdb/surrealdb:v3}"
SURREALKIT_IMAGE="${SPIKE008_SURREALKIT_IMAGE:-ghcr.io/surrealdb/surrealkit:latest}"
CONTAINER="${SPIKE008_DOCKER_CONTAINER:-spike-008-surrealdb-benchmark}"
VOLUME="${SPIKE008_DOCKER_VOLUME:-spike-008-surrealdb-benchmark-data}"
PORT="${SPIKE008_DOCKER_PORT:-8129}"
DB="${BENCH_DB_NAME:-bench_surrealkit}"
REPORT_DIR="${SPIKE008_REPORT_DIR:-$(pwd)/reports}"
LOAD_PROJECT_DIR="${BENCH_LOAD_PROJECT_DIR:-${BENCH_SURREALKIT_PROJECT_DIR:-${REPORT_DIR}/benchmark-load}}"
HOST_SURREAL_BIN="${SPIKE008_IMPORT_BIN:-${SPIKE008_SURREAL_BIN:-${HOME}/.cache/zeko-explorer/surreal-v3.0.5/surreal}}"

case "$REPORT_DIR" in
  /*) ;;
  *) REPORT_DIR="$(pwd)/$REPORT_DIR" ;;
esac

case "$LOAD_PROJECT_DIR" in
  /*) ;;
  *) LOAD_PROJECT_DIR="$(pwd)/$LOAD_PROJECT_DIR" ;;
esac

import_live_file() {
  local file="$1"
  if [[ -x "$HOST_SURREAL_BIN" ]]; then
    "$HOST_SURREAL_BIN" import \
      --log none \
      --endpoint "http://127.0.0.1:${PORT}" \
      --namespace spike008 \
      --database "$DB" \
      --username root \
      --password root \
      "$file"
  else
    docker run --rm \
      --add-host "host.docker.internal:host-gateway" \
      --volume "${LOAD_PROJECT_DIR}:/work" \
      "$IMAGE" \
      import \
      --log none \
      --endpoint "http://host.docker.internal:${PORT}" \
      --namespace spike008 \
      --database "$DB" \
      --username root \
      --password root \
      "/work/${file#"$LOAD_PROJECT_DIR"/}"
  fi
}

cleanup() {
  if [[ "${BENCH_KEEP_DOCKER:-0}" != "1" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
}

cleanup
trap cleanup EXIT

mkdir -p "$REPORT_DIR"

generated_started_at="$(date +%s)"
if [[ "${BENCH_SKIP_GENERATE_LOAD:-0}" != "1" ]]; then
  BENCH_LOAD_PROJECT_DIR="$LOAD_PROJECT_DIR" pnpm run benchmark:generate-load
else
  echo "[benchmark-load] reusing generated load project at ${LOAD_PROJECT_DIR}"
fi
generated_at="$(date +%s)"

cp "${LOAD_PROJECT_DIR}/database/schema-full/000_schema.surql" "${LOAD_PROJECT_DIR}/database/schema/000_schema.surql"

docker volume create "$VOLUME" >/dev/null

started_at="$(date +%s)"
docker run \
  --detach \
  --name "$CONTAINER" \
  --user "0:0" \
  --publish "127.0.0.1:${PORT}:8000" \
  --volume "${VOLUME}:/data" \
  "$IMAGE" \
  start \
  --no-banner \
  --bind "0.0.0.0:8000" \
  --username root \
  --password root \
  surrealkv:/data/benchmark.db >/dev/null

until curl --silent --fail \
  --user root:root \
  --header "Surreal-NS: spike008" \
  --header "Surreal-DB: $DB" \
  --header "Accept: application/json" \
  --data-binary "INFO FOR DB;" \
  "http://127.0.0.1:${PORT}/sql" >/dev/null; do
  sleep 1
done
ready_at="$(date +%s)"

docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  --volume "${LOAD_PROJECT_DIR}:/work" \
  --workdir /work \
  "$SURREALKIT_IMAGE" \
  --host "http://host.docker.internal:${PORT}" \
  --ns spike008 \
  --db "$DB" \
  --user root \
  --pass root \
  sync \
  --fail-fast
synced_at="$(date +%s)"

seed_count=0
for seed_file in "${LOAD_PROJECT_DIR}"/database/import/chunks/*.surql; do
  seed_count=$((seed_count + 1))
  if (( seed_count < ${BENCH_IMPORT_START_CHUNK:-1} )); then
    echo "[benchmark-load] skipping live import chunk ${seed_count}: $(basename "$seed_file")"
    continue
  fi
  echo "[benchmark-load] live import chunk ${seed_count}: $(basename "$seed_file")"
  import_live_file "$seed_file"
  if [[ "${BENCH_DELETE_IMPORTED_CHUNKS:-0}" == "1" ]]; then
    rm -f "$seed_file"
  fi
done
loaded_at="$(date +%s)"

SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_BENCH_STORAGE="Docker ${IMAGE} with persisted SurrealKV volume ${VOLUME}; schema applied by SurrealKit sync; data loaded by sequential official surreal import chunk files; full index set enabled during import" \
BENCH_SKIP_SEED=1 \
BENCH_DB_NAME="$DB" \
BENCH_LOAD_METHOD="surreal-import-chunks" \
BENCH_LOAD_GENERATE_SECONDS="$((generated_at - generated_started_at))" \
BENCH_LOAD_DB_READY_SECONDS="$((ready_at - started_at))" \
BENCH_LOAD_SCHEMA_SECONDS="$((synced_at - ready_at))" \
BENCH_LOAD_DATA_SECONDS="$((loaded_at - synced_at))" \
BENCH_LOAD_INDEX_SECONDS=0 \
BENCH_LOAD_SECONDS="$((loaded_at - started_at))" \
pnpm run benchmark
