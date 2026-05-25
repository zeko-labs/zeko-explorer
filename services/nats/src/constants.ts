export const NATS_STREAMS = {
  l2: "zeko-l2",
  l1: "zeko-l1",
  da: "zeko-da",
  health: "zeko-health",
} as const;

export const NATS_SUBJECTS = {
  l2Transactions: "zeko.l2.transactions",
  l2Finality: "zeko.l2.finality",
  l1Settlements: "zeko.l1.settlements",
  l1Rollbacks: "zeko.l1.rollbacks",
  l1OuterActions: "zeko.l1.outer-actions",
  l1BridgeEvents: "zeko.l1.bridge-events",
  daSignatures: "zeko.da.signatures",
  health: "zeko.health",
} as const;

export const NATS_SUBJECT_TO_STREAM = {
  [NATS_SUBJECTS.l2Transactions]: NATS_STREAMS.l2,
  [NATS_SUBJECTS.l2Finality]: NATS_STREAMS.l2,
  [NATS_SUBJECTS.l1Settlements]: NATS_STREAMS.l1,
  [NATS_SUBJECTS.l1Rollbacks]: NATS_STREAMS.l1,
  [NATS_SUBJECTS.l1OuterActions]: NATS_STREAMS.l1,
  [NATS_SUBJECTS.l1BridgeEvents]: NATS_STREAMS.l1,
  [NATS_SUBJECTS.daSignatures]: NATS_STREAMS.da,
  [NATS_SUBJECTS.health]: NATS_STREAMS.health,
} as const;
