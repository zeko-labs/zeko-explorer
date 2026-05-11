import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { spikeDir } from "../lib/surreal-client.ts";

type BenchmarkConfig = {
  readonly accounts: number;
  readonly transactions: number;
  readonly bridgeOperations: number;
  readonly contractAccounts: number;
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
    transactions: intEnv("BENCH_TX_COUNT", 1_000_000),
    bridgeOperations: intEnv("BENCH_BRIDGE_COUNT", 100_000),
    contractAccounts: intEnv("BENCH_CONTRACT_ACCOUNT_COUNT", 100)
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
  return `transaction:${ulid("T", index)}`;
}

function activityId(index: number): string {
  return `account_activity:${ulid("C", index)}`;
}

function bridgeId(index: number): string {
  return `bridge_operation:${ulid("O", index)}`;
}

function bridgeIssueId(index: number): string {
  return `bridge_quality_issue:${ulid("Q", index)}`;
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

function progress(label: string, current: number, total: number, start: number): void {
  if (current === 0 || current === total || current % 100_000 === 0) {
    const elapsed = (performance.now() - start) / 1000;
    const rate = elapsed > 0 ? current / elapsed : 0;
    console.log(`[import-file] ${label}: ${current.toLocaleString()}/${total.toLocaleString()} (${rate.toFixed(0)} rows/s)`);
  }
}

async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

async function generateImportFile(config: BenchmarkConfig, filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  const start = performance.now();
  const contractCount = Math.min(config.contractAccounts, config.accounts);

  try {
    await writeLine(stream, await readFile(path.join(spikeDir, "schema.surql"), "utf8"));

    for (let i = 0; i < config.accounts; i += 1) {
      const publicKey = accountPublicKey(i);
      await writeLine(stream, `CREATE ${accountId(i)} SET public_key = "${publicKey}", balance = "${1_000_000_000 - i}", nonce = ${i % 100}, last_activity_height = ${1000 + i}, last_activity_at = d"${isoMinute(1, i)}" RETURN NONE;`);
      progress("accounts", i + 1, config.accounts, start);
    }

    await writeLine(stream, `CREATE batch:${ulid("B", 1)} SET batch_height = 1, first_tx_height = 1, last_tx_height = ${config.transactions}, transaction_count = ${config.transactions}, proof_status = "proved", settlement_status = "settling", da_status = "attested" RETURN NONE;`);

    for (let i = 1; i <= config.transactions; i += 1) {
      const sender = accountId(i % config.accounts);
      const receiver = i % 5 === 0 ? accountId(i % contractCount) : accountId((i + 1) % config.accounts);
      const tx = txId(i);
      const timestamp = isoMinute(2, i);
      await writeLine(stream, `CREATE ${tx} SET hash = "bench-tx-${i}", sequence_number = ${i}, type = "${i % 3 === 0 ? "zkapp_command" : "payment"}", status = "applied", sender = ${sender}, receiver = ${receiver}, amount = "${i}", fee = "1", nonce = ${i % 100}, block_height = ${i}, tx_index = 0, sort_block_height = ${0 - i}, sort_tx_index = 0, timestamp = d"${timestamp}", source_ledger_hash = "bench-ledger-${i - 1}", target_ledger_hash = "bench-ledger-${i}", batch = batch:${ulid("B", 1)} RETURN NONE;`);
      await writeLine(stream, `CREATE ${activityId(i)} SET account = ${sender}, transaction = ${tx}, role = "sender", block_height = ${i}, tx_index = 0, activity_index = 0, timestamp = d"${timestamp}", balance_before = "1000", balance_after = "999", target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
      if (i % 100 === 0) {
        await writeLine(stream, `CREATE ${eventId(i)} SET transaction = ${tx}, emitting_account = ${receiver}, event_index = 0, block_height = ${i}, tx_index = 0, timestamp = d"${timestamp}", fields = ["${i}", "${i + 1}"], sequence_number = ${i}, target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
        await writeLine(stream, `CREATE ${actionId(i)} SET transaction = ${tx}, emitting_account = ${receiver}, action_index = 0, block_height = ${i}, tx_index = 0, timestamp = d"${timestamp}", fields = ["${i + 2}", "${i + 3}"], before_action_state = "bench-action-${i - 1}", action_state = "bench-action-${i}", sequence_number = ${i}, target_ledger_hash = "bench-ledger-${i}" RETURN NONE;`);
      }
      progress("transactions + account_activity", i, config.transactions, start);
    }

    for (let i = 0; i < config.bridgeOperations; i += 1) {
      const aux = `bench-aux-${Math.floor(i / 3)}`;
      const submitBlockHeight = 5_000 + i;
      const quality = i % 7 === 0 ? "partial" : "complete";
      const sender = accountPublicKey(i % config.accounts);
      const recipient = accountPublicKey((i + 1) % config.accounts);
      const bridge = bridgeId(i);
      await writeLine(stream, `CREATE ${bridge} SET type = "${i % 2 === 0 ? "deposit" : "withdrawal"}", status = "${i % 5 === 0 ? "submitted" : "completed"}", aux = "${aux}", aux_sequence = ${i % 3}, sender = "${sender}", recipient = "${recipient}", amount = "${i}", data_quality = "${quality}", data_quality_reasons = ${quality === "partial" ? "[\"historical_bridge_events_unavailable\"]" : "NONE"}, submit_tx_hash = "bench-submit-${i}", submit_block_height = ${submitBlockHeight}, sort_submit_block_height = ${0 - submitBlockHeight}, submit_timestamp = d"${isoMinute(3, i)}" RETURN NONE;`);
      if (quality === "partial") {
        await writeLine(stream, `CREATE ${bridgeIssueId(i)} SET bridge_operation = ${bridge}, aux = "${aux}", aux_sequence = ${i % 3}, type = "${i % 2 === 0 ? "deposit" : "withdrawal"}", status = "${i % 5 === 0 ? "submitted" : "completed"}", data_quality = "partial", reason = "historical_bridge_events_unavailable", source_subject = "zeko.l1.bridge-events", missing_fields = ["l1_witness_action_state", "commit_action_state", "l2_action_state"], sender = "${sender}", recipient = "${recipient}", submit_block_height = ${submitBlockHeight}, sort_submit_block_height = ${0 - submitBlockHeight}, submit_timestamp = d"${isoMinute(3, i)}" RETURN NONE;`);
      }
      progress("bridge_operations", i + 1, config.bridgeOperations, start);
    }
  } finally {
    stream.end();
    await once(stream, "finish");
  }
}

const config = configFromEnv();
const filePath = process.env.BENCH_IMPORT_FILE ?? path.join(spikeDir, "harness", "reports", `benchmark-import-${Date.now()}.surql`);
await generateImportFile(config, filePath);
console.log(filePath);
