import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { runSql, startSurreal } from "../lib/surreal-client.ts";

type Phase = {
  readonly label: string;
  readonly prefixes: readonly string[];
};

const db = process.env.BENCH_DB_NAME ?? "bench_surrealkit";
const projectDir = process.env.BENCH_LOAD_PROJECT_DIR ?? path.join(import.meta.dirname, "..", "reports", "benchmark-load");
const seedDir = path.join(projectDir, "database", "seed");
const concurrency = Number(process.env.BENCH_HTTP_LOAD_CONCURRENCY ?? "8");
const maxAttempts = Number(process.env.BENCH_HTTP_LOAD_ATTEMPTS ?? "8");

if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error("BENCH_HTTP_LOAD_CONCURRENCY must be a positive integer");
}
if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
  throw new Error("BENCH_HTTP_LOAD_ATTEMPTS must be a positive integer");
}

const phases: readonly Phase[] = [
  { label: "accounts", prefixes: ["10000-accounts-"] },
  { label: "batch", prefixes: ["20000-batch-"] },
  { label: "transactions", prefixes: ["30000-transactions-"] },
  { label: "account_transaction_edges", prefixes: ["30030-account-transaction-relations-"] },
  { label: "activity_events_actions", prefixes: ["30040-account-activity-", "30050-zkapp-events-", "30060-zkapp-actions-"] },
  { label: "bridge_operations", prefixes: ["40000-bridges-"] }
];

async function runConcurrent<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function phaseFiles(files: readonly string[], phase: Phase): string[] {
  return files.filter((file) => phase.prefixes.some((prefix) => file.startsWith(prefix))).sort();
}

async function loadFile(file: string): Promise<void> {
  const sql = await readFile(path.join(seedDir, file), "utf8");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runSql(db, sql);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /Transaction (write )?conflict|can be retried/i.test(message);
      if (!retryable || attempt === maxAttempts) throw error;
      await delay(50 * attempt * attempt);
    }
  }
}

await startSurreal();

const files = (await readdir(seedDir)).filter((file) => file.endsWith(".surql")).sort();
const totalStart = performance.now();

for (const phase of phases) {
  const candidates = phaseFiles(files, phase);
  const phaseStart = performance.now();
  console.log(`[benchmark-http-load] ${phase.label}: ${candidates.length} files with concurrency ${concurrency}`);
  await runConcurrent(candidates, loadFile);
  console.log(`[benchmark-http-load] ${phase.label}: ${((performance.now() - phaseStart) / 1000).toFixed(2)}s`);
}

console.log(`[benchmark-http-load] total: ${((performance.now() - totalStart) / 1000).toFixed(2)}s`);
