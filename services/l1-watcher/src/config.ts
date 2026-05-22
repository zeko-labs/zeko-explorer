import type { NetworkId } from "@zeko/domain";

export interface L1WatcherConfig {
  readonly network: NetworkId;
  readonly natsUrl: string;
  readonly surrealUrl: string;
  readonly minaLiveEndpoint?: string;
  readonly minaArchiveEndpoint?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): L1WatcherConfig {
  return {
    network: (env.ZEKO_NETWORK_ID ?? "zeko-m-local") as NetworkId,
    natsUrl: env.NATS_URL ?? "nats://localhost:4222",
    surrealUrl: env.SURREAL_URL ?? "http://localhost:8000",
    minaLiveEndpoint: env.MINA_LIVE_ENDPOINT,
    minaArchiveEndpoint: env.MINA_ARCHIVE_ENDPOINT,
  };
}
