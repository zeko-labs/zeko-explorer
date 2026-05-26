import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Field, PublicKey, Signature } from "o1js";
import { consumeNatsEnvelopes, type NatsEnvelopeSourceConfig } from "./adapters/nats.ts";
import { createSurrealHttpClient, writeIndexerProjectionToSurreal } from "./adapters/surreal.ts";
import { ZekoIndexer, type ZekoIndexerOptions } from "./indexer.ts";
import { type IndexerStore, InMemoryIndexerStore } from "./store.ts";
import type { ConsumeEnvelope, DaSignatureInput } from "./types.ts";

export type RuntimeStreamConfig = {
  stream: string;
  subject: string;
};

export type IndexerRuntimeConfig = {
  natsServers: string | string[];
  natsDurableName: string;
  natsNextExpiresMs: number;
  natsReplayFromStart: boolean;
  streams: RuntimeStreamConfig[];
  surreal: {
    endpoint: string;
    namespace: string;
    database: string;
    username: string;
    password: string;
  };
  indexer?: ZekoIndexerOptions;
};

export type IndexerRuntimeDependencies = {
  store?: IndexerStore;
  indexer?: ZekoIndexer;
  envelopeSources?: AsyncIterable<ConsumeEnvelope>[];
  createEnvelopeSource?: (config: NatsEnvelopeSourceConfig) => AsyncIterable<ConsumeEnvelope>;
  writeProjection?: (store: IndexerStore) => Promise<void>;
  signal?: AbortSignal;
};

export type IndexerRuntime = {
  store: IndexerStore;
  done: Promise<void>;
  stop(): void;
};

const DEFAULT_STREAMS: RuntimeStreamConfig[] = [
  { stream: "zeko-l1", subject: "zeko.l1.*" },
  { stream: "zeko-l2", subject: "zeko.l2.*" },
  { stream: "zeko-da", subject: "zeko.da.*" },
];

export function resolveIndexerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): IndexerRuntimeConfig {
  const natsReplayFromStart = booleanEnv(env.ZEKO_INDEXER_NATS_REPLAY_FROM_START, true);
  if (!natsReplayFromStart) {
    throw new Error(
      "Durable resume requires startup hydration from SurrealDB; set ZEKO_INDEXER_NATS_REPLAY_FROM_START=true",
    );
  }
  const authorizedDaSigners = new Set(splitCsv(env.ZEKO_INDEXER_DA_AUTHORIZED_SIGNERS ?? ""));

  return {
    natsServers: splitCsv(env.ZEKO_INDEXER_NATS_SERVERS ?? env.NATS_URL ?? "nats://127.0.0.1:4222"),
    natsDurableName: env.ZEKO_INDEXER_NATS_DURABLE ?? "zeko-indexer",
    natsNextExpiresMs: positiveInteger(env.ZEKO_INDEXER_NATS_NEXT_EXPIRES_MS, 1_000),
    natsReplayFromStart,
    streams: [...DEFAULT_STREAMS],
    surreal: {
      endpoint: env.ZEKO_INDEXER_SURREAL_ENDPOINT ?? env.SURREAL_URL ?? "http://127.0.0.1:8000",
      namespace: env.ZEKO_INDEXER_SURREAL_NAMESPACE ?? env.SURREAL_NAMESPACE ?? "zeko",
      database: env.ZEKO_INDEXER_SURREAL_DATABASE ?? env.SURREAL_DATABASE ?? "zeko",
      username: env.ZEKO_INDEXER_SURREAL_USERNAME ?? env.SURREAL_USER ?? "root",
      password: env.ZEKO_INDEXER_SURREAL_PASSWORD ?? env.SURREAL_PASSWORD ?? "root",
    },
    indexer: {
      da: {
        authorizedSigners: authorizedDaSigners,
        quorum: positiveInteger(env.ZEKO_INDEXER_DA_QUORUM, 1),
        verifySignature: verifyZekoMultisigDaSignature,
      },
      bridge: {
        innerActionPublicKeys: new Set(splitCsv(env.ZEKO_INDEXER_BRIDGE_INNER_PUBLIC_KEYS ?? "")),
        withdrawalDelaySlots: positiveInteger(env.ZEKO_INDEXER_BRIDGE_WITHDRAWAL_DELAY_SLOTS, 100),
      },
    },
  };
}

export function verifyZekoMultisigDaSignature(event: DaSignatureInput): boolean {
  if (event.implementation !== "zeko-multisig-v1") {
    return false;
  }
  try {
    return Signature.fromBase58(event.signature)
      .verify(PublicKey.fromBase58(event.publicKey), [Field(event.ledgerHash), Field(event.accSet)])
      .toBoolean();
  } catch {
    return false;
  }
}

export function createIndexerRuntime(
  config: IndexerRuntimeConfig,
  dependencies: IndexerRuntimeDependencies = {},
): IndexerRuntime {
  const abortController = new AbortController();
  dependencies.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const store = dependencies.store ?? new InMemoryIndexerStore();
  const indexer = dependencies.indexer ?? new ZekoIndexer(store, config.indexer);
  const surrealClient = createSurrealHttpClient(config.surreal);
  const writeProjection =
    dependencies.writeProjection ??
    ((state: IndexerStore) => writeIndexerProjectionToSurreal(surrealClient, state));
  const envelopeSources =
    dependencies.envelopeSources ??
    createRuntimeEnvelopeSources(
      config,
      dependencies.createEnvelopeSource ?? consumeNatsEnvelopes,
      abortController.signal,
    );

  return {
    store,
    done: runRuntimeSources(envelopeSources, indexer, store, writeProjection, abortController),
    stop() {
      abortController.abort();
    },
  };
}

function createRuntimeEnvelopeSources(
  config: IndexerRuntimeConfig,
  createEnvelopeSource: (config: NatsEnvelopeSourceConfig) => AsyncIterable<ConsumeEnvelope>,
  signal: AbortSignal,
): AsyncIterable<ConsumeEnvelope>[] {
  return config.streams.map((stream) =>
    createEnvelopeSource({
      servers: config.natsServers,
      stream: stream.stream,
      subject: stream.subject,
      durableName: `${config.natsDurableName}-${stream.stream}`,
      nextExpiresMs: config.natsNextExpiresMs,
      replayFromStart: config.natsReplayFromStart,
      signal,
    }),
  );
}

export async function runIndexerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = resolveIndexerRuntimeConfig(env);
  if (env.ZEKO_INDEXER_CHECK_CONFIG === "1") {
    return;
  }

  const runtime = createIndexerRuntime(config);
  const stop = () => runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runtime.done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export function isDirectEntrypoint(importMetaUrl: string, argv = process.argv): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && resolve(fileURLToPath(importMetaUrl)) === resolve(entrypoint);
}

async function runRuntimeSource(
  source: AsyncIterable<ConsumeEnvelope>,
  indexer: ZekoIndexer,
  writeProjection: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = abortPromise(signal);
  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result === ABORTED || result.done) {
        return;
      }
      await indexer.consume(result.value);
      await writeProjection();
    }
  } finally {
    await iterator.return?.();
  }
}

async function runRuntimeSources(
  envelopeSources: AsyncIterable<ConsumeEnvelope>[],
  indexer: ZekoIndexer,
  store: IndexerStore,
  writeProjection: (store: IndexerStore) => Promise<void>,
  abortController: AbortController,
): Promise<void> {
  const flushProjection = serializedProjectionWriter(store, writeProjection);
  const runners = envelopeSources.map((source) =>
    runRuntimeSource(source, indexer, flushProjection, abortController.signal),
  );
  try {
    await Promise.all(runners);
  } catch (error) {
    abortController.abort();
    await Promise.allSettled(runners);
    throw error;
  }
}

function serializedProjectionWriter(
  store: IndexerStore,
  writeProjection: (store: IndexerStore) => Promise<void>,
): () => Promise<void> {
  let queue = Promise.resolve();
  return () => {
    const flush = queue.then(() => writeProjection(store));
    queue = flush.catch(() => undefined);
    return flush;
  };
}

const ABORTED = Symbol("aborted");

function abortPromise(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
