import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { surrealKitDir } from "../lib/surreal-client.ts";

const execFileAsync = promisify(execFile);

type BenchmarkConfig = {
  readonly accounts: number;
  readonly transactions: number;
  readonly bridgeOperations: number;
  readonly contractAccounts: number;
  readonly chunkRows: number;
  readonly insertBatchRows: number;
  readonly activityStride: number;
};

const benchmarkNamespace = process.env.BENCH_NS_NAME ?? "spike008";
const benchmarkDatabase = process.env.BENCH_DB_NAME ?? "bench_surrealkit";
const endpoint = process.env.SPIKE008_SURREAL_ENDPOINT ?? "http://127.0.0.1:8130";
const surrealBin = process.env.SPIKE008_SURREAL_BIN ?? `${process.env.HOME}/.cache/zeko-explorer/surreal-v3.0.5/surreal`;
const workDir = process.env.BENCH_STREAM_WORK_DIR ?? path.join(surrealKitDir, "..", "harness", "reports", "stream-load");

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
    chunkRows: intEnv("BENCH_SEED_CHUNK_ROWS", 20_000),
    insertBatchRows: intEnv("BENCH_INSERT_BATCH_ROWS", 1_000),
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

function accountKey(index: number): string {
  return ulid("A", index);
}

function accountPublicKey(index: number): string {
  return `B62qBenchAccount${index.toString(36).padStart(8, "0")}`;
}

function txId(index: number): string {
  return `transaction:[${0 - index}, 0, "bench-tx-${index}"]`;
}

function txKey(index: number): string {
  return `[${0 - index}, 0, ${q(`bench-tx-${index}`)}]`;
}

function activityKey(index: number): string {
  return ulid("C", index);
}

function eventKey(index: number): string {
  return ulid("E", index);
}

function actionKey(index: number): string {
  return ulid("Z", index);
}

function bridgeKey(index: number): string {
  return ulid("O", index);
}

function isoMinute(day: number, index: number): string {
  const hour = Math.floor(index / 60) % 24;
  const minute = index % 60;
  return `2026-05-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
}

function q(value: string): string {
  return JSON.stringify(value);
}

function d(value: string): string {
  return `d${q(value)}`;
}

async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

class BulkInsertWriter {
  private batchRows = 0;
  private wroteAnyRow = false;

  constructor(
    private readonly stream: NodeJS.WritableStream,
    private readonly table: string,
    private readonly maxBatchRows: number,
    private readonly relation = false
  ) {}

  get isEmpty(): boolean {
    return !this.wroteAnyRow;
  }

  async row(value: string): Promise<void> {
    if (this.batchRows === 0) {
      await writeLine(this.stream, `${this.relation ? "INSERT RELATION INTO" : "INSERT INTO"} ${this.table} [`);
    } else {
      await writeLine(this.stream, ",");
    }
    if (!this.stream.write(value)) await once(this.stream, "drain");
    this.batchRows += 1;
    this.wroteAnyRow = true;
    if (this.batchRows >= this.maxBatchRows) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.batchRows === 0) return;
    await writeLine(this.stream, "\n];");
    this.batchRows = 0;
  }

  async close(): Promise<void> {
    await this.flush();
    this.stream.end();
    await once(this.stream, "finish");
  }
}

async function openWriter(filePath: string, table: string, maxBatchRows: number, relation = false): Promise<BulkInsertWriter> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  await writeLine(stream, "OPTION IMPORT;");
  await writeLine(stream, "-- Generated streaming benchmark load chunk.");
  return new BulkInsertWriter(stream, table, maxBatchRows, relation);
}

async function importFile(filePath: string): Promise<void> {
  await execFileAsync(surrealBin, [
    "import",
    "--log",
    "none",
    "--endpoint",
    endpoint,
    "--namespace",
    benchmarkNamespace,
    "--database",
    benchmarkDatabase,
    "--username",
    "root",
    "--password",
    "root",
    filePath
  ], { maxBuffer: 1024 * 1024 * 32 });
}

async function importAndDelete(filePath: string): Promise<void> {
  await importFile(filePath);
  await rm(filePath, { force: true });
}

async function writeImportDelete(
  fileName: string,
  table: string,
  config: BenchmarkConfig,
  fill: (writer: BulkInsertWriter) => Promise<void>,
  relation = false
): Promise<void> {
  const filePath = path.join(workDir, fileName);
  const writer = await openWriter(filePath, table, config.insertBatchRows, relation);
  await fill(writer);
  await writer.close();
  if (writer.isEmpty) {
    await rm(filePath, { force: true });
    return;
  }
  console.log(`[benchmark-stream-load] import ${fileName}`);
  await importAndDelete(filePath);
}

function progress(label: string, current: number, total: number, start: number): void {
  if (current === 0 || current === total || current % 100_000 === 0) {
    const elapsed = (performance.now() - start) / 1000;
    const rate = elapsed > 0 ? current / elapsed : 0;
    console.log(`[benchmark-stream-load] ${label}: ${current.toLocaleString()}/${total.toLocaleString()} (${rate.toFixed(0)} rows/s)`);
  }
}

async function streamLoad(config: BenchmarkConfig): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const start = performance.now();
  const contractCount = Math.min(config.contractAccounts, config.accounts);

  const schema = await readFile(path.join(surrealKitDir, "database", "schema", "000_schema.surql"), "utf8");
  const schemaFile = path.join(workDir, "000-schema.surql");
  await writeFile(schemaFile, `OPTION IMPORT;\n${schema}\n`, "utf8");
  console.log("[benchmark-stream-load] import schema");
  await importAndDelete(schemaFile);

  for (let chunkStart = 0, chunkIndex = 0; chunkStart < config.accounts; chunkStart += config.chunkRows, chunkIndex += 1) {
    const chunkEnd = Math.min(config.accounts, chunkStart + config.chunkRows);
    await writeImportDelete(`10000-accounts-${chunkIndex.toString().padStart(5, "0")}.surql`, "account", config, async (writer) => {
      for (let i = chunkStart; i < chunkEnd; i += 1) {
        const publicKey = accountPublicKey(i);
        const searchMarker = i % 1000 === 0 ? "benchsearchaccount" : "benchaccount";
        await writer.row(`{ id: ${q(accountKey(i))}, public_key: ${q(publicKey)}, balance: ${q(String(1_000_000_000 - i))}, nonce: ${i % 100}, last_activity_height: ${1000 + i}, last_activity_at: ${d(isoMinute(1, i))}, search_text: ${q(`${publicKey} ${searchMarker}`)} }`);
        progress("accounts", i + 1, config.accounts, start);
      }
    });
  }

  await writeImportDelete("20000-batch-00000.surql", "batch", config, async (writer) => {
    await writer.row(`{ id: ${q(ulid("B", 1))}, batch_height: 1, sort_batch_height: -1, first_tx_height: 1, last_tx_height: ${config.transactions}, transaction_count: ${config.transactions}, proof_status: "proved", settlement_status: "settling", da_status: "attested" }`);
  });

  for (let chunkStart = 1, chunkIndex = 0; chunkStart <= config.transactions; chunkStart += config.chunkRows, chunkIndex += 1) {
    const chunkEnd = Math.min(config.transactions, chunkStart + config.chunkRows - 1);
    await writeImportDelete(`30000-transactions-${chunkIndex.toString().padStart(5, "0")}.surql`, "transaction", config, async (writer) => {
      for (let i = chunkStart; i <= chunkEnd; i += 1) {
        const sender = accountId(i % config.accounts);
        const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
        const senderPublicKey = accountPublicKey(i % config.accounts);
        const receiverPublicKey = i % 5 === 0 ? accountPublicKey(i % contractCount) : accountPublicKey((i + 1) % config.accounts);
        const txHash = `bench-tx-${i}`;
        const timestamp = isoMinute(2, i);
        const txType = i % 3 === 0 ? "zkapp_command" : "payment";
        const txSearchText = i % 1000 === 0 ? `, search_text: ${q(`benchsearchtransaction memo-${i}`)}` : "";
        await writer.row(`{ id: ${txKey(i)}, hash: ${q(txHash)}, sequence_number: ${i}, type: ${q(txType)}, status: "applied", sender: ${sender}, receiver: ${receiver}, sender_public_key: ${q(senderPublicKey)}, receiver_public_key: ${q(receiverPublicKey)}, amount: ${q(String(i))}, fee: "1", nonce: ${i % 100}${txSearchText}, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, timestamp: ${d(timestamp)}, source_ledger_hash: ${q(`bench-ledger-${i - 1}`)}, target_ledger_hash: ${q(`bench-ledger-${i}`)}, batch: batch:${ulid("B", 1)} }`);
        progress("transactions", i, config.transactions, start);
      }
    });

    await writeImportDelete(`30030-account-transaction-relations-${chunkIndex.toString().padStart(5, "0")}.surql`, "account_transaction", config, async (writer) => {
      for (let i = chunkStart; i <= chunkEnd; i += 1) {
        const tx = txId(i);
        const sender = accountId(i % config.accounts);
        const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
        const senderPublicKey = accountPublicKey(i % config.accounts);
        const receiverPublicKey = i % 5 === 0 ? accountPublicKey(i % contractCount) : accountPublicKey((i + 1) % config.accounts);
        await writer.row(`{ in: ${tx}, out: ${sender}, role: "sender", account_public_key: ${q(senderPublicKey)}, sort_block_height: ${0 - i}, sort_tx_index: 0 }`);
        await writer.row(`{ in: ${tx}, out: ${receiver}, role: "receiver", account_public_key: ${q(receiverPublicKey)}, sort_block_height: ${0 - i}, sort_tx_index: 0 }`);
      }
    }, true);

    await writeImportDelete(`30040-account-activity-${chunkIndex.toString().padStart(5, "0")}.surql`, "account_activity", config, async (writer) => {
      for (let i = chunkStart; i <= chunkEnd; i += 1) {
        if (i % config.activityStride !== 0) continue;
        const sender = accountId(i % config.accounts);
        await writer.row(`{ id: ${q(activityKey(i))}, account: ${sender}, transaction: ${txId(i)}, role: "sender", block_height: ${i}, tx_index: 0, activity_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_activity_index: 0, timestamp: ${d(isoMinute(2, i))}, balance_before: "1000", balance_after: "999", target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
      }
    });

    await writeImportDelete(`30050-zkapp-events-${chunkIndex.toString().padStart(5, "0")}.surql`, "zkapp_event", config, async (writer) => {
      for (let i = chunkStart; i <= chunkEnd; i += 1) {
        if (i % 100 !== 0) continue;
        const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
        await writer.row(`{ id: ${q(eventKey(i))}, transaction: ${txId(i)}, transaction_hash: ${q(`bench-tx-${i}`)}, emitting_account: ${receiver}, event_index: 0, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_event_index: 0, timestamp: ${d(isoMinute(2, i))}, fields: [${q(String(i))}, ${q(String(i + 1))}], sequence_number: ${i}, target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
      }
    });

    await writeImportDelete(`30060-zkapp-actions-${chunkIndex.toString().padStart(5, "0")}.surql`, "zkapp_action", config, async (writer) => {
      for (let i = chunkStart; i <= chunkEnd; i += 1) {
        if (i % 100 !== 0) continue;
        const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
        await writer.row(`{ id: ${q(actionKey(i))}, transaction: ${txId(i)}, transaction_hash: ${q(`bench-tx-${i}`)}, emitting_account: ${receiver}, action_index: 0, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_action_index: 0, timestamp: ${d(isoMinute(2, i))}, fields: [${q(String(i + 2))}, ${q(String(i + 3))}], before_action_state: ${q(`bench-action-${i - 1}`)}, action_state: ${q(`bench-action-${i}`)}, sequence_number: ${i}, target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
      }
    });
  }

  for (let chunkStart = 0, chunkIndex = 0; chunkStart < config.bridgeOperations; chunkStart += config.chunkRows, chunkIndex += 1) {
    const chunkEnd = Math.min(config.bridgeOperations, chunkStart + config.chunkRows);
    await writeImportDelete(`40000-bridges-${chunkIndex.toString().padStart(5, "0")}.surql`, "bridge_operation", config, async (writer) => {
      for (let i = chunkStart; i < chunkEnd; i += 1) {
        const aux = `bench-aux-${Math.floor(i / 3)}`;
        const submitBlockHeight = 5_000 + i;
        const quality = i % 7 === 0 ? "partial" : "complete";
        const sender = accountPublicKey(i % config.accounts);
        const recipient = accountPublicKey((i + 1) % config.accounts);
        const bridgeSearchMarker = i % 1000 === 0 ? "benchsearchbridge" : "benchbridge";
        const bridgeType = i % 2 === 0 ? "deposit" : "withdrawal";
        const bridgeStatus = i % 5 === 0 ? "submitted" : "completed";
        await writer.row(`{ id: ${q(bridgeKey(i))}, type: ${q(bridgeType)}, status: ${q(bridgeStatus)}, aux: ${q(aux)}, aux_sequence: ${i % 3}, sender: ${q(sender)}, recipient: ${q(recipient)}, amount: ${q(String(i))}, search_text: ${q(`${aux} ${sender} ${recipient} ${bridgeSearchMarker}`)}, data_quality: ${q(quality)}, data_quality_reasons: ${quality === "partial" ? `[${q("historical_bridge_events_unavailable")}]` : "NONE"}, submit_tx_hash: ${q(`bench-submit-${i}`)}, submit_block_height: ${submitBlockHeight}, sort_submit_block_height: ${0 - submitBlockHeight}, submit_timestamp: ${d(isoMinute(3, i))} }`);
        progress("bridge_operations", i + 1, config.bridgeOperations, start);
      }
    });
  }
}

await streamLoad(configFromEnv());
