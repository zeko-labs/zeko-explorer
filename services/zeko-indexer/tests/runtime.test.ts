import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { DaSignatureEvent } from "@zeko/nats";
import { Field, PrivateKey, Signature } from "o1js";
import { expect } from "vitest";
import {
  type ConsumeEnvelope,
  createIndexerRuntime,
  InMemoryIndexerStore,
  type NatsEnvelopeSourceConfig,
  resolveIndexerRuntimeConfig,
} from "../src/public";

const feature = await loadFeature("tests/features/runtime.feature");
const timestamp = "2026-05-13T00:00:00.000Z";
type ZekoMultisigDaSignatureEvent = Extract<
  DaSignatureEvent,
  { implementation: "zeko-multisig-v1" }
>;

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let flushes: number;
  let config: ReturnType<typeof resolveIndexerRuntimeConfig>;
  let source: AsyncIterable<ConsumeEnvelope>;
  let sourceConfigs: NatsEnvelopeSourceConfig[];
  let surqlStatements: string[];
  let siblingCancelled: boolean;
  let runtimeError: unknown;
  let projectionEvents: string[];
  let configError: unknown;
  let directDaEvent: ZekoMultisigDaSignatureEvent;
  let malformedDaEvent: ZekoMultisigDaSignatureEvent;

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

  Scenario("Runtime config wires direct DA signature verification", ({ When, Then, And }) => {
    When("the runtime config is resolved with a signed direct DA event", () => {
      const privateKey = PrivateKey.random();
      const publicKey = privateKey.toPublicKey().toBase58();
      const ledgerHash = "101";
      const accSet = "202";
      directDaEvent = {
        schemaVersion: 1,
        implementation: "zeko-multisig-v1",
        ledgerHash,
        accSet,
        publicKey,
        signature: Signature.create(privateKey, [Field(ledgerHash), Field(accSet)]).toBase58(),
        instanceId: "da-runtime-a",
        signedAt: timestamp,
      };
      malformedDaEvent = { ...directDaEvent, signature: "not-a-signature" };
      config = resolveIndexerRuntimeConfig({
        ZEKO_INDEXER_DA_AUTHORIZED_SIGNERS: publicKey,
        ZEKO_INDEXER_DA_QUORUM: "2",
      });
    });

    Then("the runtime direct DA quorum is {int}", (_context, quorum: number) => {
      expect(config.indexer?.da?.quorum).toBe(quorum);
    });

    And("the runtime direct DA authorized signer is configured", () => {
      expect(config.indexer?.da?.authorizedSigners?.has(directDaEvent.publicKey)).toBe(true);
    });

    And("the runtime direct DA verification accepts the signed event", () => {
      expect(config.indexer?.da?.verifySignature?.(directDaEvent)).toBe(true);
    });

    And("the runtime direct DA verification rejects malformed signatures", () => {
      expect(config.indexer?.da?.verifySignature?.(malformedDaEvent)).toBe(false);
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

  Scenario("Runtime config rejects durable resume without startup hydration", ({ When, Then }) => {
    When("the runtime config is resolved with durable resume enabled", () => {
      configError = undefined;
      try {
        resolveIndexerRuntimeConfig({
          ZEKO_INDEXER_NATS_REPLAY_FROM_START: "false",
        });
      } catch (error) {
        configError = error;
      }
    });

    Then("the runtime config fails because startup hydration is not implemented", () => {
      expect(configError).toBeInstanceOf(Error);
      expect((configError as Error).message).toContain("startup hydration");
    });
  });

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

  Scenario("Runtime default projection writes ordinary L2 rows", ({ Given, When, Then, And }) => {
    Given(
      "a finite runtime envelope source with ordinary L2 transaction {string}",
      (_context, txHash: string) => {
        source = finiteSource([ordinaryL2Transaction(txHash)]);
      },
    );

    When("the runtime processes the source with the default SurrealDB projection", async () => {
      const capturedSurqlStatements: string[] = [];
      const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
        envelopeSources: [source],
        surrealClient: {
          async query(surql: string) {
            capturedSurqlStatements.push(surql);
          },
        },
      });
      await runtime.done;
      surqlStatements = capturedSurqlStatements;
    });

    Then("the SurrealDB SurrealQL writes the core account row", () => {
      expect(surqlStatements.join("\n")).toContain("UPSERT account:");
    });

    And("the SurrealDB SurrealQL writes the core transaction row", () => {
      expect(surqlStatements.join("\n")).toContain("UPSERT transaction:");
    });

    And("the SurrealDB SurrealQL writes the core account activity row", () => {
      expect(surqlStatements.join("\n")).toContain("UPSERT account_activity:");
    });
  });

  Scenario("Runtime aborts sibling sources after a projection failure", ({ Given, When, Then }) => {
    Given("a runtime source that fails during projection and an idle sibling source", () => {
      siblingCancelled = false;
      runtimeError = undefined;
      source = finiteSource([depositSubmission("aux-failure")]);
    });

    When("the runtime projection fails", async () => {
      const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
        envelopeSources: [source, cancellableIdleSource(() => (siblingCancelled = true))],
        writeProjection: async () => {
          throw new Error("projection failed");
        },
      });
      try {
        await runtime.done;
      } catch (error) {
        runtimeError = error;
      }
    });

    Then("the idle sibling source is cancelled", () => {
      expect(runtimeError).toBeInstanceOf(Error);
      expect(siblingCancelled).toBe(true);
    });
  });

  Scenario("Runtime serializes projection flushes across sources", ({ Given, When, Then }) => {
    Given("two finite runtime envelope sources with bridge deposits", () => {
      projectionEvents = [];
    });

    When("the runtime processes them through a delayed projection writer", async () => {
      const firstFlushCanFinish = deferred<void>();
      let flushCount = 0;
      const runtime = createIndexerRuntime(resolveIndexerRuntimeConfig(), {
        envelopeSources: [
          finiteSource([depositSubmission("aux-serialized-a")]),
          finiteSource([depositSubmission("aux-serialized-b")]),
        ],
        writeProjection: async () => {
          flushCount += 1;
          const currentFlush = flushCount;
          projectionEvents.push(`start-${currentFlush}`);
          if (currentFlush === 1) {
            await firstFlushCanFinish.promise;
          }
          projectionEvents.push(`finish-${currentFlush}`);
        },
      });

      await eventually(() => projectionEvents.includes("start-1"));
      await delay(10);
      firstFlushCanFinish.resolve();
      await runtime.done;
    });

    Then("projection flushes do not overlap", () => {
      expect(projectionEvents).toEqual(["start-1", "finish-1", "start-2", "finish-2"]);
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

function cancellableIdleSource(onReturn: () => void): AsyncIterable<ConsumeEnvelope> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<ConsumeEnvelope>>(() => {}),
        return: async () => {
          onReturn();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Condition was not met");
    }
    await delay(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ordinaryL2Transaction(txHash: string): ConsumeEnvelope {
  return {
    subject: "zeko.l2.transactions",
    payload: {
      source_ledger_hash: "ledger-core-0",
      target_ledger_hash: "ledger-core-1",
      timestamp,
      acc_set: "acc-set",
      command: {
        type: "signed_command",
        hash: txHash,
        sender: "B62qRuntimeSender",
        receiver: "B62qRuntimeReceiver",
        amount: "100",
        fee: "1",
        nonce: 4,
        memo: "runtime-core",
      },
      changed_accounts: [
        {
          index: 0,
          account: {
            public_key: "B62qRuntimeSender",
            balance: "900",
            nonce: 5,
            token_id: "1",
          },
        },
        {
          index: 1,
          account: {
            public_key: "B62qRuntimeReceiver",
            balance: "1100",
            nonce: 0,
            token_id: "1",
          },
        },
      ],
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
