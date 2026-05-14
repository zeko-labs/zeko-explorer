#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SPIKE008_DOCKER_IMAGE:-surrealdb/surrealdb:v3}"
SURREALKIT_IMAGE="${SPIKE008_SURREALKIT_IMAGE:-ghcr.io/surrealdb/surrealkit:latest}"
CONTAINER="${SPIKE008_DOCKER_CONTAINER:-spike-008-surrealdb-benchmark}"
VOLUME="${SPIKE008_DOCKER_VOLUME:-spike-008-surrealdb-benchmark-data}"
PORT="${SPIKE008_DOCKER_PORT:-8129}"
DB="${BENCH_DB_NAME:-bench_surrealkit}"
LOAD_METHOD="${BENCH_LOAD_METHOD:-surreal-import-chunks}"
DEFER_INDEXES="${BENCH_DEFER_INDEXES:-0}"
INDEX_IMPORT_MODE="${BENCH_INDEX_IMPORT_MODE:-combined}"
STORAGE_ENGINE="${BENCH_STORAGE_ENGINE:-surrealkv}"
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

case "$STORAGE_ENGINE" in
  surrealkv|rocksdb) ;;
  *)
    echo "Unknown BENCH_STORAGE_ENGINE: $STORAGE_ENGINE" >&2
    exit 2
    ;;
esac

STORAGE_PATH="${STORAGE_ENGINE}:/data/benchmark.db"

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
  if [[ "$LOAD_METHOD" == "surreal-import-embedded" || "$LOAD_METHOD" == "surreal-import" ]]; then
    export BENCH_WRITE_MONOLITHIC_IMPORT=1
  fi
  BENCH_LOAD_PROJECT_DIR="$LOAD_PROJECT_DIR" pnpm run benchmark:generate-load
else
  echo "[benchmark-load] reusing generated load project at ${LOAD_PROJECT_DIR}"
fi
generated_at="$(date +%s)"
if [[ "$DEFER_INDEXES" == "1" ]]; then
  cp "${LOAD_PROJECT_DIR}/database/schema-no-index/000_schema.surql" "${LOAD_PROJECT_DIR}/database/schema/000_schema.surql"
else
  cp "${LOAD_PROJECT_DIR}/database/schema-full/000_schema.surql" "${LOAD_PROJECT_DIR}/database/schema/000_schema.surql"
fi

docker volume create "$VOLUME" >/dev/null

started_at="$(date +%s)"
if [[ "$LOAD_METHOD" == "surreal-import-embedded" || "$LOAD_METHOD" == "surreal-import-embedded-chunks" ]]; then
  ready_at="$started_at"
else
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
    "$STORAGE_PATH" >/dev/null

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
fi

if [[ "$LOAD_METHOD" == "surreal-import-embedded" || "$LOAD_METHOD" == "surreal-import-embedded-chunks" ]]; then
  embedded_schema_file="schema-full.surql"
  if [[ "$DEFER_INDEXES" == "1" ]]; then
    embedded_schema_file="schema-no-index.surql"
  fi
  docker run --rm \
    --user "0:0" \
    --volume "${LOAD_PROJECT_DIR}:/work" \
    --volume "${VOLUME}:/data" \
    "$IMAGE" \
    import \
    --endpoint "$STORAGE_PATH" \
    --namespace spike008 \
    --database "$DB" \
    --username root \
    --password root \
    "/work/database/import/${embedded_schema_file}"
else
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
fi
synced_at="$(date +%s)"

case "$LOAD_METHOD" in
  surreal-import-embedded)
    docker run --rm \
      --user "0:0" \
      --volume "${LOAD_PROJECT_DIR}:/work" \
      --volume "${VOLUME}:/data" \
      "$IMAGE" \
      import \
      --endpoint "$STORAGE_PATH" \
      --namespace spike008 \
      --database "$DB" \
      --username root \
      --password root \
      /work/database/import/data.surql
    ;;
  surreal-import-embedded-chunks)
    seed_count=0
    for seed_file in "${LOAD_PROJECT_DIR}"/database/import/chunks/*.surql; do
      seed_count=$((seed_count + 1))
      if (( seed_count < ${BENCH_IMPORT_START_CHUNK:-1} )); then
        echo "[benchmark-load] skipping embedded import chunk ${seed_count}: $(basename "$seed_file")"
        continue
      fi
      echo "[benchmark-load] embedded import chunk ${seed_count}: $(basename "$seed_file")"
      docker run --rm \
        --user "0:0" \
        --volume "${LOAD_PROJECT_DIR}:/work" \
        --volume "${VOLUME}:/data" \
        "$IMAGE" \
        import \
        --endpoint "$STORAGE_PATH" \
        --namespace spike008 \
        --database "$DB" \
        --username root \
        --password root \
        "/work/database/import/chunks/$(basename "$seed_file")"
    done
    ;;
  surreal-import)
    import_live_file "${LOAD_PROJECT_DIR}/database/import/data.surql"
    ;;
  surreal-import-chunks)
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
    ;;
  http-seed-parallel)
    SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
    BENCH_DB_NAME="$DB" \
    BENCH_LOAD_PROJECT_DIR="$LOAD_PROJECT_DIR" \
    pnpm exec tsx benchmarks/load-seed-files.ts
    ;;
  surrealkit-seed)
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
      seed
    ;;
  *)
    echo "Unknown BENCH_LOAD_METHOD: $LOAD_METHOD" >&2
    exit 2
    ;;
esac
loaded_at="$(date +%s)"

if [[ "$DEFER_INDEXES" == "1" ]]; then
  if [[ "$LOAD_METHOD" == "surreal-import-embedded" || "$LOAD_METHOD" == "surreal-import-embedded-chunks" ]]; then
    if [[ "$INDEX_IMPORT_MODE" == "split" ]]; then
      for index_file in "${LOAD_PROJECT_DIR}"/database/import/indexes/*.surql; do
        docker run --rm \
          --user "0:0" \
          --volume "${LOAD_PROJECT_DIR}:/work" \
          --volume "${VOLUME}:/data" \
          "$IMAGE" \
          import \
          --endpoint "$STORAGE_PATH" \
          --namespace spike008 \
          --database "$DB" \
          --username root \
          --password root \
          "/work/database/import/indexes/$(basename "$index_file")"
      done
    else
      docker run --rm \
        --user "0:0" \
        --volume "${LOAD_PROJECT_DIR}:/work" \
        --volume "${VOLUME}:/data" \
        "$IMAGE" \
        import \
        --endpoint "$STORAGE_PATH" \
        --namespace spike008 \
        --database "$DB" \
        --username root \
        --password root \
        /work/database/import/indexes.surql
    fi
  else
    for index_file in "${LOAD_PROJECT_DIR}"/database/import/indexes/*.surql; do
      import_live_file "$index_file"
    done
  fi
fi
indexed_at="$(date +%s)"

if [[ "$LOAD_METHOD" == "surreal-import-embedded" || "$LOAD_METHOD" == "surreal-import-embedded-chunks" ]]; then
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
    "$STORAGE_PATH" >/dev/null

  until curl --silent --fail \
    --user root:root \
    --header "Surreal-NS: spike008" \
    --header "Surreal-DB: $DB" \
    --header "Accept: application/json" \
    --data-binary "INFO FOR DB;" \
    "http://127.0.0.1:${PORT}/sql" >/dev/null; do
    sleep 1
  done
fi

SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_BENCH_STORAGE="Docker ${IMAGE} with persisted ${STORAGE_ENGINE} volume ${VOLUME}; schema applied by ${LOAD_METHOD}; data loaded by ${LOAD_METHOD}; deferred indexes ${DEFER_INDEXES}; index import mode ${INDEX_IMPORT_MODE}" \
BENCH_SKIP_SEED=1 \
BENCH_DB_NAME="$DB" \
BENCH_LOAD_METHOD="$LOAD_METHOD" \
BENCH_LOAD_GENERATE_SECONDS="$((generated_at - generated_started_at))" \
BENCH_LOAD_DB_READY_SECONDS="$((ready_at - started_at))" \
BENCH_LOAD_SCHEMA_SECONDS="$((synced_at - ready_at))" \
BENCH_LOAD_DATA_SECONDS="$((loaded_at - synced_at))" \
BENCH_LOAD_INDEX_SECONDS="$((indexed_at - loaded_at))" \
BENCH_LOAD_SECONDS="$((indexed_at - started_at))" \
pnpm run benchmark
