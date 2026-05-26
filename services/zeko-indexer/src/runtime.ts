import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumeNatsEnvelopes } from "./adapters/nats.ts";
import { createSurrealHttpClient, writeBridgeProjectionToSurreal } from "./adapters/surreal.ts";
import { ZekoIndexer, type ZekoIndexerOptions } from "./indexer.ts";
import { type IndexerStore, InMemoryIndexerStore } from "./store.ts";
import type { ConsumeEnvelope } from "./types.ts";

export type RuntimeStreamConfig = {
  stream: string;
  subject: string;
};

export type IndexerRuntimeConfig = {
  natsServers: string | string[];
  natsDurableName: string;
  natsNextExpiresMs: number;
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
  return {
    natsServers: splitCsv(env.ZEKO_INDEXER_NATS_SERVERS ?? "nats://127.0.0.1:4222"),
    natsDurableName: env.ZEKO_INDEXER_NATS_DURABLE ?? "zeko-indexer",
    natsNextExpiresMs: positiveInteger(env.ZEKO_INDEXER_NATS_NEXT_EXPIRES_MS, 1_000),
    streams: [...DEFAULT_STREAMS],
    surreal: {
      endpoint: env.ZEKO_INDEXER_SURREAL_ENDPOINT ?? "http://127.0.0.1:8000",
      namespace: env.ZEKO_INDEXER_SURREAL_NAMESPACE ?? "zeko",
      database: env.ZEKO_INDEXER_SURREAL_DATABASE ?? "zeko",
      username: env.ZEKO_INDEXER_SURREAL_USERNAME ?? "root",
      password: env.ZEKO_INDEXER_SURREAL_PASSWORD ?? "root",
    },
    indexer: {
      bridge: {
        innerActionPublicKeys: new Set(splitCsv(env.ZEKO_INDEXER_BRIDGE_INNER_PUBLIC_KEYS ?? "")),
        withdrawalDelaySlots: positiveInteger(env.ZEKO_INDEXER_BRIDGE_WITHDRAWAL_DELAY_SLOTS, 100),
      },
    },
  };
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
    ((state: IndexerStore) => writeBridgeProjectionToSurreal(surrealClient, state));
  const envelopeSources =
    dependencies.envelopeSources ??
    config.streams.map((stream) =>
      consumeNatsEnvelopes({
        servers: config.natsServers,
        stream: stream.stream,
        subject: stream.subject,
        durableName: `${config.natsDurableName}-${stream.stream}`,
        nextExpiresMs: config.natsNextExpiresMs,
      }),
    );

  return {
    store,
    done: Promise.all(
      envelopeSources.map((source) =>
        runRuntimeSource(source, indexer, store, writeProjection, abortController.signal),
      ),
    ).then(() => undefined),
    stop() {
      abortController.abort();
    },
  };
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
  store: IndexerStore,
  writeProjection: (store: IndexerStore) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  for await (const envelope of source) {
    if (signal.aborted) {
      return;
    }
    await indexer.consume(envelope);
    await writeProjection(store);
  }
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
