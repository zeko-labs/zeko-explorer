#!/usr/bin/env bash
set -euo pipefail

SURREAL_BIN="${SPIKE008_SURREAL_BIN:-${HOME}/.cache/zeko-explorer/surreal-v3.0.5/surreal}"
PORT="${SPIKE008_SURREAL_PORT:-8130}"
DB="${BENCH_DB_NAME:-bench_surrealkit}"
REPORT_DIR="${SPIKE008_REPORT_DIR:-$(pwd)/reports}"
DATA_DIR="${BENCH_HOST_DATA_DIR:-${REPORT_DIR}/host-benchmark.db}"
SERVER_PID=""

case "$REPORT_DIR" in
  /*) ;;
  *) REPORT_DIR="$(pwd)/$REPORT_DIR" ;;
esac

case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$(pwd)/$DATA_DIR" ;;
esac

if [[ ! -x "$SURREAL_BIN" ]]; then
  echo "SurrealDB v3 binary not found or not executable: $SURREAL_BIN" >&2
  exit 2
fi

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "${BENCH_KEEP_DATA:-0}" != "1" ]]; then
    rm -rf "$DATA_DIR"
  fi
}

cleanup
trap cleanup EXIT

mkdir -p "$REPORT_DIR"

generated_started_at="$(date +%s)"
echo "[benchmark-load] streaming generated chunks directly into SurrealDB"
generated_at="$(date +%s)"

started_at="$(date +%s)"
"$SURREAL_BIN" start \
  --no-banner \
  --bind "127.0.0.1:${PORT}" \
  --username root \
  --password root \
  "surrealkv:${DATA_DIR}" >"${REPORT_DIR}/host-surreal.log" 2>&1 &
SERVER_PID="$!"

until curl --silent --fail \
  --user root:root \
  --header "Surreal-NS: spike008" \
  --header "Surreal-DB: $DB" \
  --header "Accept: application/json" \
  --data-binary "INFO FOR DB;" \
  "http://127.0.0.1:${PORT}/sql" >/dev/null; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    cat "${REPORT_DIR}/host-surreal.log" >&2 || true
    exit 1
  fi
  sleep 1
done
ready_at="$(date +%s)"

stream_started_at="$(date +%s)"
SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_SURREAL_BIN="$SURREAL_BIN" \
BENCH_STREAM_WORK_DIR="${REPORT_DIR}/stream-load" \
BENCH_DB_NAME="$DB" \
pnpm exec tsx benchmarks/stream-benchmark-load.ts
loaded_at="$(date +%s)"

SPIKE008_SURREAL_ENDPOINT="http://127.0.0.1:${PORT}" \
SPIKE008_BENCH_STORAGE="Host ${SURREAL_BIN} with persisted SurrealKV path ${DATA_DIR}; schema loaded by official surreal import from SurrealKit-managed schema; data streamed as bounded official surreal import chunk files; full index set enabled during import" \
BENCH_SKIP_SEED=1 \
BENCH_DB_NAME="$DB" \
BENCH_LOAD_METHOD="host-surreal-streaming-import" \
BENCH_LOAD_GENERATE_SECONDS="$((generated_at - generated_started_at))" \
BENCH_LOAD_DB_READY_SECONDS="$((ready_at - started_at))" \
BENCH_LOAD_SCHEMA_SECONDS="$((stream_started_at - ready_at))" \
BENCH_LOAD_DATA_SECONDS="$((loaded_at - stream_started_at))" \
BENCH_LOAD_INDEX_SECONDS=0 \
BENCH_LOAD_SECONDS="$((loaded_at - started_at))" \
pnpm run benchmark
