import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { applyFile, parseParam, queryFile, runSql, type Row, type SpikeWorld } from "../support/surreal.ts";
import { fixtureIds, seedCoreMigrationData, seedExplorerFixture } from "../support/fixtures.ts";
import type { SurrealParam } from "../../lib/surreal-client.ts";

type DbInfo = { tables: Record<string, string> };
type TableInfo = { indexes: Record<string, string> };
type RollbackSummary = {
  transactions: Row[];
  account_activity: Row[];
  inner_actions: Row[];
  zkapp_events: Row[];
  zkapp_actions: Row[];
};

function paramsFromTable(table: DataTable): Record<string, SurrealParam> {
  const entries: [string, SurrealParam][] = [];
  for (const row of table.raw()) {
    const [key, value] = row;
    assert.ok(key !== undefined && value !== undefined, "Each parameter table row must have a key and value");
    entries.push([key, parseParam(value)]);
  }
  return Object.fromEntries(entries);
}

Given("the consolidated schema is applied", async function (this: SpikeWorld): Promise<void> {
  await applyFile(this.db, "schema.surql");
});

Given("migration {int} is applied", async function (this: SpikeWorld, version: number): Promise<void> {
  const file = version === 1
    ? "migrations/0001_initial_core.surql"
    : "migrations/0002_l1_watcher_and_bridge_quality.surql";
  await applyFile(this.db, file);
});

Given("core migration data exists", async function (this: SpikeWorld): Promise<void> {
  await seedCoreMigrationData(this.db);
});

Given("the explorer fixture is indexed", async function (this: SpikeWorld): Promise<void> {
  await seedExplorerFixture(this.db);
});

When("I run query {string} with:", async function (this: SpikeWorld, name: string, table: DataTable): Promise<void> {
  this.lastResult = await queryFile<Row[]>(this.db, name, paramsFromTable(table));
});

When("I try to insert another transaction with hash {string}", async function (this: SpikeWorld, hash: string): Promise<void> {
  const ids = fixtureIds();
  const sql = `
CREATE transaction:01J0000000000000000000DUPE SET hash = "${hash}", sequence_number = 999, type = "payment", status = "applied", sender = ${ids.alice}, receiver = ${ids.bob}, block_height = 999, tx_index = 0, sort_block_height = -999, sort_tx_index = 0, timestamp = d"2026-05-01T00:10:00Z", source_ledger_hash = "dupe-source", target_ledger_hash = "dupe-target";
`;
  const result = await runSql(this.db, sql, { allowError: true });
  this.lastError = result.find((entry) => entry.status !== "OK")?.result;
});

When("I try to insert another bridge operation with aux {string} and sequence {int}", async function (this: SpikeWorld, aux: string, seq: number): Promise<void> {
  const sql = `
CREATE bridge_operation:01J0000000000000000000BODU SET type = "deposit", status = "submitted", aux = "${aux}", aux_sequence = ${seq}, sender = "B62qAlice", recipient = "B62qBob", amount = "10", submit_tx_hash = "duplicate", submit_block_height = 4998, sort_submit_block_height = -4998, submit_timestamp = d"2026-05-01T00:05:00Z";
`;
  const result = await runSql(this.db, sql, { allowError: true });
  this.lastError = result.find((entry) => entry.status !== "OK")?.result;
});

When("I mark target ledger {string} as rolled back", async function (this: SpikeWorld, targetLedgerHash: string): Promise<void> {
  await runSql(this.db, `
UPDATE transaction SET status = "reverted", rollback_reason = "time_precondition_expired" WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE zkapp_event WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE zkapp_action WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE inner_action WHERE target_ledger_hash = "${targetLedgerHash}";
UPDATE account SET balance = "601", nonce = 0 WHERE public_key = "B62qBob";
`);
});

Then("the database should contain tables:", async function (this: SpikeWorld, table: DataTable): Promise<void> {
  const expected = table.raw().flat();
  const info = await runSql<DbInfo>(this.db, "INFO FOR DB;");
  const result = info[0]?.result;
  assert.ok(result !== undefined);
  const tables = Object.keys(result.tables);
  for (const tableName of expected) {
    assert.ok(tables.includes(tableName), `Expected table ${tableName}`);
  }
});

Then("table {string} should define indexes:", async function (this: SpikeWorld, tableName: string, table: DataTable): Promise<void> {
  const expected = table.raw().flat();
  const info = await runSql<TableInfo>(this.db, `INFO FOR TABLE ${tableName};`);
  const result = info[0]?.result;
  assert.ok(result !== undefined);
  const indexes = Object.keys(result.indexes);
  for (const indexName of expected) {
    assert.ok(indexes.includes(indexName), `Expected index ${tableName}.${indexName}`);
  }
});

Then("the result should contain {int} rows", function (this: SpikeWorld, count: number): void {
  assert.equal(this.lastResult.length, count);
});

Then("the result should contain one row", function (this: SpikeWorld): void {
  assert.equal(this.lastResult.length, 1);
});

Then("field {string} of the first row should equal {string}", function (this: SpikeWorld, field: string, expected: string): void {
  const first = this.lastResult[0];
  assert.ok(first !== undefined);
  assert.equal(String(first[field]), expected);
});

Then("array field {string} of the first row should contain {string}", function (this: SpikeWorld, field: string, expected: string): void {
  const first = this.lastResult[0];
  assert.ok(first !== undefined);
  const value = first[field];
  assert.ok(Array.isArray(value), `${field} should be an array`);
  assert.ok(value.includes(expected), `${field} should contain ${expected}`);
});

Then("the rows should be ordered by descending field {string}", function (this: SpikeWorld, field: string): void {
  const values = this.lastResult.map((row) => row[field]);
  const sorted = [...values].sort((a, b) => (String(a) < String(b) ? 1 : String(a) > String(b) ? -1 : 0));
  assert.deepEqual(values, sorted);
});

Then("all row IDs should be ULID record IDs for table {string}", function (this: SpikeWorld, tableName: string): void {
  for (const row of this.lastResult) {
    assert.match(String(row.id), new RegExp(`^${tableName}:01J[0-9A-Z]{23}$`));
  }
});

Then("the graph field {string} of the first row should contain {int} rows", function (this: SpikeWorld, field: string, count: number): void {
  const first = this.lastResult[0];
  assert.ok(first !== undefined);
  const rows = first[field];
  assert.ok(Array.isArray(rows), `${field} should be an array`);
  assert.equal(rows.length, count);
});

Then("the write should fail because of a unique index", function (this: SpikeWorld): void {
  assert.ok(this.lastError, "Expected write error");
  assert.match(String(this.lastError), /already contains|Database index|unique/i);
});

Then("bridge operation {string} should have data quality {string}", async function (this: SpikeWorld, aux: string, quality: string): Promise<void> {
  const rows = await queryFile<Row[]>(this.db, "bridge-operation-by-natural-key", {
    aux,
    aux_sequence: 0
  });
  assert.equal(rows[0]?.data_quality, quality);
});

Then("the rollback query for target ledger {string} should find no rollback-sensitive child rows", async function (this: SpikeWorld, targetLedgerHash: string): Promise<void> {
  const summary = await queryFile<RollbackSummary>(this.db, "rollback-rows-by-target-ledger", {
    target_ledger_hash: targetLedgerHash
  });
  assert.equal(summary.inner_actions.length, 0);
  assert.equal(summary.zkapp_events.length, 0);
  assert.equal(summary.zkapp_actions.length, 0);
  assert.equal(summary.transactions[0]?.status, "reverted");
});
