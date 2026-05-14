import { NATS_SUBJECTS } from "@zeko/nats";

import type { L1WatcherConfig } from "#config";

export function describeL1Watcher(config: L1WatcherConfig): Record<string, unknown> {
  return {
    component: "l1-watcher",
    network: config.network,
    publishes: [
      NATS_SUBJECTS.l1Settlements,
      NATS_SUBJECTS.l1Rollbacks,
      NATS_SUBJECTS.l1OuterActions,
      NATS_SUBJECTS.l1BridgeEvents,
      NATS_SUBJECTS.health,
    ],
    endpoints: {
      liveConfigured: Boolean(config.minaLiveEndpoint),
      archiveConfigured: Boolean(config.minaArchiveEndpoint),
    },
  };
}
