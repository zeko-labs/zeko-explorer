#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SPIKE008_DOCKER_IMAGE:-surrealdb/surrealdb:v2.4.0}"
CONTAINER="${SPIKE008_DOCKER_CONTAINER:-spike-008-surrealdb-benchmark}"
VOLUME="${SPIKE008_DOCKER_VOLUME:-spike-008-surrealdb-benchmark-data}"
PORT="${SPIKE008_DOCKER_PORT:-8129}"
DB="${BENCH_DB_NAME:-bench_import}"
REPORT_DIR="${SPIKE008_REPORT_DIR:-$(pwd)/reports}"
IMPORT_FILE="${BENCH_IMPORT_FILE:-${REPORT_DIR}/benchmark-import.surql}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}

cleanup
trap cleanup EXIT

mkdir -p "$REPORT_DIR"
BENCH_IMPORT_FILE="$IMPORT_FILE" pnpm run benchmark:generate-import

docker volume create "$VOLUME" >/dev/null
docker run \
  --detach \
  --name "$CONTAINER" \
  --user "0:0" \
  --publish "127.0.0.1:${PORT}:8000" \
  --volume "${VOLUME}:/data" \
  --volume "${REPORT_DIR}:/import:ro" \
  "$IMAGE" \
  start \
  --no-banner \
  --bind "0.0.0.0:8000" \
  --username root \
  --password root \
  "surrealkv:/data/benchmark.db" >/dev/null

started_at="$(date +%s)"
until curl --silent --fail \
  --user root:root \
  --header "Surreal-NS: spike008" \
  --header "Surreal-DB: $DB" \
  --header "Accept: application/json" \
  --data-binary "INFO FOR DB;" \
  "http://127.0.0.1:${PORT}/sql" >/dev/null; do
  sleep 1
done

docker exec "$CONTAINER" /surreal import --endpoint "http://127.0.0.1:8000" --username root --password root --namespace spike008 --database "$DB" "/import/$(basename "$IMPORT_FILE")"
imported_at="$(date +%s)"

SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_BENCH_STORAGE="Docker ${IMAGE} with persisted surrealkv volume ${VOLUME}" \
BENCH_SKIP_SEED=1 \
BENCH_DB_NAME="$DB" \
BENCH_IMPORTED_SEED_SECONDS="$((imported_at - started_at))" \
pnpm run benchmark
