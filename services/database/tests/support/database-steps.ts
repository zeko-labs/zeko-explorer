import { describeFeature, type loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  parseParam,
  queryFile,
  runSurql,
  type SurrealParam,
  syncSchema,
} from "../lib/surreal-client";
import { fixtureIds, seedExplorerFixture } from "./fixtures";

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

type DatabaseFeature = Awaited<ReturnType<typeof loadFeature>>;
type StepDefinitions = Parameters<Parameters<typeof describeFeature>[1]>[0];

let scenarioCount = 0;
let world: TestWorld = newWorld();

export function describeDatabaseFeature(feature: DatabaseFeature): void {
  describeFeature(feature, ({ Background, Scenario, defineSteps }) => {
    defineSteps(({ Given, When, Then, And }) => {
      const GivenOrAnd = defineAliases(Given, And);
      const ThenOrAnd = defineAliases(Then, And);

      Given("the consolidated schema is applied", async () => {
        world = newWorld();
        await syncSchema(world.db);
      });

      GivenOrAnd("the explorer fixture is indexed", async () => {
        await seedExplorerFixture(world.db);
      });

      GivenOrAnd(
        "a batch row exists with target ledger hash {string}",
        async (_ctx, targetLedgerHash: string) => {
          await runSurql(
            world.db,
            `
CREATE batch:01JDA000000000000000000D SET id = "01JDA000000000000000000D", batch_height = 2, sort_batch_height = -2, target_ledger_hash = "${targetLedgerHash}", first_tx_height = 2, last_tx_height = 2, transaction_count = 1, proof_status = "pending", settlement_status = "pending";
`,
          );
        },
      );

      When("I run query {string} with:", async (_ctx, name: string, table: DataTable) => {
        world.lastResult = await queryFile<Row[]>(world.db, name, paramsFromTable(table));
      });

      When("I try to insert another transaction with hash {string}", async (_ctx, hash: string) => {
        const ids = fixtureIds();
        const result = await runSurql(
          world.db,
          `
CREATE transaction:01J0000000000000000000DUPE SET hash = "${hash}", sequence_number = 999, type = "payment", status = "applied", sender = ${ids.alice}, receiver = ${ids.bob}, block_height = 999, tx_index = 0, sort_block_height = -999, sort_tx_index = 0, timestamp = d"2026-05-01T00:10:00Z", source_ledger_hash = "dupe-source", target_ledger_hash = "dupe-target";
`,
          { allowError: true },
        );
        world.lastError = result.find((entry) => entry.status !== "OK")?.result;
      });

      When(
        "I try to insert another bridge operation with aux {string} and sequence {int}",
        async (_ctx, aux: string, sequence: number) => {
          const result = await runSurql(
            world.db,
            `
CREATE bridge_operation:01J0000000000000000000BODU SET type = "deposit", status = "submitted", aux = "${aux}", aux_sequence = ${sequence}, sender = "B62qAlice", recipient = "B62qBob", amount = "10", submit_tx_hash = "duplicate", submit_block_height = 4998, sort_submit_block_height = -4998, submit_timestamp = d"2026-05-01T00:05:00Z";
`,
            { allowError: true },
          );
          world.lastError = result.find((entry) => entry.status !== "OK")?.result;
        },
      );

      When(
        "I mark target ledger {string} as rolled back",
        async (_ctx, targetLedgerHash: string) => {
          await runSurql(
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

      When(
        "a proved DA attestation is buffered for ledger hash {string}",
        async (_ctx, ledgerHash: string) => {
          await runSurql(
            world.db,
            `
CREATE pending_da_attestation:["${ledgerHash}"] SET ledger_hash = "${ledgerHash}", source = "proved", attested_at = d"2026-05-01T00:00:00Z", received_at = d"2026-05-01T00:00:01Z";
`,
          );
        },
      );

      When(
        "direct DA signer detail reaches quorum for {string}",
        async (_ctx, targetLedgerHash: string) => {
          await runSurql(
            world.db,
            `
UPDATE batch SET da_status = "attested", da_source = "da-direct", da_attested_at = d"2026-05-01T00:00:02Z", da_implementation = "zeko-multisig-v1", da_quorum_threshold = 2, da_signers = [{ publicKey: "B62qSigner1", instanceId: "da-1", signedAt: d"2026-05-01T00:00:01Z" }, { publicKey: "B62qSigner2", instanceId: "da-2", signedAt: d"2026-05-01T00:00:02Z" }] WHERE target_ledger_hash = "${targetLedgerHash}";
`,
          );
        },
      );

      Then("the database should contain tables:", async (_ctx, table: DataTable) => {
        const info = await runSurql<DbInfo>(world.db, "INFO FOR DB;");
        const result = info[0]?.result;
        expect(result).toBeDefined();
        const tables = Object.keys(result.tables);
        for (const tableName of namesFromTable(table)) {
          expect(tables, `Expected table ${tableName}`).toContain(tableName);
        }
      });

      ThenOrAnd(
        "table {string} should define indexes:",
        async (_ctx, tableName: string, table: DataTable) => {
          const info = await runSurql<TableInfo>(world.db, `INFO FOR TABLE ${tableName};`);
          const result = info[0]?.result;
          expect(result).toBeDefined();
          const indexes = Object.keys(result.indexes);
          for (const indexName of namesFromTable(table)) {
            expect(indexes, `Expected index ${tableName}.${indexName}`).toContain(indexName);
          }
        },
      );

      ThenOrAnd(
        "table {string} should define fields:",
        async (_ctx, tableName: string, table: DataTable) => {
          const info = await runSurql<TableFieldInfo>(world.db, `INFO FOR TABLE ${tableName};`);
          const result = info[0]?.result;
          expect(result).toBeDefined();
          const fields = Object.keys(result.fields);
          for (const fieldName of namesFromTable(table)) {
            expect(fields, `Expected field ${tableName}.${fieldName}`).toContain(fieldName);
          }
        },
      );

      Then("the result should contain {int} rows", (_ctx, count: number) => {
        expect(world.lastResult).toHaveLength(count);
      });

      Then("the result should contain one row", () => {
        expect(world.lastResult).toHaveLength(1);
      });

      ThenOrAnd(
        "field {string} of the first row should equal {string}",
        (_ctx, field: string, expected: string) => {
          const first = world.lastResult[0];
          expect(first).toBeDefined();
          expect(String(first?.[field])).toBe(expected);
        },
      );

      ThenOrAnd(
        "array field {string} of the first row should contain {string}",
        (_ctx, field: string, expected: string) => {
          const first = world.lastResult[0];
          expect(first).toBeDefined();
          const value = first[field];
          expect(value, `${field} should be an array`).toEqual(expect.any(Array));
          expect(value).toContain(expected);
        },
      );

      ThenOrAnd(
        "the rows should be ordered by descending field {string}",
        (_ctx, field: string) => {
          const values = world.lastResult.map((row) => row[field]);
          const sorted = [...values].sort((a, b) =>
            String(a) < String(b) ? 1 : String(a) > String(b) ? -1 : 0,
          );
          expect(values).toEqual(sorted);
        },
      );

      ThenOrAnd(
        "all row IDs should be record IDs for table {string}",
        (_ctx, tableName: string) => {
          for (const row of world.lastResult) {
            expect(String(row.id)).toMatch(new RegExp(`^${tableName}:`));
          }
        },
      );

      ThenOrAnd(
        "the graph field {string} of the first row should contain {int} rows",
        (_ctx, field: string, count: number) => {
          const first = world.lastResult[0];
          expect(first).toBeDefined();
          const rows = first[field];
          expect(rows, `${field} should be an array`).toEqual(expect.any(Array));
          expect(rows).toHaveLength(count);
        },
      );

      Then("the write should fail because of a unique index", () => {
        expect(world.lastError, "Expected write error").toBeTruthy();
        expect(String(world.lastError)).toMatch(/already contains|Database index|unique/i);
      });

      Then(
        "a row in {string} exists with ledger_hash {string} and source {string}",
        async (_ctx, tableName: string, ledgerHash: string, source: string) => {
          const rows = await runSurql<Row[]>(
            world.db,
            `SELECT * FROM ${tableName} WHERE ledger_hash = "${ledgerHash}";`,
          );
          const result = rows.at(-1)?.result;
          expect(result).toEqual(expect.any(Array));
          expect(result).toHaveLength(1);
          expect(result?.[0]?.source).toBe(source);
        },
      );

      ThenOrAnd(
        "the SurrealDB batch row for {string} has da_status {string}",
        async (_ctx, targetLedgerHash: string, status: string) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          expect(row?.da_status).toBe(status);
        },
      );

      ThenOrAnd(
        "the SurrealDB batch row for {string} has da_source {string}",
        async (_ctx, targetLedgerHash: string, source: string) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          expect(row?.da_source).toBe(source);
        },
      );

      ThenOrAnd(
        "the SurrealDB batch row for {string} records {int} DA signers",
        async (_ctx, targetLedgerHash: string, count: number) => {
          const row = await findBatchByTargetLedgerHash(targetLedgerHash);
          const signers = row?.da_signers;
          expect(signers).toEqual(expect.any(Array));
          expect(signers).toHaveLength(count);
        },
      );

      Then(
        "the rollback query for target ledger {string} should find no rollback-sensitive child rows",
        async (_ctx, targetLedgerHash: string) => {
          const summary = await queryFile<RollbackSummary>(
            world.db,
            "rollback-rows-by-target-ledger",
            {
              target_ledger_hash: targetLedgerHash,
            },
          );
          expect(summary.account_transactions).toHaveLength(0);
          expect(summary.inner_actions).toHaveLength(0);
          expect(summary.zkapp_events).toHaveLength(0);
          expect(summary.zkapp_actions).toHaveLength(0);
          expect(summary.transactions[0]?.status).toBe("reverted");
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
      expect(row.key).toBeDefined();
      expect(row.value).toBeDefined();
      return [row.key, parseParam(row.value)];
    }),
  );
}

function namesFromTable(table: DataTable): string[] {
  return table.map((row) => {
    expect(row.name).toBeDefined();
    return row.name;
  });
}

async function findBatchByTargetLedgerHash(targetLedgerHash: string): Promise<Row | undefined> {
  const rows = await runSurql<Row[]>(
    world.db,
    `SELECT * FROM batch WHERE target_ledger_hash = "${targetLedgerHash}";`,
  );
  const result = rows.at(-1)?.result;
  expect(result).toEqual(expect.any(Array));
  return result[0];
}

function defineAliases(
  first: StepDefinitions["Given"],
  second: StepDefinitions["And"],
): StepDefinitions["Given"] {
  return (name, callback) => {
    first(name, callback);
    second(name, callback);
  };
}
