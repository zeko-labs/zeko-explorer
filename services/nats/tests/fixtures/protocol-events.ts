import { NATS_SUBJECTS, type NetworkId } from "../../src/index.ts";

const network = "zeko-m-devnet" satisfies NetworkId;
const observedAt = "2026-05-13T00:00:00.000Z";

const l1Envelope = {
  schemaVersion: 1,
  provider: "mina",
  network,
  source: "l1-watcher",
  observedAt,
  block: {
    height: 100,
    hash: "state-hash-100",
    parentHash: "state-hash-99",
    slot: 200,
    timestamp: observedAt,
    confirmationDepth: 12,
  },
} as const;

export const validFixtures = {
  l2Transactions: {
    source_ledger_hash: "ledger-0",
    target_ledger_hash: "ledger-1",
    timestamp: 1_779_840_000_000,
    acc_set: "123456789",
    command: {
      type: "signed_command",
      hash: "tx-hash-1",
      sender: "B62qsender",
      receiver: "B62qreceiver",
      amount: "1000000000",
      fee: "1000000",
      nonce: 5,
      memo: "deposit",
    },
    changed_accounts: [
      {
        index: 42,
        account: {
          public_key: "B62qsender",
          balance: "9000000000",
          nonce: 6,
          delegate: "B62qdelegate",
          token_id: "1",
          zkapp_state: ["0", "1", "2", "3", "4", "5", "6", "7"],
          permissions: {},
          timing: {},
        },
      },
    ],
    genesis: false,
  },
  l2Finality: {
    ledger_hash: "ledger-1",
    level: "proved",
    source_ledger_hash: "ledger-0",
    timestamp: observedAt,
  },
  l1Settlements: {
    ...l1Envelope,
    subject: NATS_SUBJECTS.l1Settlements,
    eventType: "detected",
    settlementId: "tx-1:au-1:0",
    finalityLevel: "settling",
    txHash: "tx-1",
    outerActionId: "tx-1:au-1:0",
    commit: {
      ledgerHash: "ledger-1",
      innerActionState: "inner-state",
      innerActionStateLength: 7,
      synchronizedOuterActionState: "outer-state",
      synchronizedOuterActionStateLength: 9,
      slotRange: { lower: 100, upper: 120 },
      rawFields: ["ledger-1", "inner-state", "7"],
    },
  },
  l1Rollbacks: {
    schemaVersion: 1,
    provider: "mina",
    network,
    source: "l1-watcher",
    subject: NATS_SUBJECTS.l1Rollbacks,
    rollbackId: "state-hash-99:state-hash-100:state-hash-100b",
    detectedAt: observedAt,
    commonAncestor: { height: 99, hash: "state-hash-99" },
    orphanedBlocks: [{ height: 100, hash: "state-hash-100", parentHash: "state-hash-99" }],
    replacementBlocks: [{ height: 100, hash: "state-hash-100b", parentHash: "state-hash-99" }],
    affected: {
      settlementIds: ["tx-1:au-1:0"],
      outerActionIds: ["tx-1:au-1:0"],
      bridgeEventIds: ["tx-2:au-2:0:deposit_submitted"],
    },
  },
  l1OuterActions: {
    ...l1Envelope,
    subject: NATS_SUBJECTS.l1OuterActions,
    outerActionId: "tx-1:au-1:0",
    txHash: "tx-1",
    accountUpdateId: "au-1",
    actionIndex: 0,
    actionKind: "commit",
    actionState: {
      current: "outer-current",
      vector: ["a", "b", "c", "d", "e"],
      before: "outer-before",
      after: "outer-after",
    },
    rawFields: ["ledger-1", "inner-state", "7"],
    parsed: {
      kind: "commit",
      ledgerHash: "ledger-1",
      innerActionState: "inner-state",
      innerActionStateLength: 7,
      synchronizedOuterActionState: "outer-state",
      synchronizedOuterActionStateLength: 9,
      slotRange: { lower: 100, upper: 120 },
    },
    archive: {
      transactionSequenceNumber: 123,
      chainStatus: "canonical",
      distanceFromMaxBlockHeight: 0,
    },
  },
  l1BridgeEvents: {
    ...l1Envelope,
    subject: NATS_SUBJECTS.l1BridgeEvents,
    bridgeEventId: "tx-2:au-2:0:deposit_submitted",
    type: "deposit_submitted",
    userPk: "B62quser",
    userPkSource: "account_update",
    txHash: "tx-2",
    aux: "deposit-aux",
    amount: "5000000000",
    recipient: "B62qrecipient",
    operationIndex: 0,
    deposit: {
      timeoutSlot: 300,
      holderAccountL1: "B62qholder",
      outerPk: "B62qouter",
      rawActionFields: ["deposit-aux", "5000000000"],
    },
  },
  daSignatures: {
    schemaVersion: 1,
    implementation: "zeko-multisig-v1",
    ledgerHash: "ledger-1",
    accSet: "123456789",
    publicKey: "B62qdaoperator",
    signature: "abcdef0123456789",
    instanceId: "4f985f64-6b10-43f4-9a8f-26f83dbdc4ed",
    signedAt: observedAt,
  },
  daSignaturesCelestia: {
    schemaVersion: 1,
    implementation: "celestia-v1",
    ledgerHash: "ledger-1",
    celestia: {
      height: 1_234_567,
      namespace: "0xzeko",
      commitment: "0xcommitment",
      inclusionProof: "base64-proof",
    },
    publishedAt: observedAt,
  },
  sequencerHealth: {
    service: "sequencer-nats-publisher",
    last_published_hash: "ledger-1",
    last_published_at: observedAt,
    unproved_hash: "ledger-2",
  },
  l1WatcherHealth: {
    schemaVersion: 1,
    service: "l1-watcher",
    instanceId: "40f11d27-e3d1-4149-8716-202d62063af6",
    provider: "mina",
    network,
    status: "degraded",
    observedAt,
    l1LiveNode: {
      connected: false,
      lastError: "daemon unavailable",
    },
    l1ArchiveApi: {
      connected: true,
      pendingMaxBlockHeight: 100,
      canonicalMaxBlockHeight: 99,
      lagBlocks: 1,
    },
    bridgeBackfill: {
      available: true,
      lastBridgeEventHeight: 98,
      lagBlocks: 2,
    },
    nats: {
      connected: true,
      pendingBufferSize: 0,
    },
    surrealdb: {
      connected: true,
      lastWriteAt: observedAt,
    },
    tracked: {
      settlements: 3,
      bridgeEvents: 5,
      canonicalWindowBlocks: 290,
    },
    limitations: ["l1_live_unavailable"],
  },
  daNodeHealth: {
    service: "da-node",
    instanceId: "4f985f64-6b10-43f4-9a8f-26f83dbdc4ed",
    publicKey: "B62qdaoperator",
    implementation: "zeko-multisig-v1",
    publishedAt: observedAt,
    lastSignedHash: "ledger-1",
    lastSignedAt: observedAt,
    natsConnected: true,
  },
} as const;

export const invalidFixtures = {
  l2Transactions: {
    ...validFixtures.l2Transactions,
    target_ledger_hash: "",
  },
  l2Finality: {
    ...validFixtures.l2Finality,
    level: "settled",
  },
  l1Settlements: {
    ...validFixtures.l1Settlements,
    provider: "bitcoin",
  },
  l1Rollbacks: {
    ...validFixtures.l1Rollbacks,
    schemaVersion: 2,
  },
  l1OuterActions: {
    ...validFixtures.l1OuterActions,
    actionState: {
      ...validFixtures.l1OuterActions.actionState,
      vector: ["a", "b"],
    },
  },
  l1BridgeEvents: {
    ...validFixtures.l1BridgeEvents,
    userPkSource: "memo",
  },
  daSignatures: {
    ...validFixtures.daSignatures,
    publicKey: "",
  },
  daSignaturesCelestia: {
    ...validFixtures.daSignaturesCelestia,
    celestia: {
      ...validFixtures.daSignaturesCelestia.celestia,
      height: -1,
    },
  },
  sequencerHealth: {
    ...validFixtures.sequencerHealth,
    last_published_hash: "",
  },
  l1WatcherHealth: {
    ...validFixtures.l1WatcherHealth,
    status: "unknown",
  },
  daNodeHealth: {
    ...validFixtures.daNodeHealth,
    natsConnected: "yes",
  },
} as const;
