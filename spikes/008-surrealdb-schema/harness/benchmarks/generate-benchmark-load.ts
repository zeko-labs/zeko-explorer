import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { spikeDir, surrealKitDir } from "../lib/surreal-client.ts";

type BenchmarkConfig = {
  readonly accounts: number;
  readonly transactions: number;
  readonly bridgeOperations: number;
  readonly contractAccounts: number;
  readonly chunkRows: number;
  readonly insertBatchRows: number;
  readonly activityStride: number;
  readonly writeMonolithicImport: boolean;
};

const seedPreamble = "-- Generated benchmark load chunk.\n";
const benchmarkNamespace = process.env.BENCH_NS_NAME ?? "spike008";
const benchmarkDatabase = process.env.BENCH_DB_NAME ?? "bench_surrealkit";

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`${name} must be 1, 0, true, or false`);
}

function configFromEnv(): BenchmarkConfig {
  return {
    accounts: intEnv("BENCH_ACCOUNT_COUNT", 20_000),
    transactions: intEnv("BENCH_TX_COUNT", 100_000),
    bridgeOperations: intEnv("BENCH_BRIDGE_COUNT", 100_000),
    contractAccounts: intEnv("BENCH_CONTRACT_ACCOUNT_COUNT", 100),
    chunkRows: intEnv("BENCH_SEED_CHUNK_ROWS", 20_000),
    insertBatchRows: intEnv("BENCH_INSERT_BATCH_ROWS", 1_000),
    activityStride: intEnv("BENCH_ACTIVITY_STRIDE", 1),
    writeMonolithicImport: boolEnv("BENCH_WRITE_MONOLITHIC_IMPORT", false)
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

function txId(index: number): string {
  return `transaction:[${0 - index}, 0, "bench-tx-${index}"]`;
}

function txKey(index: number): string {
  return `[${0 - index}, 0, ${q(`bench-tx-${index}`)}]`;
}

function activityId(index: number): string {
  return `account_activity:${ulid("C", index)}`;
}

function activityKey(index: number): string {
  return ulid("C", index);
}

function bridgeKey(index: number): string {
  return ulid("O", index);
}

function eventId(index: number): string {
  return `zkapp_event:${ulid("E", index)}`;
}

function eventKey(index: number): string {
  return ulid("E", index);
}

function actionId(index: number): string {
  return `zkapp_action:${ulid("Z", index)}`;
}

function actionKey(index: number): string {
  return ulid("Z", index);
}

function accountPublicKey(index: number): string {
  return `B62qBenchAccount${index.toString(36).padStart(8, "0")}`;
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

function splitSchemaIndexes(schema: string): { readonly withoutIndexes: string; readonly indexes: string } {
  const withoutIndexes: string[] = [];
  const indexes: string[] = ["OPTION IMPORT;"];
  for (const line of schema.split("\n")) {
    if (/^\s*DEFINE\s+INDEX\s+/i.test(line)) {
      indexes.push(line);
    } else {
      withoutIndexes.push(line);
    }
  }
  return {
    withoutIndexes: withoutIndexes.join("\n"),
    indexes: indexes.join("\n")
  };
}

class BulkInsertWriter {
  private batchRows = 0;

  constructor(
    private readonly stream: NodeJS.WritableStream,
    private readonly table: string,
    private readonly maxBatchRows: number,
    private readonly relation = false
  ) {}

  async row(value: string): Promise<void> {
    if (this.batchRows === 0) {
      await writeLine(this.stream, `${this.relation ? "INSERT RELATION INTO" : "INSERT INTO"} ${this.table} [`);
    } else {
      await writeLine(this.stream, ",");
    }
    if (!this.stream.write(value)) await once(this.stream, "drain");
    this.batchRows += 1;
    if (this.batchRows >= this.maxBatchRows) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.batchRows === 0) return;
    await writeLine(this.stream, "\n];");
    this.batchRows = 0;
  }

  async close(): Promise<void> {
    await this.flush();
    await closeChunk(this.stream);
  }
}

async function openBulkWriter(directory: string, prefix: string, index: number, table: string, maxBatchRows: number, relation = false): Promise<BulkInsertWriter> {
  return new BulkInsertWriter(await openChunk(directory, prefix, index), table, maxBatchRows, relation);
}

function progress(label: string, current: number, total: number, start: number): void {
  if (current === 0 || current === total || current % 100_000 === 0) {
    const elapsed = (performance.now() - start) / 1000;
    const rate = elapsed > 0 ? current / elapsed : 0;
    console.log(`[benchmark-load-file] ${label}: ${current.toLocaleString()}/${total.toLocaleString()} (${rate.toFixed(0)} rows/s)`);
  }
}

async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

function chunkName(prefix: string, index: number): string {
  return `${prefix}-${index.toString().padStart(5, "0")}.surql`;
}

async function openChunk(directory: string, prefix: string, index: number): Promise<NodeJS.WritableStream> {
  const stream = createWriteStream(path.join(directory, chunkName(prefix, index)), { encoding: "utf8" });
  await writeLine(stream, seedPreamble.trimEnd());
  return stream;
}

async function closeChunk(stream: NodeJS.WritableStream): Promise<void> {
  stream.end();
  await once(stream, "finish");
}

async function appendFile(output: NodeJS.WritableStream, filePath: string): Promise<void> {
  const input = createReadStream(filePath);
  for await (const chunk of input) {
    if (!output.write(chunk)) await once(output, "drain");
  }
  await writeLine(output, "");
}

async function appendFileWithoutLeadingImportOption(output: NodeJS.WritableStream, filePath: string): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  let firstChunk = true;
  for await (const chunk of input) {
    const nextChunk = firstChunk ? chunk.replace(/^OPTION IMPORT;\r?\n/, "") : chunk;
    firstChunk = false;
    if (nextChunk.length > 0 && !output.write(nextChunk)) await once(output, "drain");
  }
  await writeLine(output, "");
}

async function writeCombinedImportFile(importDir: string, outputFile: string, inputFiles: readonly string[]): Promise<void> {
  const output = createWriteStream(path.join(importDir, outputFile), { encoding: "utf8" });
  await writeLine(output, "OPTION IMPORT;");
  await writeLine(output, `USE NS ${benchmarkNamespace} DB ${benchmarkDatabase};`);
  for (const inputFile of inputFiles) await appendFileWithoutLeadingImportOption(output, path.join(importDir, inputFile));
  await closeChunk(output);
}

async function writeImportBundle(seedDir: string, importDir: string): Promise<void> {
  await mkdir(importDir, { recursive: true });
  const output = createWriteStream(path.join(importDir, "data.surql"), { encoding: "utf8" });
  await writeLine(output, "OPTION IMPORT;");
  await writeLine(output, "-- Generated benchmark bulk import file.");
  const files = (await readdir(seedDir)).filter((file) => file.endsWith(".surql")).sort();
  for (const file of files) await appendFile(output, path.join(seedDir, file));
  await closeChunk(output);
}

async function writeImportChunks(seedDir: string, importDir: string): Promise<void> {
  const chunkDir = path.join(importDir, "chunks");
  await mkdir(chunkDir, { recursive: true });
  const files = (await readdir(seedDir)).filter((file) => file.endsWith(".surql")).sort();
  for (const file of files) {
    const output = createWriteStream(path.join(chunkDir, file), { encoding: "utf8" });
    await writeLine(output, "OPTION IMPORT;");
    await appendFile(output, path.join(seedDir, file));
    await closeChunk(output);
  }
}

function indexFileName(indexLine: string, index: number): string {
  const match = /^\s*DEFINE\s+INDEX\s+(?:OVERWRITE\s+|IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i.exec(indexLine);
  const name = match?.[1] ?? `index_${index}`;
  return `${index.toString().padStart(5, "0")}-${name}.surql`;
}

async function writeIndexImportFiles(indexesSql: string, importDir: string): Promise<void> {
  const indexDir = path.join(importDir, "indexes");
  await mkdir(indexDir, { recursive: true });
  const indexLines = indexesSql.split("\n").filter((line) => /^\s*DEFINE\s+INDEX\s+/i.test(line));
  for (let i = 0; i < indexLines.length; i += 1) {
    const indexLine = indexLines[i];
    if (indexLine === undefined) continue;
    await writeFile(path.join(indexDir, indexFileName(indexLine, i)), `OPTION IMPORT;\n${indexLine}\n`, "utf8");
  }
}

async function generateSurrealKitProject(config: BenchmarkConfig, directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  const schemaDir = path.join(directory, "database", "schema");
  const schemaFullDir = path.join(directory, "database", "schema-full");
  const schemaNoIndexDir = path.join(directory, "database", "schema-no-index");
  const seedDir = path.join(directory, "database", "seed");
  const importDir = path.join(directory, "database", "import");
  await mkdir(schemaDir, { recursive: true });
  await mkdir(schemaFullDir, { recursive: true });
  await mkdir(schemaNoIndexDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });
  await mkdir(importDir, { recursive: true });
  const start = performance.now();
  const contractCount = Math.min(config.contractAccounts, config.accounts);

  const schema = await readFile(path.join(surrealKitDir, "database", "schema", "000_schema.surql"), "utf8");
  const splitSchema = splitSchemaIndexes(schema);
  await writeFile(path.join(directory, "surrealkit.toml"), "# Generated SurrealKit benchmark project.\n", "utf8");
  await writeFile(path.join(schemaDir, "000_schema.surql"), schema, "utf8");
  await writeFile(path.join(schemaFullDir, "000_schema.surql"), schema, "utf8");
  await writeFile(path.join(schemaNoIndexDir, "000_schema.surql"), splitSchema.withoutIndexes, "utf8");
  await writeFile(path.join(importDir, "schema-full.surql"), `OPTION IMPORT;\n${schema}\n`, "utf8");
  await writeFile(path.join(importDir, "schema-no-index.surql"), `OPTION IMPORT;\n${splitSchema.withoutIndexes}\n`, "utf8");
  await writeFile(path.join(importDir, "indexes.surql"), `${splitSchema.indexes}\n`, "utf8");
  await writeIndexImportFiles(splitSchema.indexes, importDir);

  let stream: NodeJS.WritableStream;
    let accountChunk = 0;
    let accountWriter = await openBulkWriter(seedDir, "10000-accounts", accountChunk, "account", config.insertBatchRows);
    for (let i = 0; i < config.accounts; i += 1) {
      if (i > 0 && i % config.chunkRows === 0) {
        await accountWriter.close();
        accountChunk += 1;
        accountWriter = await openBulkWriter(seedDir, "10000-accounts", accountChunk, "account", config.insertBatchRows);
      }
      const publicKey = accountPublicKey(i);
      const searchMarker = i % 1000 === 0 ? "benchsearchaccount" : "benchaccount";
      await accountWriter.row(`{ id: ${q(accountKey(i))}, public_key: ${q(publicKey)}, balance: ${q(String(1_000_000_000 - i))}, nonce: ${i % 100}, last_activity_height: ${1000 + i}, last_activity_at: ${d(isoMinute(1, i))}, search_text: ${q(`${publicKey} ${searchMarker}`)} }`);
      progress("accounts", i + 1, config.accounts, start);
    }
    await accountWriter.close();

    stream = await openChunk(seedDir, "20000-batch", 0);
    await writeLine(stream, `INSERT INTO batch [{ id: ${q(ulid("B", 1))}, batch_height: 1, sort_batch_height: -1, first_tx_height: 1, last_tx_height: ${config.transactions}, transaction_count: ${config.transactions}, proof_status: "proved", settlement_status: "settling", da_status: "attested" }];`);
    await closeChunk(stream);

    let txChunk = 0;
    let txWriter = await openBulkWriter(seedDir, "30000-transactions", txChunk, "transaction", config.insertBatchRows);
    let relationWriter = await openBulkWriter(seedDir, "30030-account-transaction-relations", txChunk, "account_transaction", config.insertBatchRows, true);
    let activityWriter = await openBulkWriter(seedDir, "30040-account-activity", txChunk, "account_activity", config.insertBatchRows);
    let eventWriter = await openBulkWriter(seedDir, "30050-zkapp-events", txChunk, "zkapp_event", config.insertBatchRows);
    let actionWriter = await openBulkWriter(seedDir, "30060-zkapp-actions", txChunk, "zkapp_action", config.insertBatchRows);
    for (let i = 1; i <= config.transactions; i += 1) {
      if (i > 1 && (i - 1) % config.chunkRows === 0) {
        await Promise.all([txWriter.close(), relationWriter.close(), activityWriter.close(), eventWriter.close(), actionWriter.close()]);
        txChunk += 1;
        txWriter = await openBulkWriter(seedDir, "30000-transactions", txChunk, "transaction", config.insertBatchRows);
        relationWriter = await openBulkWriter(seedDir, "30030-account-transaction-relations", txChunk, "account_transaction", config.insertBatchRows, true);
        activityWriter = await openBulkWriter(seedDir, "30040-account-activity", txChunk, "account_activity", config.insertBatchRows);
        eventWriter = await openBulkWriter(seedDir, "30050-zkapp-events", txChunk, "zkapp_event", config.insertBatchRows);
        actionWriter = await openBulkWriter(seedDir, "30060-zkapp-actions", txChunk, "zkapp_action", config.insertBatchRows);
      }
      const sender = accountId(i % config.accounts);
      const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
      const senderPublicKey = accountPublicKey(i % config.accounts);
      const receiverPublicKey = i % 5 === 0 ? accountPublicKey(i % contractCount) : accountPublicKey((i + 1) % config.accounts);
      const tx = txId(i);
      const txHash = `bench-tx-${i}`;
      const timestamp = isoMinute(2, i);
      const txType = i % 3 === 0 ? "zkapp_command" : "payment";
      const txSearchText = i % 1000 === 0 ? `, search_text: ${q(`benchsearchtransaction memo-${i}`)}` : "";
      await txWriter.row(`{ id: ${txKey(i)}, hash: ${q(txHash)}, sequence_number: ${i}, type: ${q(txType)}, status: "applied", sender: ${sender}, receiver: ${receiver}, sender_public_key: ${q(senderPublicKey)}, receiver_public_key: ${q(receiverPublicKey)}, amount: ${q(String(i))}, fee: "1", nonce: ${i % 100}${txSearchText}, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, timestamp: ${d(timestamp)}, source_ledger_hash: ${q(`bench-ledger-${i - 1}`)}, target_ledger_hash: ${q(`bench-ledger-${i}`)}, batch: batch:${ulid("B", 1)} }`);
      await relationWriter.row(`{ in: ${tx}, out: ${sender}, role: "sender", account_public_key: ${q(senderPublicKey)}, sort_block_height: ${0 - i}, sort_tx_index: 0 }`);
      await relationWriter.row(`{ in: ${tx}, out: ${receiver}, role: "receiver", account_public_key: ${q(receiverPublicKey)}, sort_block_height: ${0 - i}, sort_tx_index: 0 }`);
      if (i % config.activityStride === 0) {
        await activityWriter.row(`{ id: ${q(activityKey(i))}, account: ${sender}, transaction: ${tx}, role: "sender", block_height: ${i}, tx_index: 0, activity_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_activity_index: 0, timestamp: ${d(timestamp)}, balance_before: "1000", balance_after: "999", target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
      }
      if (i % 100 === 0) {
        await eventWriter.row(`{ id: ${q(eventKey(i))}, transaction: ${tx}, transaction_hash: ${q(txHash)}, emitting_account: ${receiver}, event_index: 0, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_event_index: 0, timestamp: ${d(timestamp)}, fields: [${q(String(i))}, ${q(String(i + 1))}], sequence_number: ${i}, target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
        await actionWriter.row(`{ id: ${q(actionKey(i))}, transaction: ${tx}, transaction_hash: ${q(txHash)}, emitting_account: ${receiver}, action_index: 0, block_height: ${i}, tx_index: 0, sort_block_height: ${0 - i}, sort_tx_index: 0, sort_action_index: 0, timestamp: ${d(timestamp)}, fields: [${q(String(i + 2))}, ${q(String(i + 3))}], before_action_state: ${q(`bench-action-${i - 1}`)}, action_state: ${q(`bench-action-${i}`)}, sequence_number: ${i}, target_ledger_hash: ${q(`bench-ledger-${i}`)} }`);
      }
      progress("transactions + account_activity", i, config.transactions, start);
    }
    await Promise.all([txWriter.close(), relationWriter.close(), activityWriter.close(), eventWriter.close(), actionWriter.close()]);

    let bridgeChunk = 0;
    let bridgeWriter = await openBulkWriter(seedDir, "40000-bridges", bridgeChunk, "bridge_operation", config.insertBatchRows);
    for (let i = 0; i < config.bridgeOperations; i += 1) {
      if (i > 0 && i % config.chunkRows === 0) {
        await bridgeWriter.close();
        bridgeChunk += 1;
        bridgeWriter = await openBulkWriter(seedDir, "40000-bridges", bridgeChunk, "bridge_operation", config.insertBatchRows);
      }
      const aux = `bench-aux-${Math.floor(i / 3)}`;
      const submitBlockHeight = 5_000 + i;
      const quality = i % 7 === 0 ? "partial" : "complete";
      const sender = accountPublicKey(i % config.accounts);
      const recipient = accountPublicKey((i + 1) % config.accounts);
      const bridgeSearchMarker = i % 1000 === 0 ? "benchsearchbridge" : "benchbridge";
      const bridgeType = i % 2 === 0 ? "deposit" : "withdrawal";
      const bridgeStatus = i % 5 === 0 ? "submitted" : "completed";
      await bridgeWriter.row(`{ id: ${q(bridgeKey(i))}, type: ${q(bridgeType)}, status: ${q(bridgeStatus)}, aux: ${q(aux)}, aux_sequence: ${i % 3}, sender: ${q(sender)}, recipient: ${q(recipient)}, amount: ${q(String(i))}, search_text: ${q(`${aux} ${sender} ${recipient} ${bridgeSearchMarker}`)}, data_quality: ${q(quality)}, data_quality_reasons: ${quality === "partial" ? `[${q("historical_bridge_events_unavailable")}]` : "NONE"}, submit_tx_hash: ${q(`bench-submit-${i}`)}, submit_block_height: ${submitBlockHeight}, sort_submit_block_height: ${0 - submitBlockHeight}, submit_timestamp: ${d(isoMinute(3, i))} }`);
      progress("bridge_operations", i + 1, config.bridgeOperations, start);
    }
  await bridgeWriter.close();
  await writeImportChunks(seedDir, importDir);
  if (config.writeMonolithicImport) {
    await writeImportBundle(seedDir, importDir);
    await writeCombinedImportFile(importDir, "full.surql", ["schema-full.surql", "data.surql"]);
    await writeCombinedImportFile(importDir, "full-no-index.surql", ["schema-no-index.surql", "data.surql"]);
  }
}

const config = configFromEnv();
const directory =
  process.env.BENCH_LOAD_PROJECT_DIR
  ?? process.env.BENCH_SURREALKIT_PROJECT_DIR
  ?? path.join(spikeDir, "harness", "reports", "benchmark-load");
await generateSurrealKitProject(config, directory);
console.log(directory);
