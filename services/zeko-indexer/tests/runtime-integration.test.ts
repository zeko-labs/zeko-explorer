import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { expect } from "vitest";
import {
  runSql,
  startSurreal,
  stopSurreal,
  syncSchema,
} from "../../database/tests/lib/surreal-client";
import {
  type ConsumeEnvelope,
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
  let pendingEnvelope: Promise<IteratorResult<ConsumeEnvelope>> | undefined;
  let envelopeSource: AsyncGenerator<ConsumeEnvelope> | undefined;

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

  const syncNatsStreams = async () => {
    const connection = await connect({ servers: natsUrl });
    try {
      const manager = await jetstreamManager(connection);
      await manager.streams.add({ name: "zeko-l1", subjects: ["zeko.l1.*"] });
    } finally {
      await connection.close();
    }
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

  const publishWitness = async (aux: string) => {
    const connection = await connect({ servers: natsUrl });
    try {
      connection.publish(
        "zeko.l1.outer-actions",
        textEncoder.encode(
          JSON.stringify({
            schemaVersion: 1,
            provider: "mina",
            network: "zeko-m-devnet",
            source: "l1-watcher",
            observedAt: timestamp,
            block: {
              height: 5010,
              hash: "l1-block-5010",
              parentHash: "l1-block-5009",
              slot: 130,
              timestamp,
              confirmationDepth: 12,
            },
            subject: "zeko.l1.outer-actions",
            outerActionId: `runtime-witness-${aux}`,
            txHash: `l1-witness-${aux}`,
            accountUpdateId: `runtime-witness-au-${aux}`,
            actionIndex: 0,
            actionKind: "witness",
            actionState: {
              current: `runtime-witness-${aux}`,
              vector: ["a", "b", "c", "d", "e"],
              before: `runtime-before-${aux}`,
              after: `runtime-witness-${aux}`,
            },
            rawFields: ["1", aux],
            parsed: {
              kind: "witness",
              aux,
              slotRange: { lower: 100, upper: 130 },
            },
            archive: {
              transactionSequenceNumber: 5010,
              chainStatus: "canonical",
              distanceFromMaxBlockHeight: 0,
            },
          }),
        ),
      );
      await connection.flush();
    } finally {
      await connection.close();
    }
  };

  const consumeNextNatsMessage = async () => {
    envelopeSource ??= consumeNatsEnvelopes({
      servers: natsUrl,
      stream: "zeko-l1",
      subject: "zeko.l1.*",
      durableName: `zeko-indexer-runtime-${process.pid}`,
    });
    if (!envelopeSource) {
      throw new Error("NATS envelope source is not started");
    }
    const nextEnvelope = pendingEnvelope ?? envelopeSource.next();
    pendingEnvelope = undefined;
    const result = await Promise.race([
      nextEnvelope,
      delay(5_000).then(() => {
        throw new Error("Timed out waiting for NATS message");
      }),
    ]);
    if (!result || result.done || !result.value) {
      throw new Error("NATS envelope source ended before receiving a message");
    }
    await indexer.consume(result.value);
  };

  const RuntimeScenario =
    process.env.ZEKO_INDEXER_RUN_RUNTIME_INTEGRATION === "1" ? Scenario : Scenario.skip;

  RuntimeScenario(
    "Bridge event replays from JetStream into SurrealDB",
    ({ Given, When, And, Then }) => {
      Given("local NATS and SurrealDB are running", async () => {
        await startNats();
        await syncNatsStreams();
        surrealEndpoint = await startSurreal();
        db = `zeko_indexer_runtime_${process.pid}`;
        await syncSchema(db);
        store = new InMemoryIndexerStore();
        indexer = new ZekoIndexer(store);
      });
      When(
        "a deposit submission is published on NATS for aux {string}",
        async (_context, aux: string) => {
          await publishDeposit(aux);
        },
      );
      And("an L1 witness is published on NATS for aux {string}", async (_context, aux: string) => {
        await publishWitness(aux);
      });
      And("the indexer consumes two NATS messages from durable replay", async () => {
        await consumeNextNatsMessage();
        await consumeNextNatsMessage();
      });
      And("the bridge projection is flushed to SurrealDB twice", async () => {
        const client = createSurrealHttpClient({
          endpoint: surrealEndpoint,
          namespace: "database_test",
          database: db,
          username: "root",
          password: "root",
        });
        await writeBridgeProjectionToSurreal(client, store);
        await writeBridgeProjectionToSurreal(client, store);
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
      And("SurrealDB stores one L1 witness link", async () => {
        const result = await runSql<Array<{ count: number }>>(
          db,
          'SELECT count() AS count FROM l1_action_link WHERE role = "witness" GROUP ALL;',
        );
        const rows = result.at(-1)?.result ?? [];
        expect(rows).toEqual([{ count: 1 }]);
      });
    },
  );
});
