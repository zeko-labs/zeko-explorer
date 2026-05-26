import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  type ConsumeEnvelope,
  createIndexerRuntime,
  InMemoryIndexerStore,
  type NatsEnvelopeSourceConfig,
  resolveIndexerRuntimeConfig,
} from "../src/index";

const feature = await loadFeature("tests/runtime.feature");
const timestamp = "2026-05-13T00:00:00.000Z";

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let flushes: number;
  let config: ReturnType<typeof resolveIndexerRuntimeConfig>;
  let source: AsyncIterable<ConsumeEnvelope>;
  let sourceConfigs: NatsEnvelopeSourceConfig[];

  Scenario(
    "Runtime consumes envelopes and flushes projection after each message",
    ({ Given, When, Then, And }) => {
      Given(
        "a finite runtime envelope source with deposit aux {string}",
        (_context, aux: string) => {
          source = finiteSource([depositSubmission(aux), l1Witness(aux)]);
        },
      );

      When("the runtime processes the source", async () => {
        store = new InMemoryIndexerStore();
        flushes = 0;
        const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
          store,
          envelopeSources: [source],
          writeProjection: async () => {
            flushes += 1;
          },
        });
        await runtime.done;
      });

      Then("the runtime flushes projection {int} times", (_context, count: number) => {
        expect(flushes).toBe(count);
      });

      And(
        "runtime bridge operation for aux {string} has status {string}",
        (_context, aux: string, status: string) => {
          expect(store.bridgeOperationsByAux(aux)[0]?.status).toBe(status);
        },
      );
    },
  );

  Scenario("Runtime config creates one durable reader per source stream", ({ When, Then, And }) => {
    When("the runtime config is resolved from the environment", () => {
      config = resolveIndexerRuntimeConfig({
        ZEKO_INDEXER_NATS_SERVERS: "nats://127.0.0.1:4222",
      });
    });

    Then("the runtime consumes streams {string}", (_context, streams: string) => {
      expect(config.streams.map((stream) => stream.stream).join(",")).toBe(streams);
    });

    And("the runtime uses durable name {string}", (_context, durableName: string) => {
      expect(config.natsDurableName).toBe(durableName);
    });
  });

  Scenario(
    "Runtime rebuilds in-memory state from the start of durable streams",
    ({ When, Then }) => {
      When("the runtime source readers are created", async () => {
        sourceConfigs = [];
        const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
          createEnvelopeSource: (sourceConfig) => {
            sourceConfigs.push(sourceConfig);
            return finiteSource([]);
          },
          writeProjection: async () => {},
        });
        await runtime.done;
      });

      Then("every runtime source reader replays its stream from the beginning", () => {
        expect(sourceConfigs).toHaveLength(3);
        expect(sourceConfigs.every((sourceConfig) => sourceConfig.replayFromStart === true)).toBe(
          true,
        );
      });
    },
  );

  Scenario("Runtime config honors deployment environment variables", ({ When, Then, And }) => {
    When("the runtime config is resolved from the deployment environment", () => {
      config = resolveIndexerRuntimeConfig({
        NATS_URL: "nats://nats:4222",
        SURREAL_URL: "http://surrealdb:8000",
        SURREAL_NAMESPACE: "zeko",
        SURREAL_DATABASE: "explorer",
      });
    });

    Then("the runtime uses NATS server {string}", (_context, server: string) => {
      expect(config.natsServers).toEqual([server]);
    });

    And("the runtime uses Surreal endpoint {string}", (_context, endpoint: string) => {
      expect(config.surreal.endpoint).toBe(endpoint);
    });

    And("the runtime uses Surreal database {string}", (_context, database: string) => {
      expect(config.surreal.database).toBe(database);
    });
  });

  Scenario("Runtime stop cancels an idle source", ({ Given, When, Then }) => {
    let runtimeDone: Promise<void>;

    Given("an idle runtime envelope source", () => {
      store = new InMemoryIndexerStore();
      source = idleSource();
    });

    When("the runtime is started and stopped", async () => {
      const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
        store,
        envelopeSources: [source],
        writeProjection: async () => {},
      });
      runtimeDone = runtime.done;
      runtime.stop();
      await runtimeDone;
    });

    Then("the runtime exits", async () => {
      await expect(runtimeDone).resolves.toBeUndefined();
    });
  });
});

async function* finiteSource(envelopes: ConsumeEnvelope[]): AsyncGenerator<ConsumeEnvelope> {
  for (const envelope of envelopes) {
    yield envelope;
  }
}

function idleSource(): AsyncIterable<ConsumeEnvelope> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<ConsumeEnvelope>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

function depositSubmission(aux: string): ConsumeEnvelope {
  return {
    subject: "zeko.l1.bridge-events",
    payload: {
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
    },
  };
}

function l1Witness(aux: string): ConsumeEnvelope {
  return {
    subject: "zeko.l1.outer-actions",
    payload: {
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
    },
  };
}
