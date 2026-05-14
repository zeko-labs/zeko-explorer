#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SPIKE008_DOCKER_IMAGE:-surrealdb/surrealdb:v3}"
CONTAINER="${SPIKE008_DOCKER_CONTAINER:-spike-008-surrealdb-benchmark}"
VOLUME="${SPIKE008_DOCKER_VOLUME:-spike-008-surrealdb-benchmark-data}"
PORT="${SPIKE008_DOCKER_PORT:-8129}"
DB="${BENCH_DB_NAME:-bench_surrealkit}"
STORAGE_ENGINE="${BENCH_STORAGE_ENGINE:-surrealkv}"
REPORT_DIR="${SPIKE008_REPORT_DIR:-$(pwd)/reports}"
LOAD_PROJECT_DIR="${BENCH_LOAD_PROJECT_DIR:-${BENCH_SURREALKIT_PROJECT_DIR:-${REPORT_DIR}/benchmark-load}}"

case "$STORAGE_ENGINE" in
  surrealkv|rocksdb) ;;
  *)
    echo "Unknown BENCH_STORAGE_ENGINE: $STORAGE_ENGINE" >&2
    exit 2
    ;;
esac

STORAGE_PATH="${STORAGE_ENGINE}:/data/benchmark.db"

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
BENCH_WRITE_MONOLITHIC_IMPORT=1 BENCH_LOAD_PROJECT_DIR="$LOAD_PROJECT_DIR" pnpm run benchmark:generate-load
generated_at="$(date +%s)"

docker volume create "$VOLUME" >/dev/null

started_at="$(date +%s)"
docker run \
  --detach \
  --name "$CONTAINER" \
  --user "0:0" \
  --publish "127.0.0.1:${PORT}:8000" \
  --volume "${LOAD_PROJECT_DIR}:/work:ro" \
  --volume "${VOLUME}:/data" \
  "$IMAGE" \
  start \
  --no-banner \
  --bind "0.0.0.0:8000" \
  --username root \
  --password root \
  --default-namespace spike008 \
  --default-database "$DB" \
  --import-file /work/database/import/full.surql \
  "$STORAGE_PATH" >/dev/null

last_notice="$started_at"
until curl --silent --fail \
  --user root:root \
  --header "Surreal-NS: spike008" \
  --header "Surreal-DB: $DB" \
  --header "Accept: application/json" \
  --data-binary "INFO FOR DB;" \
  "http://127.0.0.1:${PORT}/sql" >/dev/null; do
  if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  now="$(date +%s)"
  if (( now - last_notice >= 30 )); then
    echo "[benchmark-load] waiting for SurrealDB start --import-file to finish (${STORAGE_ENGINE}, $((now - started_at))s elapsed)"
    last_notice="$now"
  fi
  sleep 1
done
loaded_at="$(date +%s)"

SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_BENCH_STORAGE="Docker ${IMAGE} with persisted ${STORAGE_ENGINE} volume ${VOLUME}; schema and data loaded by surreal start --import-file full.surql; full index set enabled during import" \
BENCH_SKIP_SEED=1 \
BENCH_DB_NAME="$DB" \
BENCH_LOAD_METHOD="surreal-start-import-file" \
BENCH_LOAD_GENERATE_SECONDS="$((generated_at - generated_started_at))" \
BENCH_LOAD_DB_READY_SECONDS="$((loaded_at - started_at))" \
BENCH_LOAD_SCHEMA_SECONDS=0 \
BENCH_LOAD_DATA_SECONDS="$((loaded_at - started_at))" \
BENCH_LOAD_INDEX_SECONDS=0 \
BENCH_LOAD_SECONDS="$((loaded_at - started_at))" \
pnpm run benchmark
