# L1 Watcher NATS Event Schemas

These are the payload contracts for `packages/nats-protocol`.

## Shared Envelope

```ts
export type L1Envelope = {
  schemaVersion: 1;
  network: "zeko-m-devnet" | "zeko-m-alphanet" | "zeko-m-mainnet";
  source: "l1-watcher";
  observedAt: string;
  block: {
    height: number;
    stateHash: string;
    parentHash: string;
    slot: number;
    timestamp?: string;
    confirmationDepth: number;
  };
};
```

## `zeko.l1.settlements`

```ts
export type L1SettlementEvent = L1Envelope & {
  subject: "zeko.l1.settlements";
  eventType: "detected" | "finalized";
  settlementId: string;
  finalityLevel: "settling" | "finalized";
  txHash: string;
  outerActionId?: string;
  commit: {
    ledgerHash: string;
    innerActionState: string;
    innerActionStateLength: number;
    synchronizedOuterActionState: string;
    synchronizedOuterActionStateLength: number;
    slotRange: { lower: number; upper: number };
    rawFields: string[];
  };
};
```

ID format:

- `settlementId = ${txHash}:${accountUpdateId}:${actionIndex}`
- `Nats-Msg-Id = l1-settlement:${network}:${settlementId}:${eventType}:${block.confirmationDepth}`
- for `eventType: "finalized"`, use `l1-settlement:${network}:${settlementId}:finalized`

## `zeko.l1.outer-actions`

```ts
export type L1OuterActionEvent = L1Envelope & {
  subject: "zeko.l1.outer-actions";
  outerActionId: string;
  txHash: string;
  accountUpdateId: string;
  actionIndex: number;
  actionKind: "commit" | "witness" | "unknown";
  actionState: {
    current: string;
    vector: [string, string, string, string, string];
    before?: string;
    after?: string;
  };
  rawFields: string[];
  parsed:
    | {
        kind: "commit";
        ledgerHash: string;
        innerActionState: string;
        innerActionStateLength: number;
        synchronizedOuterActionState: string;
        synchronizedOuterActionStateLength: number;
        slotRange: { lower: number; upper: number };
      }
    | {
        kind: "witness";
        aux: string;
        slotRange: { lower: number; upper: number };
      }
    | { kind: "unknown" };
  archive: {
    transactionSequenceNumber: number;
    chainStatus: string;
    distanceFromMaxBlockHeight: number;
  };
};
```

ID format:

- `outerActionId = ${txHash}:${accountUpdateId}:${actionIndex}`
- `Nats-Msg-Id = l1-outer-action:${network}:${outerActionId}`

## `zeko.l1.bridge-events`

```ts
export type L1BridgeEvent = L1Envelope & {
  subject: "zeko.l1.bridge-events";
  bridgeEventId: string;
  type: "deposit_submitted" | "withdrawal_finalized" | "deposit_cancelled";
  userPk: string;
  userPkSource: "account_update" | "fee_payer";
  txHash: string;
  aux?: string;
  amount?: string;
  recipient?: string;
  operationIndex?: number;

  deposit?: {
    timeoutSlot: number;
    holderAccountL1: string;
    outerPk: string;
    rawActionFields: string[];
  };

  withdrawal?: {
    withdrawalIndex?: number;
    rawEventFields: string[];
  };

  cancel?: {
    cancelledDepositIndex?: number;
    helperAccountL1: string;
    prevNextCancelledDepositBefore?: string;
    prevNextCancelledDepositAfter?: string;
  };
};
```

ID format:

- `bridgeEventId = ${txHash}:${accountUpdateId}:${actionOrEventIndex}:${type}`
- `Nats-Msg-Id = l1-bridge-event:${network}:${bridgeEventId}`

The watcher must not include `aux_sequence`.

## `zeko.l1.rollbacks`

```ts
export type L1RollbackEvent = {
  schemaVersion: 1;
  network: "zeko-m-devnet" | "zeko-m-alphanet" | "zeko-m-mainnet";
  source: "l1-watcher";
  subject: "zeko.l1.rollbacks";
  rollbackId: string;
  detectedAt: string;
  commonAncestor: {
    height: number;
    stateHash: string;
  };
  orphanedBlocks: Array<{
    height: number;
    stateHash: string;
    parentHash: string;
  }>;
  replacementBlocks: Array<{
    height: number;
    stateHash: string;
    parentHash: string;
  }>;
  affected: {
    settlementIds: string[];
    outerActionIds: string[];
    bridgeEventIds: string[];
  };
};
```

ID format:

- `rollbackId = ${commonAncestor.stateHash}:${orphanedBlocks[0].stateHash}:${replacementBlocks[0]?.stateHash ?? "none"}`
- `Nats-Msg-Id = l1-rollback:${network}:${rollbackId}`

## `zeko.health`

```ts
export type L1WatcherHealth = {
  schemaVersion: 1;
  service: "l1-watcher";
  instanceId: string;
  network: string;
  status: "healthy" | "degraded" | "down";
  observedAt: string;
  l1LiveNode: {
    connected: boolean;
    syncStatus?: string;
    tipHeight?: number;
    tipStateHash?: string;
    lastBlockAt?: string;
    lastError?: string;
  };
  l1ArchiveApi: {
    connected: boolean;
    pendingMaxBlockHeight?: number;
    canonicalMaxBlockHeight?: number;
    lastOuterActionHeight?: number;
    lagBlocks?: number;
    lastError?: string;
  };
  bridgeBackfill: {
    available: boolean;
    lastBridgeEventHeight?: number;
    lagBlocks?: number;
    lastError?: string;
  };
  nats: {
    connected: boolean;
    pendingBufferSize: number;
    lastPublishError?: string;
  };
  surrealdb: {
    connected: boolean;
    lastWriteAt?: string;
    lastError?: string;
  };
  tracked: {
    settlements: number;
    bridgeEvents: number;
    canonicalWindowBlocks: number;
  };
  limitations?: string[];
};
```

Common `limitations` values:

- `l1_daemon_unavailable`
- `l1_archive_unavailable`
- `historical_bridge_events_unavailable`
- `bridge_event_gap_unrecoverable`
- `helper_cancel_counter_unreconciled`
- `nats_unavailable`
- `surrealdb_unavailable`

Downstream APIs should expose equivalent data quality metadata on bridge and batch records so the UI can render partial data without blocking.
