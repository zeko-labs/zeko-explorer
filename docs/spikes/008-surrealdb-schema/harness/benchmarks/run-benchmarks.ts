import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { datetime, queryFile, seedSqlWithSurrealKit, spikeDir, startSurreal, stopSurreal, syncSchema, record, type SurrealParam } from "../lib/surreal-client.ts";

type BenchmarkConfig = {
  readonly accounts: number;
  readonly transactions: number;
  readonly bridgeOperations: number;
  readonly contractAccounts: number;
  readonly batchSize: number;
  readonly iterations: number;
  readonly activityStride: number;
};

type BenchmarkResult = {
  readonly query: string;
  readonly iterations: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  readonly budget_p95_ms: number;
  readonly passed: boolean;
};

const queryBudgets: Readonly<Record<string, number>> = {
  "transaction-feed-first-page": 250,
  "transaction-feed": 250,
  "transaction-by-hash": 100,
  "account-by-public-key": 100,
  "bridge-operation-by-natural-key": 100,
  "transaction-detail-by-hash": 250,
  "account-transaction-feed-first-page": 250,
  "account-transaction-feed": 250,
  "transactions-by-sender-first-page": 250,
  "transactions-by-receiver-first-page": 250,
  "transactions-by-sender": 250,
  "account-activity-first-page": 250,
  "account-activity-feed": 250,
  "zkapp-events-first-page": 250,
  "zkapp-events-by-account": 250,
  "zkapp-actions-first-page": 250,
  "zkapp-actions-by-account": 250,
  "bridge-operations-by-sender-first-page": 250,
  "bridge-operations-by-sender": 250,
  "bridge-quality-issues-first-page": 250,
  "bridge-quality-issues-by-reason": 250,
  "batch-feed-first-page": 100,
  "transactions-search-text": 250,
  "accounts-search-text": 250,
  "bridge-operations-search-text": 250,
  "network-throughput-by-minute": 500
};

const db = process.env.BENCH_DB_NAME ?? `bench_${Date.now()}`;
const storageDescription = process.env.SPIKE008_BENCH_STORAGE ?? (process.env.SPIKE008_SURREAL_ENDPOINT === undefined ? "in-memory local process" : "external SurrealDB endpoint");
const skipSeed = process.env.BENCH_SKIP_SEED === "1";
const loadMethod = process.env.BENCH_LOAD_METHOD ?? "local-fixture-seed";
const importedLoadSeconds =
  process.env.BENCH_LOAD_SECONDS === undefined
    ? undefined
    : Number(process.env.BENCH_LOAD_SECONDS);
const loadBreakdown = {
  generate: process.env.BENCH_LOAD_GENERATE_SECONDS === undefined ? undefined : Number(process.env.BENCH_LOAD_GENERATE_SECONDS),
  dbReady: process.env.BENCH_LOAD_DB_READY_SECONDS === undefined ? undefined : Number(process.env.BENCH_LOAD_DB_READY_SECONDS),
  schema: process.env.BENCH_LOAD_SCHEMA_SECONDS === undefined ? undefined : Number(process.env.BENCH_LOAD_SCHEMA_SECONDS),
  data: process.env.BENCH_LOAD_DATA_SECONDS === undefined ? undefined : Number(process.env.BENCH_LOAD_DATA_SECONDS),
  indexes: process.env.BENCH_LOAD_INDEX_SECONDS === undefined ? undefined : Number(process.env.BENCH_LOAD_INDEX_SECONDS)
};

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function configFromEnv(): BenchmarkConfig {
  return {
    accounts: intEnv("BENCH_ACCOUNT_COUNT", 20_000),
    transactions: intEnv("BENCH_TX_COUNT", 100_000),
    bridgeOperations: intEnv("BENCH_BRIDGE_COUNT", 100_000),
    contractAccounts: intEnv("BENCH_CONTRACT_ACCOUNT_COUNT", 100),
    batchSize: intEnv("BENCH_BATCH_SIZE", 1_000),
    iterations: intEnv("BENCH_ITERATIONS", 50),
    activityStride: intEnv("BENCH_ACTIVITY_STRIDE", 1)
  };
}

function ulid(prefix: string, index: number): string {
  const body = `${prefix}${index.toString(36).toUpperCase()}`.padStart(23, "0").slice(-23);
  return `01J${body}`;
}

function accountId(index: number): string {
  return `account:${ulid("A", index)}`;
}

function txId(index: number): string {
  return `transaction:[${0 - index}, 0, "bench-tx-${index}"]`;
}

function activityId(index: number): string {
  return `account_activity:${ulid("C", index)}`;
}

function bridgeId(index: number): string {
  return `bridge_operation:${ulid("O", index)}`;
}

function eventId(index: number): string {
  return `zkapp_event:${ulid("E", index)}`;
}

function actionId(index: number): string {
  return `zkapp_action:${ulid("Z", index)}`;
}

function accountPublicKey(index: number): string {
  return `B62qBenchAccount${index.toString(36).padStart(8, "0")}`;
}

function isoMinute(day: number, index: number): string {
  const hour = Math.floor(index / 60) % 24;
  const minute = index % 60;
  return `2026-05-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
}

function flush(statements: string[], chunks: string[]): void {
  if (statements.length === 0) return;
  chunks.push(statements.join("\n"));
  statements.length = 0;
}

function progress(label: string, current: number, total: number, start: number): void {
  if (current === 0 || current === total || current % 100_000 === 0) {
    const elapsed = (performance.now() - start) / 1000;
    const rate = elapsed > 0 ? current / elapsed : 0;
    console.log(`[seed] ${label}: ${current.toLocaleString()}/${total.toLocaleString()} (${rate.toFixed(0)} rows/s)`);
  }
}

async function seedBenchmarkData(config: BenchmarkConfig): Promise<void> {
  const statements: string[] = [];
  const chunks: string[] = [];
  const start = performance.now();
  const contractCount = Math.min(config.contractAccounts, config.accounts);
  const profileAccountIndex = Math.min(config.activityStride % 5 === 0 ? config.activityStride : 0, config.accounts - 1);

  for (let i = 0; i < config.accounts; i += 1) {
    const publicKey = accountPublicKey(i);
    const searchMarker = i % 1000 === 0 ? "benchsearchaccount" : "benchaccount";
    statements.push(`CREATE ${accountId(i)} SET public_key = "${publicKey}", balance = "${1_000_000_000 - i}", nonce = ${i % 100}, last_activity_height = ${1000 + i}, last_activity_at = d"${isoMinute(1, i)}", search_text = "${publicKey} ${searchMarker}" RETURN NONE;`);
    if (statements.length >= config.batchSize) flush(statements, chunks);
    progress("accounts", i + 1, config.accounts, start);
  }

  statements.push(`CREATE batch:${ulid("B", 1)} SET batch_height = 1, sort_batch_height = -1, first_tx_height = 1, last_tx_height = ${config.transactions}, transaction_count = ${config.transactions}, proof_status = "proved", settlement_status = "settling", da_status = "attested" RETURN NONE;`);
  flush(statements, chunks);

  for (let i = 1; i <= config.transactions; i += 1) {
    const sender = accountId(i % config.accounts);
    const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
    const senderPublicKey = accountPublicKey(i % config.accounts);
    const receiverPublicKey = i % 5 === 0 ? accountPublicKey(i % contractCount) : accountPublicKey((i + 1) % config.accounts);
    const tx = txId(i);
    const txHash = `bench-tx-${i}`;
    const timestamp = isoMinute(2, i);
    const txSearchText = i % 1000 === 0 ? `, search_text = "benchsearchtransaction memo-${i}"` : "";
    statements.push(`CREATE ${tx} SET hash = "${txHash}", sequence_number = ${i}, type = "${i % 3 === 0 ? "zkapp_command" : "payment"}", status = "applied", sender = ${sender}, receiver = ${receiver}, sender_public_key = "${senderPublicKey}", receiver_public_key = "${receiverPublicKey}", amount = "${i}", fee = "1", nonce = ${i % 100}${txSearchText}, block_height = ${i}, tx_index = 0, sort_block_height = ${0 - i}, sort_tx_index = 0, timestamp = d"${timestamp}", source_ledger_hash = "bench-ledger-${i - 1}", target_ledger_hash = "bench-ledger-${i}", batch = batch:${ulid("B", 1)} RETURN NONE;`);
    statements.push(`RELATE ${tx}->account_transaction->${sender} SET role = "sender", account_public_key = "${senderPublicKey}", sort_block_height = ${0 - i}, sort_tx_index = 0 RETURN NONE;`);
    statements.push(`RELATE ${tx}->account_transaction->${receiver} SET role = "receiver", account_public_key = "${receiverPublicKey}", sort_block_height = ${0 - i}, sort_tx_index = 0 RETURN NONE;`);
    if (i % config.activityStride === 0) {
      statements.push(`CREATE ${activityId(i)} SET account = ${sender}, transaction = ${tx}, role = "sender", block_height = ${i}, tx_index = 0, activity_index = 0, sort_block_height = ${0 - i}, sort_tx_index = 0, sort_activity_index = 0, timestamp = d"${timestamp}", balance_before = "1000", balance_after = "999", target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
    }
    if (i % 100 === 0) {
      statements.push(`CREATE ${eventId(i)} SET transaction = ${tx}, transaction_hash = "${txHash}", emitting_account = ${receiver}, event_index = 0, block_height = ${i}, tx_index = 0, sort_block_height = ${0 - i}, sort_tx_index = 0, sort_event_index = 0, timestamp = d"${timestamp}", fields = ["${i}", "${i + 1}"], sequence_number = ${i}, target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
      statements.push(`CREATE ${actionId(i)} SET transaction = ${tx}, transaction_hash = "${txHash}", emitting_account = ${receiver}, action_index = 0, block_height = ${i}, tx_index = 0, sort_block_height = ${0 - i}, sort_tx_index = 0, sort_action_index = 0, timestamp = d"${timestamp}", fields = ["${i + 2}", "${i + 3}"], before_action_state = "bench-action-${i - 1}", action_state = "bench-action-${i}", sequence_number = ${i}, target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
    }
    if (statements.length >= config.batchSize) flush(statements, chunks);
    progress("transactions + account_activity", i, config.transactions, start);
  }
  flush(statements, chunks);

  for (let i = 0; i < config.bridgeOperations; i += 1) {
    const aux = `bench-aux-${Math.floor(i / 3)}`;
    const submitBlockHeight = 5_000 + i;
    const quality = i % 7 === 0 ? "partial" : "complete";
    const sender = accountPublicKey(i % config.accounts);
    const recipient = accountPublicKey((i + 1) % config.accounts);
    const bridge = bridgeId(i);
    const bridgeSearchMarker = i % 1000 === 0 ? "benchsearchbridge" : "benchbridge";
    statements.push(`CREATE ${bridge} SET type = "${i % 2 === 0 ? "deposit" : "withdrawal"}", status = "${i % 5 === 0 ? "submitted" : "completed"}", aux = "${aux}", aux_sequence = ${i % 3}, sender = "${sender}", recipient = "${recipient}", amount = "${i}", search_text = "${aux} ${sender} ${recipient} ${bridgeSearchMarker}", data_quality = "${quality}", data_quality_reasons = ${quality === "partial" ? "[\"historical_bridge_events_unavailable\"]" : "NONE"}, submit_tx_hash = "bench-submit-${i}", submit_block_height = ${submitBlockHeight}, sort_submit_block_height = ${0 - submitBlockHeight}, submit_timestamp = d"${isoMinute(3, i)}" RETURN NONE;`);
    if (statements.length >= config.batchSize) flush(statements, chunks);
    progress("bridge_operations", i + 1, config.bridgeOperations, start);
  }
  flush(statements, chunks);
  await seedSqlWithSurrealKit(db, chunks.join("\n"));
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  if (value === undefined) throw new Error("Cannot calculate percentile of empty sample");
  return value;
}

async function measure(name: string, params: Readonly<Record<string, SurrealParam>>, iterations: number): Promise<BenchmarkResult> {
  console.error(`[bench] ${name}: start`);
  const durations: number[] = [];
  await queryFile(db, name, params);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await queryFile(db, name, params);
    durations.push(performance.now() - start);
  }
  const p95 = percentile(durations, 0.95);
  const budget = queryBudgets[name] ?? 250;
  console.error(`[bench] ${name}: p95=${p95.toFixed(3)}ms max=${Math.max(...durations).toFixed(3)}ms`);
  return {
    query: name,
    iterations,
    min_ms: Math.min(...durations),
    p50_ms: percentile(durations, 0.5),
    p95_ms: p95,
    max_ms: Math.max(...durations),
    budget_p95_ms: budget,
    passed: p95 <= budget
  };
}

function benchmarkText(config: BenchmarkConfig, results: readonly BenchmarkResult[], elapsedSeedSeconds: number): string {
  const accountActivityRows = Math.floor(config.transactions / config.activityStride);
  const breakdown = loadBreakdown.data === undefined
    ? []
    : [
        "",
        `Load breakdown: benchmark data generation ${loadBreakdown.generate?.toFixed(2)}s, database ready ${loadBreakdown.dbReady?.toFixed(2)}s, schema apply/import ${loadBreakdown.schema?.toFixed(2)}s, ${loadMethod} data load ${loadBreakdown.data.toFixed(2)}s, index build ${loadBreakdown.indexes?.toFixed(2)}s.`
      ];
  return [
    "# Spike 008 Benchmark Results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Dataset: ${config.accounts.toLocaleString()} accounts (${config.contractAccounts.toLocaleString()} high-volume contract accounts), ${config.transactions.toLocaleString()} transactions, ${accountActivityRows.toLocaleString()} account activity rows, ${config.bridgeOperations.toLocaleString()} bridge operations.`,
    `Load time: ${elapsedSeedSeconds.toFixed(2)}s. SurrealDB: ${storageDescription}. Query runner: Node.js over SurrealDB HTTP SQL API after data is already loaded.`,
    ...breakdown,
    "",
    "| Query | Iterations | min ms | p50 ms | p95 ms | budget p95 ms | max ms | pass |",
    "|---|---:|---:|---:|---:|---:|---:|:---:|",
    ...results.map((r) => `| ${r.query} | ${r.iterations} | ${r.min_ms.toFixed(3)} | ${r.p50_ms.toFixed(3)} | ${r.p95_ms.toFixed(3)} | ${r.budget_p95_ms.toFixed(0)} | ${r.max_ms.toFixed(3)} | ${r.passed ? "yes" : "no"} |`)
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function benchmarkHtml(config: BenchmarkConfig, results: readonly BenchmarkResult[], elapsedSeedSeconds: number): string {
  const accountActivityRows = Math.floor(config.transactions / config.activityStride);
  const breakdown = loadBreakdown.data === undefined
    ? ""
    : `<p>Load breakdown: benchmark data generation ${loadBreakdown.generate?.toFixed(2)}s, database ready ${loadBreakdown.dbReady?.toFixed(2)}s, schema apply/import ${loadBreakdown.schema?.toFixed(2)}s, ${escapeHtml(loadMethod)} data load ${loadBreakdown.data.toFixed(2)}s, index build ${loadBreakdown.indexes?.toFixed(2)}s.</p>`;
  const rows = results.map((r) => `
        <tr>
          <td><code>${escapeHtml(r.query)}</code></td>
          <td>${r.iterations}</td>
          <td>${r.min_ms.toFixed(3)}</td>
          <td>${r.p50_ms.toFixed(3)}</td>
          <td>${r.p95_ms.toFixed(3)}</td>
          <td>${r.budget_p95_ms.toFixed(0)}</td>
          <td>${r.max_ms.toFixed(3)}</td>
          <td>${r.passed ? "PASS" : "FAIL"}</td>
        </tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spike 008 Benchmark Results</title>
  <style>
    body { margin: 0; padding: 24px; background: #f6f8fb; color: #17202a; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1080px; margin: 0 auto; }
    header, section { background: #fff; border: 1px solid #d9dee5; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 14px 38px rgba(31, 41, 55, .08); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
    .stat { border: 1px solid #d9dee5; border-radius: 8px; padding: 12px; }
    .stat b { display: block; color: #2563eb; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #d9dee5; padding: 9px 10px; text-align: left; }
    th { color: #5c6670; text-transform: uppercase; font-size: 12px; }
    code { background: #eef2f7; border-radius: 5px; padding: 1px 4px; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Spike 008 Benchmark Results</h1>
    <p>Generated: ${new Date().toISOString()}</p>
    <div class="stats">
      <div class="stat"><b>${config.transactions.toLocaleString()}</b>transactions</div>
      <div class="stat"><b>${accountActivityRows.toLocaleString()}</b>account activity rows</div>
      <div class="stat"><b>${config.accounts.toLocaleString()}</b>accounts</div>
      <div class="stat"><b>${config.bridgeOperations.toLocaleString()}</b>bridge operations</div>
      <div class="stat"><b>${elapsedSeedSeconds.toFixed(2)}s</b>load time</div>
    </div>
    <p>SurrealDB: ${escapeHtml(storageDescription)}. Query runner: Node.js over SurrealDB HTTP SQL API after data is already loaded.</p>
    ${breakdown}
  </header>
  <section>
    <table>
      <thead><tr><th>Query</th><th>Iterations</th><th>min ms</th><th>p50 ms</th><th>p95 ms</th><th>budget p95 ms</th><th>max ms</th><th>pass</th></tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>
`;
}

const config = configFromEnv();
if (!skipSeed && config.transactions > 100_000) {
  throw new Error("Large benchmark datasets must be loaded with pnpm run benchmark:docker:persisted so row loading uses the official persisted loader, not the local smoke benchmark runner.");
}
const profileAccountIndex = Math.min(config.activityStride % 5 === 0 ? config.activityStride : 0, config.accounts - 1);
const latestZkappTx = Math.floor(config.transactions / 100) * 100;
const zkappCursorTx = Math.max(100, latestZkappTx - 2_400);
await startSurreal();
try {
  let elapsedSeedSeconds = 0;
  if (skipSeed) {
    if (importedLoadSeconds !== undefined && Number.isFinite(importedLoadSeconds)) elapsedSeedSeconds = importedLoadSeconds;
  } else {
    await syncSchema(db);
    const seedStart = performance.now();
    await seedBenchmarkData(config);
    elapsedSeedSeconds = (performance.now() - seedStart) / 1000;
  }

  const results = [
    await measure("transaction-feed-first-page", { from_sort_block_height: 0 - config.transactions, limit: 25 }, config.iterations),
    await measure("transaction-feed", {
      after_sort_block_height: 0 - (config.transactions - 24),
      after_sort_tx_index: 0,
      after_hash: `bench-tx-${config.transactions - 24}`,
      limit: 25
    }, config.iterations),
    await measure("transaction-by-hash", { hash: `bench-tx-${Math.floor(config.transactions * 0.8)}` }, config.iterations),
    await measure("account-by-public-key", { public_key: accountPublicKey(profileAccountIndex) }, config.iterations),
    await measure("bridge-operation-by-natural-key", { aux: `bench-aux-${Math.floor(Math.floor(config.bridgeOperations * 0.8) / 3)}`, aux_sequence: Math.floor(config.bridgeOperations * 0.8) % 3 }, config.iterations),
    await measure("transaction-detail-by-hash", { hash: `bench-tx-${Math.floor(config.transactions * 0.8)}`, event_limit: 25, action_limit: 25, inner_action_limit: 25 }, config.iterations),
    await measure("account-transaction-feed-first-page", { public_key: accountPublicKey(profileAccountIndex), limit: 25 }, config.iterations),
    await measure("account-transaction-feed", {
      public_key: accountPublicKey(profileAccountIndex),
      after_sort_block_height: 0 - config.transactions,
      after_sort_tx_index: 0,
      after_role: "receiver",
      after_hash: `bench-tx-${config.transactions}`,
      limit: 25
    }, config.iterations),
    await measure("transactions-by-sender-first-page", { public_key: accountPublicKey(1), limit: 25 }, config.iterations),
    await measure("transactions-by-receiver-first-page", { public_key: accountPublicKey(0), limit: 25 }, config.iterations),
    await measure("transactions-by-sender", {
      public_key: accountPublicKey(1),
      after_sort_block_height: 0 - (config.transactions + 1),
      after_sort_tx_index: -999_999,
      after_hash: "",
      limit: 25
    }, config.iterations),
    await measure("account-activity-first-page", { account: record(accountId(profileAccountIndex)), limit: 25 }, config.iterations),
    await measure("account-activity-feed", {
      account: record(accountId(profileAccountIndex)),
      after_sort_block_height: 0 - config.transactions,
      after_sort_tx_index: 0,
      after_sort_activity_index: 0,
      after_id: record(activityId(config.transactions)),
      limit: 25
    }, config.iterations),
    await measure("zkapp-events-first-page", { account: record(accountId(0)), limit: 25 }, config.iterations),
    await measure("zkapp-events-by-account", {
      account: record(accountId(0)),
      after_sort_block_height: 0 - zkappCursorTx,
      after_sort_tx_index: 0,
      after_sort_event_index: 0,
      after_id: record(eventId(zkappCursorTx)),
      limit: 25
    }, config.iterations),
    await measure("zkapp-actions-first-page", { account: record(accountId(0)), limit: 25 }, config.iterations),
    await measure("zkapp-actions-by-account", {
      account: record(accountId(0)),
      after_sort_block_height: 0 - zkappCursorTx,
      after_sort_tx_index: 0,
      after_sort_action_index: 0,
      after_id: record(actionId(zkappCursorTx)),
      limit: 25
    }, config.iterations),
    await measure("bridge-operations-by-sender-first-page", { public_key: accountPublicKey(1), limit: 25 }, config.iterations),
    await measure("bridge-operations-by-sender", {
      public_key: accountPublicKey(1),
      after_sort_submit_block_height: 0 - (5_000 + 80_001),
      after_aux: "bench-aux-26667",
      after_aux_sequence: 0,
      after_id: record(bridgeId(80_001)),
      limit: 25
    }, config.iterations),
    await measure("bridge-quality-issues-first-page", { data_quality: "partial", limit: 25 }, config.iterations),
    await measure("bridge-quality-issues-by-reason", { reason: "historical_bridge_events_unavailable", limit: 25 }, config.iterations),
    await measure("batch-feed-first-page", { limit: 25 }, config.iterations),
    await measure("transactions-search-text", { term: "benchsearchtransaction", limit: 25 }, config.iterations),
    await measure("accounts-search-text", { term: "benchsearchaccount", limit: 25 }, config.iterations),
    await measure("bridge-operations-search-text", { term: "benchsearchbridge", limit: 25 }, config.iterations),
    await measure("network-throughput-by-minute", { from: datetime("2026-05-02T00:00:00Z"), to: datetime("2026-05-03T00:00:00Z") }, config.iterations)
  ];

  const text = benchmarkText(config, results, elapsedSeedSeconds);
  const html = benchmarkHtml(config, results, elapsedSeedSeconds);
  await mkdir(path.join(spikeDir, "harness", "benchmarks"), { recursive: true });
  await writeFile(path.join(spikeDir, "harness", "benchmarks", "latest-results.html"), html);
  console.log(text);
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    throw new Error(`Benchmark p95 budget failures: ${failures.map((result) => `${result.query} p95=${result.p95_ms.toFixed(3)}ms budget=${result.budget_p95_ms}ms`).join("; ")}`);
  }
} finally {
  await stopSurreal();
}
