import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindSqlParams, datetime, record, runSql, spikeDir, startSurreal, stopSurreal, syncSchema, type SurrealParam } from "../lib/surreal-client.ts";
import { fixtureIds, seedExplorerFixture } from "../features/support/fixtures.ts";

type ExplainCase = {
  readonly name: string;
  readonly params: Readonly<Record<string, SurrealParam>>;
  readonly note: string;
  readonly sql?: string;
  readonly updateQueryFile?: boolean;
};

function explainSql(sql: string): string {
  const trimmed = sql.trim();
  assert.ok(trimmed.endsWith(";"), "Query files must end with a semicolon before EXPLAIN can be appended");
  return `${trimmed.slice(0, -1)} EXPLAIN FULL;`;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function collectPlanFacts(value: unknown, operators: string[] = [], indexes: Set<string> = new Set()): { readonly operators: readonly string[]; readonly indexes: ReadonlySet<string> } {
  if (Array.isArray(value)) {
    for (const child of value) collectPlanFacts(child, operators, indexes);
    return { operators, indexes };
  }
  if (value === null || typeof value !== "object") return { operators, indexes };
  const object = value as Record<string, unknown>;
  if (typeof object.operator === "string") operators.push(object.operator);
  const attributes = object.attributes;
  if (attributes !== null && typeof attributes === "object" && !Array.isArray(attributes)) {
    const index = (attributes as Record<string, unknown>).index;
    if (typeof index === "string") indexes.add(index);
  }
  for (const child of Object.values(object)) collectPlanFacts(child, operators, indexes);
  return { operators, indexes };
}

function summarizePlan(plan: unknown): string {
  const { operators, indexes } = collectPlanFacts(plan);
  const uniqueOperators = [...new Set(operators)];
  const indexList = [...indexes];
  const operatorSummary = uniqueOperators.length === 0 ? "no planner operators returned" : uniqueOperators.join(" -> ");
  const indexSummary = indexList.length === 0 ? "no explicit secondary index in plan" : `indexes ${indexList.join(", ")}`;
  return `${operatorSummary}; ${indexSummary}`;
}

const explainStart = "-- EXPLAIN START";
const explainEnd = "-- EXPLAIN END";

function removeGeneratedExplainComment(sql: string): string {
  const pattern = new RegExp(`\\n?${explainStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${explainEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  return sql.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function insertExplainComment(sql: string, lines: readonly string[]): string {
  const clean = removeGeneratedExplainComment(sql).trimEnd();
  const sqlLines = clean.split("\n");
  let insertAt = 0;
  while (insertAt < sqlLines.length && sqlLines[insertAt]?.startsWith("--")) insertAt += 1;
  const comment = [explainStart, ...lines.map((line) => `-- ${line}`), explainEnd];
  return [...sqlLines.slice(0, insertAt), ...comment, ...sqlLines.slice(insertAt)].join("\n") + "\n";
}

async function updateQueryExplainComments(planSummaries: ReadonlyMap<string, string>): Promise<void> {
  const queryDir = path.join(spikeDir, "queries");
  const files = (await readdir(queryDir)).filter((file) => file.endsWith(".surql")).sort();
  const manualComments: Readonly<Record<string, readonly string[]>> = {
    "live-account-transaction-feed": [
      "EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.",
      "Initial pages use account-transaction-feed-first-page/account-transaction-feed, which document the indexed relation-table plan."
    ],
    "live-bridge-operation-feed": [
      "EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.",
      "Initial sender/recipient history pages use idx_bo_sender_order and idx_bo_recipient_order."
    ],
    "live-sync-status": [
      "EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.",
      "Finite freshness lookups use sync-status-by-source and idx_sync_status_source."
    ],
    "live-transaction-feed": [
      "EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.",
      "Initial pages use transaction-feed-first-page/transaction-feed and idx_tx_connection_order."
    ],
  "network-stats-current": [
    "EXPLAIN(v3 fixture): compound RETURN query; component plans are documented in harness/reports/explain-current.md.",
    "Counts use COUNT indexes, the TPS window uses idx_tx_timestamp, and latest rows use order indexes."
  ],
    "rollback-rows-by-target-ledger": [
      "EXPLAIN(v3 fixture): compound RETURN query; component rollback plans are documented in harness/reports/explain-current.md.",
      "Rollback lookups use idx_tx_ledger plus child target-ledger indexes and account_transaction.in."
    ],
    "search-exact-identifiers": [
      "EXPLAIN(v3 fixture): compound RETURN query; exact lookup components are documented in harness/reports/explain-current.md.",
      "Identifier probes use natural-key indexes: idx_tx_hash, idx_account_public_key, idx_bo_aux_unique, idx_oa_after_state, idx_ia_after_state."
    ]
  };

  for (const file of files) {
    const name = path.basename(file, ".surql");
    const summary = planSummaries.get(name);
    const manual = manualComments[name];
    assert.ok(summary !== undefined || manual !== undefined, `${file} has no EXPLAIN comment source`);
    const lines = manual ?? [
      `EXPLAIN(v3 fixture): ${summary}.`,
      `Full plan: harness/reports/explain-current.md#${anchor(name)}.`
    ];
    const filePath = path.join(queryDir, file);
    const sql = await readFile(filePath, "utf8");
    await writeFile(filePath, insertExplainComment(sql, lines), "utf8");
  }
}

const ids = fixtureIds();
const cases: readonly ExplainCase[] = [
  { name: "transaction-feed-first-page", params: { from_sort_block_height: -106, limit: 4 }, note: "Global transaction feed from the indexed high-water sort key." },
  { name: "transaction-feed", params: { after_sort_block_height: -106, after_sort_tx_index: 0, after_hash: "tx-006", limit: 4 }, note: "Global transaction feed after a full record-key cursor." },
  { name: "transaction-by-hash", params: { hash: "tx-005" }, note: "Exact natural transaction lookup." },
  { name: "transaction-detail-by-hash", params: { hash: "tx-006", event_limit: 10, action_limit: 10, inner_action_limit: 10 }, note: "Transaction detail with bounded related data." },
  { name: "account-by-public-key", params: { public_key: "B62qAlice" }, note: "Exact account public-key lookup." },
  { name: "account-transaction-graph", params: { account: record(ids.alice) }, note: "Native graph traversal from account role edges." },
  { name: "account-transaction-feed-first-page", params: { public_key: "B62qAlice", limit: 3 }, note: "Current account transaction feed query." },
  { name: "account-transaction-feed", params: { public_key: "B62qAlice", after_sort_block_height: -105, after_sort_tx_index: 0, after_role: "sender", after_hash: "tx-005", limit: 3 }, note: "Account transaction feed after a full tuple cursor." },
  { name: "transactions-by-sender-first-page", params: { public_key: "B62qAlice", limit: 3 }, note: "Sender transaction feed." },
  { name: "transactions-by-sender", params: { public_key: "B62qAlice", after_sort_block_height: -105, after_sort_tx_index: 0, after_hash: "tx-005", limit: 3 }, note: "Sender transaction feed after a full tuple cursor." },
  { name: "transactions-by-receiver-first-page", params: { public_key: "B62qContract", limit: 3 }, note: "Receiver transaction feed." },
  { name: "account-profile-overview", params: { public_key: "B62qAlice", activity_limit: 3, sent_limit: 3, received_limit: 3, bridge_limit: 3 }, note: "Account profile overview with native feed subqueries." },
  { name: "account-activity-first-page", params: { account: record(ids.alice), limit: 3 }, note: "Account activity feed." },
  { name: "account-activity-feed", params: { account: record(ids.alice), after_sort_block_height: -105, after_sort_tx_index: 0, after_sort_activity_index: 0, after_id: record(ids.activity1), limit: 3 }, note: "Account activity feed after a full tuple cursor." },
  { name: "batch-with-transactions-graph", params: { batch: record(ids.batch1) }, note: "Batch detail with graph traversal to contained transactions." },
  { name: "bridge-operation-by-natural-key", params: { aux: "aux-shared", aux_sequence: 0 }, note: "Exact bridge operation natural-key lookup." },
  { name: "bridge-operation-detail-graph", params: { aux: "aux-shared", aux_sequence: 0 }, note: "Bridge detail with graph links." },
  { name: "bridge-operations-by-sender-first-page", params: { public_key: "B62qAlice", limit: 10 }, note: "Bridge sender history." },
  { name: "bridge-operations-by-sender", params: { public_key: "B62qAlice", after_sort_submit_block_height: -5000, after_aux: "aux-shared", after_aux_sequence: 0, after_id: record(ids.bridge1), limit: 10 }, note: "Bridge sender history after a full tuple cursor." },
  { name: "bridge-operations-by-recipient-first-page", params: { public_key: "B62qBob", limit: 10 }, note: "Bridge recipient history." },
  { name: "bridge-quality-issues-first-page", params: { data_quality: "partial", limit: 5 }, note: "Bridge quality issue list derived from canonical bridge_operation rows." },
  { name: "bridge-quality-issues-by-reason", params: { reason: "historical_bridge_events_unavailable", limit: 5 }, note: "Bridge quality primary-reason list derived from canonical bridge_operation.data_quality_reasons[0]." },
  { name: "da-attestations-by-batch", params: { batch: record(ids.batch1), limit: 5 }, note: "DA attestation observations for a batch." },
  { name: "inner-action-chain-prev", params: { after_state: "inner-mint-1" }, note: "Inner action state-chain lookup." },
  { name: "l1-watcher-cursor", params: { source: "l1-watcher", network: "zeko-m-devnet", provider: "mina-daemon", cursor_kind: "tip" }, note: "Durable L1 watcher cursor lookup." },
  { name: "l1-watcher-published-by-msg-id", params: { msg_id: "settlement-outer-commit-1-settling" }, note: "Published-message idempotency lookup." },
  { name: "outer-action-by-after-state", params: { after_state: "outer-commit-1" }, note: "Outer action state-chain lookup." },
  { name: "sync-status-by-source", params: { source: "l1-watcher" }, note: "Ingestion freshness lookup by source." },
  { name: "network-throughput-by-minute", params: { from: datetime("2026-05-01T00:00:00Z"), to: datetime("2026-05-01T01:00:00Z") }, note: "Native time-bucketed throughput aggregation over canonical transactions." },
  { name: "zkapp-actions-first-page", params: { account: record(ids.contract), limit: 5 }, note: "First zkApp action page for a contract." },
  { name: "zkapp-actions-by-account", params: { account: record(ids.contract), after_sort_block_height: -106, after_sort_tx_index: 0, after_sort_action_index: 0, after_id: record(ids.action2), limit: 5 }, note: "Next zkApp action page after a full tuple cursor." },
  { name: "zkapp-events-first-page", params: { account: record(ids.contract), limit: 5 }, note: "First zkApp event page for a contract." },
  { name: "zkapp-events-by-account", params: { account: record(ids.contract), after_sort_block_height: -106, after_sort_tx_index: 0, after_sort_event_index: 0, after_id: record(ids.event2), limit: 5 }, note: "Next zkApp event page after a full tuple cursor." },
  {
    name: "candidate-network-stats-transaction-count",
    params: {},
    note: "Network status transaction count derived from canonical transaction rows with a SurrealDB COUNT index.",
    sql: `
SELECT count() AS transaction_count FROM transaction GROUP ALL;
`
  },
  {
    name: "candidate-network-stats-tps-window",
    params: {},
    note: "Network status TPS window uses a bounded timestamp range over canonical transaction rows.",
    sql: `
SELECT VALUE id FROM transaction WHERE timestamp >= time::now() - 5m;
`
  },
  { name: "batch-feed-first-page", params: { limit: 5 }, note: "Batch feed." },
  { name: "batch-feed", params: { after_sort_batch_height: -1, after_id: record(ids.batch1), limit: 5 }, note: "Batch feed after a full tuple cursor." },
  { name: "transactions-search-text", params: { term: "again", limit: 5 }, note: "Transaction full-text search." },
  { name: "accounts-search-text", params: { term: "B62qAlice", limit: 5 }, note: "Account full-text search." },
  { name: "bridge-operations-search-text", params: { term: "aux-shared", limit: 5 }, note: "Bridge full-text search." },
  {
    name: "rollback-transactions-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback transaction component by target ledger hash.",
    updateQueryFile: false,
    sql: `
SELECT * FROM transaction WHERE target_ledger_hash = $target_ledger_hash;
`
  },
  {
    name: "rollback-account-activity-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback account activity component by target ledger hash.",
    updateQueryFile: false,
    sql: `
SELECT * FROM account_activity WHERE target_ledger_hash = $target_ledger_hash;
`
  },
  {
    name: "rollback-account-transactions-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback account_transaction relation component through transaction target-ledger lookup.",
    updateQueryFile: false,
    sql: `
SELECT * FROM account_transaction WHERE in IN (SELECT VALUE id FROM transaction WHERE target_ledger_hash = $target_ledger_hash);
`
  },
  {
    name: "rollback-inner-actions-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback inner action component by target ledger hash.",
    updateQueryFile: false,
    sql: `
SELECT * FROM inner_action WHERE target_ledger_hash = $target_ledger_hash;
`
  },
  {
    name: "rollback-zkapp-events-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback zkApp event component by target ledger hash.",
    updateQueryFile: false,
    sql: `
SELECT * FROM zkapp_event WHERE target_ledger_hash = $target_ledger_hash;
`
  },
  {
    name: "rollback-zkapp-actions-by-target-ledger",
    params: { target_ledger_hash: "ledger-106" },
    note: "Rollback zkApp action component by target ledger hash.",
    updateQueryFile: false,
    sql: `
SELECT * FROM zkapp_action WHERE target_ledger_hash = $target_ledger_hash;
`
  },
  {
    name: "search-exact-transaction-hash",
    params: { term: "tx-005" },
    note: "Exact identifier transaction component.",
    updateQueryFile: false,
    sql: `
SELECT * FROM transaction WHERE hash = $term LIMIT 1;
`
  },
  {
    name: "search-exact-account-public-key",
    params: { term: "B62qAlice" },
    note: "Exact identifier account component.",
    updateQueryFile: false,
    sql: `
SELECT * FROM account WHERE public_key = $term LIMIT 1;
`
  },
  {
    name: "search-exact-bridge-aux",
    params: { term: "aux-shared", limit: 5 },
    note: "Exact identifier bridge aux component.",
    updateQueryFile: false,
    sql: `
SELECT * FROM bridge_operation WHERE aux = $term LIMIT $limit;
`
  },
  {
    name: "search-exact-outer-action-state",
    params: { term: "outer-commit-1" },
    note: "Exact identifier outer action state component.",
    updateQueryFile: false,
    sql: `
SELECT * FROM outer_action WHERE after_state = $term LIMIT 1;
`
  },
  {
    name: "search-exact-inner-action-state",
    params: { term: "inner-mint-1" },
    note: "Exact identifier inner action state component.",
    updateQueryFile: false,
    sql: `
SELECT * FROM inner_action WHERE after_state = $term LIMIT 1;
`
  },
  {
    name: "candidate-account-sender-relation-index",
    params: { public_key: "B62qAlice", limit: 3 },
    note: "Native relation-table path: use account_transaction edge metadata and indexes.",
    sql: `
SELECT in.* AS transaction, role, account_public_key, sort_block_height, sort_tx_index
FROM account_transaction
WHERE account_public_key = $public_key AND role = "sender"
ORDER BY sort_block_height ASC, sort_tx_index ASC
LIMIT $limit;
`
  },
  {
    name: "candidate-account-receiver-relation-index",
    params: { public_key: "B62qContract", limit: 3 },
    note: "Native relation-table candidate for receiver/contract transaction feed.",
    sql: `
SELECT in.* AS transaction, role, account_public_key, sort_block_height, sort_tx_index
FROM account_transaction
WHERE account_public_key = $public_key AND role = "receiver"
ORDER BY sort_block_height ASC, sort_tx_index ASC
LIMIT $limit;
`
  },
  {
    name: "candidate-account-all-graph-traversal",
    params: { account: record(ids.alice), limit: 3 },
    note: "Native graph traversal candidate from account to related transactions.",
    sql: `
SELECT <-account_transaction<-transaction AS transactions
FROM $account
LIMIT $limit;
`
  },
  {
    name: "candidate-account-all-relation-index",
    params: { account: record(ids.alice), limit: 3 },
    note: "Native relation-table candidate for all account roles, preserving edge metadata and ordering.",
    sql: `
SELECT in.* AS transaction, role, account_public_key, sort_block_height, sort_tx_index
FROM account_transaction
WHERE out = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC
LIMIT $limit;
`
  },
  {
    name: "candidate-bridge-sender-base-index",
    params: { public_key: "B62qAlice", limit: 10 },
    note: "Native base-table candidate: use bridge_operation sender/sort index for sender history.",
    sql: `
SELECT * FROM bridge_operation
WHERE sender = $public_key
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
`
  },
  {
    name: "candidate-account-profile-native-subqueries",
    params: { public_key: "B62qAlice", activity_limit: 3, sent_limit: 3, received_limit: 3, bridge_limit: 3 },
    note: "Account profile candidate using canonical tables and relation indexes.",
    sql: `
LET $account = (SELECT VALUE id FROM account WHERE public_key = $public_key LIMIT 1)[0];

SELECT *,
  (SELECT * FROM account_activity WHERE account = $account ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_activity_index ASC, id ASC LIMIT $activity_limit) AS recent_activity,
  (SELECT in.* AS transaction, role, account_public_key, sort_block_height, sort_tx_index FROM account_transaction WHERE account_public_key = $public_key AND role = "sender" ORDER BY sort_block_height ASC, sort_tx_index ASC LIMIT $sent_limit) AS recent_sent_transactions,
  (SELECT in.* AS transaction, role, account_public_key, sort_block_height, sort_tx_index FROM account_transaction WHERE account_public_key = $public_key AND role = "receiver" ORDER BY sort_block_height ASC, sort_tx_index ASC LIMIT $received_limit) AS recent_received_transactions,
  (SELECT * FROM bridge_operation WHERE sender = $public_key ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC LIMIT $bridge_limit) AS recent_bridge_operations
FROM $account;
`
  }
  ];

const db = `explain_${Date.now()}`;
await startSurreal();
try {
  await syncSchema(db);
  await seedExplorerFixture(db);
  const queryPlanSummaries = new Map<string, string>();

  const sections: string[] = [
    "# Spike 008 Query Plans",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "SurrealDB target: v3 Docker via `SPIKE008_SURREAL_IMAGE=surrealdb/surrealdb:v3`.",
    "Dataset: executable explorer fixture. Use this for planner evidence, not scale timings.",
    ""
  ];

  for (const item of cases) {
    const sql = item.sql ?? await readFile(path.join(spikeDir, "queries", `${item.name}.surql`), "utf8");
    const explained = explainSql(sql);
    const result = await runSql(db, bindSqlParams(explained, item.params));
    const last = result.at(-1);
    assert.ok(last !== undefined, `${item.name} produced no EXPLAIN response`);
    if (item.sql === undefined && item.updateQueryFile !== false) queryPlanSummaries.set(item.name, summarizePlan(last.result));
    sections.push(`## ${item.name}`, "", item.note, "", "Parameters:", fencedJson(item.params), "", "Plan:", fencedJson(last.result), "");
  }

  const outputPath = path.join(spikeDir, "harness", "reports", "explain-current.md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, sections.join("\n"), "utf8");
  await updateQueryExplainComments(queryPlanSummaries);
  console.log(outputPath);
} finally {
  await stopSurreal();
}
