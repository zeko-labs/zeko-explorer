import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { connect } from "@nats-io/transport-node";
import { expect } from "vitest";
import {
  runSql,
  startSurreal,
  stopSurreal,
  syncSchema,
} from "../../database/tests/lib/surreal-client";
import {
  consumeNatsEnvelopes,
  createSurrealHttpClient,
  InMemoryIndexerStore,
  writeBridgeProjectionToSurreal,
  ZekoIndexer,
} from "../src/index";

const feature = await loadFeature("tests/runtime-integration.feature");
const timestamp = "2026-05-13T00:00:00.000Z";
const textEncoder = new TextEncoder();

describeFeature(feature, ({ Scenario, AfterAllScenarios }) => {
  let natsServer: ChildProcessWithoutNullStreams | undefined;
  let natsUrl: string;
  let surrealEndpoint: string;
  let db: string;
  let store: InMemoryIndexerStore;
  let indexer: ZekoIndexer;
  let pendingEnvelope: ReturnType<AsyncIterator<unknown>["next"]> | undefined;
  let envelopeSource: AsyncGenerator | undefined;

  AfterAllScenarios(async () => {
    await envelopeSource?.return(undefined);
    if (natsServer) {
      natsServer.kill("SIGINT");
      natsServer = undefined;
    }
    await stopSurreal();
  });

  const startNats = async () => {
    if (natsServer) {
      return;
    }
    const port = 4229;
    natsUrl = `nats://127.0.0.1:${port}`;
    const name = `zeko-indexer-nats-${process.pid}-${port}`;
    natsServer = spawn("docker", [
      "run",
      "--rm",
      "--name",
      name,
      "--publish",
      `127.0.0.1:${port}:4222`,
      "nats:2.10-alpine",
      "-js",
    ]);
    natsServer.stderr.on("data", (chunk: Buffer) => {
      if (process.env.ZEKO_INDEXER_TEST_DEBUG !== undefined) process.stderr.write(chunk);
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const connection = await connect({ servers: natsUrl });
        await connection.close();
        return;
      } catch {
        await delay(250);
      }
    }
    throw new Error("NATS did not become ready");
  };

  const publishDeposit = async (aux: string) => {
    const connection = await connect({ servers: natsUrl });
    try {
      connection.publish(
        "zeko.l1.bridge-events",
        textEncoder.encode(
          JSON.stringify({
            schemaVersion: 1,
            provider: "mina",
            network: "zeko-m-devnet",
            source: "l1-watcher",
            observedAt: timestamp,
            block: {
              height: 5000,
              hash: "l1-block-5000",
              parentHash: "l1-block-4999",
              slot: 120,
              timestamp,
              confirmationDepth: 12,
            },
            subject: "zeko.l1.bridge-events",
            bridgeEventId: `runtime-${aux}`,
            type: "deposit_submitted",
            userPk: "B62qRuntime",
            userPkSource: "account_update",
            txHash: `l1-submit-${aux}`,
            aux,
            amount: "42",
            recipient: "B62qRecipient",
            operationIndex: 0,
            deposit: {
              timeoutSlot: 500,
              holderAccountL1: "B62qHolder",
              outerPk: "B62qOuter",
              rawActionFields: [aux, "42"],
            },
          }),
        ),
      );
      await connection.flush();
    } finally {
      await connection.close();
    }
  };

  Scenario("Bridge event flows from NATS into SurrealDB", ({ Given, When, And, Then }) => {
    Given("local NATS and SurrealDB are running", async () => {
      await startNats();
      surrealEndpoint = await startSurreal();
      db = `zeko_indexer_runtime_${process.pid}`;
      await syncSchema(db);
      store = new InMemoryIndexerStore();
      indexer = new ZekoIndexer(store);
      envelopeSource = consumeNatsEnvelopes({ servers: natsUrl, subject: "zeko.l1.bridge-events" });
      pendingEnvelope = envelopeSource.next();
      await delay(100);
    });
    When(
      "a deposit submission is published on NATS for aux {string}",
      async (_context, aux: string) => {
        await publishDeposit(aux);
      },
    );
    And("the indexer consumes one NATS message", async () => {
      const result = await Promise.race([
        pendingEnvelope,
        delay(5_000).then(() => {
          throw new Error("Timed out waiting for NATS message");
        }),
      ]);
      if (!result || result.done || !result.value) {
        throw new Error("NATS envelope source ended before receiving a message");
      }
      await indexer.consume(result.value);
    });
    And("the bridge projection is flushed to SurrealDB", async () => {
      await writeBridgeProjectionToSurreal(
        createSurrealHttpClient({
          endpoint: surrealEndpoint,
          namespace: "database_test",
          database: db,
          username: "root",
          password: "root",
        }),
        store,
      );
    });
    Then(
      "SurrealDB stores a bridge operation for aux {string} with status {string}",
      async (_context, aux: string, status: string) => {
        const result = await runSql<Array<{ aux: string; status: string }>>(
          db,
          `SELECT aux, status FROM bridge_operation WHERE aux = "${aux}";`,
        );
        const rows = result.at(-1)?.result ?? [];
        expect(rows).toEqual([{ aux, status }]);
      },
    );
  });
});
