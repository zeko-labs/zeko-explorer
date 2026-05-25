import assert from "node:assert/strict";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll } from "vitest";
import {
  parseParam,
  queryFile,
  runSql,
  type SurrealParam,
  startSurreal,
  stopSurreal,
  syncSchema,
} from "./lib/surreal-client";
import { fixtureIds, seedExplorerFixture } from "./support/fixtures";

type DataTable = Array<Record<string, string>>;
type Row = Record<string, unknown>;
type DbInfo = { tables: Record<string, string> };
type TableInfo = { indexes: Record<string, string> };
type TableFieldInfo = { fields: Record<string, string>; indexes: Record<string, string> };
type RollbackSummary = {
  transactions: Row[];
  account_activity: Row[];
  account_transactions: Row[];
  inner_actions: Row[];
  zkapp_events: Row[];
  zkapp_actions: Row[];
};
type TestWorld = {
  db: string;
  lastResult: Row[];
  lastError: unknown;
};

let scenarioCount = 0;
let world: TestWorld = newWorld();

const featureFiles = [
  "tests/bootstrap.feature",
  "tests/da_status_storage.feature",
  "tests/graph_model.feature",
  "tests/idempotency.feature",
  "tests/query_catalog.feature",
  "tests/rollback.feature",
  "tests/schema_inventory.feature",
] as const;

const features = await Promise.all(featureFiles.map((featureFile) => loadFeature(featureFile)));

beforeAll(async () => {
  await startSurreal();
}, 60_000);

afterAll(async () => {
  await stopSurreal();
});

for (const feature of features) {
  describeFeature(feature, ({ Background, Scenario, defineSteps }) => {
    defineSteps(({ Step }) => {
      Step("the consolidated schema is applied", async () => {
        world = newWorld();
        await syncSchema(world.db);
      });

      Step("the explorer fixture is indexed", async () => {
        await seedExplorerFixture(world.db);
      });

      Step(
        "a batch row exists with target ledger hash {string}",
        async (_ctx, targetLedgerHash: string) => {
          await runSql(
            world.db,
            `
CREATE batch:01JDA000000000000000000D SET id = "01JDA000000000000000000D", batch_height = 2, sort_batch_height = -2, target_ledger_hash = "${targetLedgerHash}", first_tx_height = 2, last_tx_height = 2, transaction_count = 1, proof_status = "pending", settlement_status = "pending";
`,
          );
        },
      );

      Step("I run query {string} with:", async (_ctx, name: string, table: DataTable) => {
        world.lastResult = await queryFile<Row[]>(world.db, name, paramsFromTable(table));
      });

      Step("I try to insert another transaction with hash {string}", async (_ctx, hash: string) => {
        const ids = fixtureIds();
        const result = await runSql(
          world.db,
          `
CREATE transaction:01J0000000000000000000DUPE SET hash = "${hash}", sequence_number = 999, type = "payment", status = "applied", sender = ${ids.alice}, receiver = ${ids.bob}, block_height = 999, tx_index = 0, sort_block_height = -999, sort_tx_index = 0, timestamp = d"2026-05-01T00:10:00Z", source_ledger_hash = "dupe-source", target_ledger_hash = "dupe-target";
`,
          { allowError: true },
        );
        world.lastError = result.find((entry) => entry.status !== "OK")?.result;
      });

      Step(
        "I try to insert another bridge operation with aux {string} and sequence {int}",
        async (_ctx, aux: string, sequence: number) => {
          const result = await runSql(
            world.db,
            `
CREATE bridge_operation:01J0000000000000000000BODU SET type = "deposit", status = "submitted", aux = "${aux}", aux_sequence = ${sequence}, sender = "B62qAlice", recipient = "B62qBob", amount = "10", submit_tx_hash = "duplicate", submit_block_height = 4998, sort_submit_block_height = -4998, submit_timestamp = d"2026-05-01T00:05:00Z";
`,
            { allowError: true },
          );
          world.lastError = result.find((entry) => entry.status !== "OK")?.result;
        },
      );

      Step(
        "I mark target ledger {string} as rolled back",
        async (_ctx, targetLedgerHash: string) => {
          await runSql(
            world.db,
            `
UPDATE transaction SET status = "reverted", rollback_reason = "time_precondition_expired" WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE account_transaction WHERE in IN (SELECT VALUE id FROM transaction WHERE target_ledger_hash = "${targetLedgerHash}");
DELETE zkapp_event WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE zkapp_action WHERE target_ledger_hash = "${targetLedgerHash}";
DELETE inner_action WHERE target_ledger_hash = "${targetLedgerHash}";
UPDATE account SET balance = "601", nonce = 0 WHERE public_key = "B62qBob";
`,
          );
        },
      );

      Step(
        "a proved DA attestation is buffered for ledger hash {string}",
        async (_ctx, ledgerHash: string) => {
          await runSql(
            world.db,
            `
CREATE pending_da_attestation:["${ledgerHash}"] SET ledger_hash = "${ledgerHash}", source = "proved", attested_at = d"2026-05-01T00:00:00Z", received_at = d"2026-05-01T00:00:01Z";
`,
          );
        },
      );

      Step(
        "direct DA signer detail reaches quorum for {string}",
        async (_ctx, targetLedgerHash: string) => {
          await runSql(
            world.db,
            `
UPDATE batch SET da_status = "attested", da_source = "da-direct", da_attested_at = d"2026-05-01T00:00:02Z", da_implementation = "zeko-multisig-v1", da_quorum_threshold = 2, da_signers = [{ publicKey: "B62qSigner1", instanceId: "da-1", signedAt: d"2026-05-01T00:00:01Z" }, { publicKey: "B62qSigner2", instanceId: "da-2", signedAt: d"2026-05-01T00:00:02Z" }] WHERE target_ledger_hash = "${targetLedgerHash}";
`,
          );
        },
      );

      Step("the database should contain tables:", async (_ctx, table: DataTable) => {
        const info = await runSql<DbInfo>(world.db, "INFO FOR DB;");
        const result = info[0]?.result;
        assert.ok(result !== undefined);
        const tables = Object.keys(result.tables);
        for (const tableName of namesFromTable(table)) {
          assert.ok(tables.includes(tableName), `Expected table ${tableName}`);
        }
      });

      Step(
        "table {string} should define indexes:",
        async (_ctx, tableName: string, table: DataTable) => {
          const info = await runSql<TableInfo>(world.db, `INFO FOR TABLE ${tableName};`);
          const result = info[0]?.result;
          assert.ok(result !== undefined);
          const indexes = Object.keys(result.indexes);
          for (const indexName of namesFromTable(table)) {
            assert.ok(indexes.includes(indexName), `Expected index ${tableName}.${indexName}`);
          }
        },
      );

      Step(
        "table {string} should define fields:",
        async (_ctx, tableName: string, table: DataTable) => {
          const info = await runSql<TableFieldInfo>(world.db, `INFO FOR TABLE ${tableName};`);
          const result = info[0]?.result;
          assert.ok(result !== undefined);
          const fields = Object.keys(result.fields);
          for (const fieldName of namesFromTable(table)) {
            assert.ok(fields.includes(fieldName), `Expected field ${tableName}.${fieldName}`);
          }
        },
      );

      Step("the result should contain {int} rows", (_ctx, count: number) => {
        assert.equal(world.lastResult.length, count);
      });

      Step("the result should contain one row", () => {
        assert.equal(world.lastResult.length, 1);
      });

      Step(
        "field {string} of the first row should equal {string}",
        (_ctx, field: string, expected: string) => {
          const first = world.lastResult[0];
          assert.ok(first !== undefined);
          assert.equal(String(first[field]), expected);
        },
      );

      Step(
        "array field {string} of the first row should contain {string}",
        (_ctx, field: string, expected: string) => {
          const first = world.lastResult[0];
          assert.ok(first !== undefined);
          const value = first[field];
          assert.ok(Array.isArray(value), `${field} should be an array`);
          assert.ok(value.includes(expected), `${field} should contain ${expected}`);
        },
      );

      Step("the rows should be ordered by descending field {string}", (_ctx, field: string) => {
        const values = world.lastResult.map((row) => row[field]);
        const sorted = [...values].sort((a, b) =>
          String(a) < String(b) ? 1 : String(a) > String(b) ? -1 : 0,
        );
        assert.deepEqual(values, sorted);
      });

      Step("all row IDs should be record IDs for table {string}", (_ctx, tableName: string) => {
        for (const row of world.lastResult) {
          assert.match(String(row.id), new RegExp(`^${tableName}:`));
        }
      });

      Step(
        "the graph field {string} of the first row should contain {int} rows",
        (_ctx, field: string, count: number) => {
          const first = world.lastResult[0];
          assert.ok(first !== undefined);
          const rows = first[field];
          assert.ok(Array.isArray(rows), `${field} should be an array`);
          assert.equal(rows.length, count);
        },
      );

      Step("the write should fail because of a unique index", () => {
        assert.ok(world.lastError, "Expected write error");
        assert.match(String(world.lastError), /already contains|Database index|unique/i);
      });

      Step(
        "a row in {string} exists with ledger_hash {string} and source {string}",
        async (_ctx, tableName: string, ledgerHash: string, source: string) => {
          const rows = await runSql<Row[]>(
            world.db,
            `SELECT * FROM ${tableName} WHERE ledger_hash = "${ledgerHash}";`,
          );
          const result = rows.at(-1)?.result;
          assert.ok(Array.isArray(result));
          assert.equal(result.length, 1);
          assert.equal(result[0]?.source, source);
        },
      );

      Step(
        "the SurrealDB batch row for {string} has da_status {string}",
        async (_ctx, targetLedgerHash: string, status: string) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          assert.equal(row?.da_status, status);
        },
      );

      Step(
        "the SurrealDB batch row for {string} has da_source {string}",
        async (_ctx, targetLedgerHash: string, source: string) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          assert.equal(row?.da_source, source);
        },
      );

      Step(
        "the SurrealDB batch row for {string} records {int} DA signers",
        async (_ctx, targetLedgerHash: string, count: number) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          const signers = row?.da_signers;
          assert.ok(Array.isArray(signers));
          assert.equal(signers.length, count);
        },
      );

      Step(
        "the rollback query for target ledger {string} should find no rollback-sensitive child rows",
        async (_ctx, targetLedgerHash: string) => {
          const summary = await queryFile<RollbackSummary>(
            world.db,
            "rollback-rows-by-target-ledger",
            {
              target_ledger_hash: targetLedgerHash,
            },
          );
          assert.equal(summary.account_transactions.length, 0);
          assert.equal(summary.inner_actions.length, 0);
          assert.equal(summary.zkapp_events.length, 0);
          assert.equal(summary.zkapp_actions.length, 0);
          assert.equal(summary.transactions[0]?.status, "reverted");
        },
      );
    });

    if (feature.background !== null) {
      Background(() => {});
    }

    for (const scenario of feature.scenarii) {
      Scenario(scenario.description, () => {});
    }
  });
}

function newWorld(): TestWorld {
  scenarioCount += 1;
  return {
    db: `scenario_${Date.now()}_${scenarioCount}`,
    lastError: undefined,
    lastResult: [],
  };
}

function paramsFromTable(table: DataTable): Record<string, SurrealParam> {
  return Object.fromEntries(
    table.map((row) => {
      assert.ok(row.key !== undefined && row.value !== undefined);
      return [row.key, parseParam(row.value)];
    }),
  );
}

function namesFromTable(table: DataTable): string[] {
  return table.map((row) => {
    assert.ok(row.name !== undefined);
    return row.name;
  });
}

async function findBatchByTargetLedgerHash(targetLedgerHash: string): Promise<Row | undefined> {
  const rows = await runSql<Row[]>(
    world.db,
    `SELECT * FROM batch WHERE target_ledger_hash = "${targetLedgerHash}";`,
  );
  const result = rows.at(-1)?.result;
  assert.ok(Array.isArray(result));
  return result[0];
}
