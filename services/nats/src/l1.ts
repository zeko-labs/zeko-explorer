import type { InferOutput } from "valibot";
import { array, literal, optional, picklist, strictObject, tuple, union } from "valibot";

import { NATS_SUBJECTS } from "./constants";
import {
  L1EnvelopeSchema,
  L1ProviderSchema,
  NetworkIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  SchemaVersion1Schema,
  SlotRangeSchema,
} from "./shared";

export const L1SettlementEventTypeSchema = picklist(["detected", "finalized"]);

// The L1 watcher addendum defines exact versioned event contracts, so unknown fields fail fast.
export const L1SettlementEventSchema = strictObject({
  ...L1EnvelopeSchema.entries,
  subject: literal(NATS_SUBJECTS.l1Settlements),
  eventType: L1SettlementEventTypeSchema,
  settlementId: NonEmptyStringSchema,
  finalityLevel: picklist(["settling", "finalized"]),
  txHash: NonEmptyStringSchema,
  outerActionId: optional(NonEmptyStringSchema),
  commit: strictObject({
    ledgerHash: NonEmptyStringSchema,
    innerActionState: NonEmptyStringSchema,
    innerActionStateLength: NonNegativeIntegerSchema,
    synchronizedOuterActionState: NonEmptyStringSchema,
    synchronizedOuterActionStateLength: NonNegativeIntegerSchema,
    slotRange: SlotRangeSchema,
    rawFields: array(NonEmptyStringSchema),
  }),
});

export const L1OuterActionEventSchema = strictObject({
  ...L1EnvelopeSchema.entries,
  subject: literal(NATS_SUBJECTS.l1OuterActions),
  outerActionId: NonEmptyStringSchema,
  txHash: NonEmptyStringSchema,
  accountUpdateId: NonEmptyStringSchema,
  actionIndex: NonNegativeIntegerSchema,
  actionKind: picklist(["commit", "witness", "unknown"]),
  actionState: strictObject({
    current: NonEmptyStringSchema,
    vector: tuple([
      NonEmptyStringSchema,
      NonEmptyStringSchema,
      NonEmptyStringSchema,
      NonEmptyStringSchema,
      NonEmptyStringSchema,
    ]),
    before: optional(NonEmptyStringSchema),
    after: optional(NonEmptyStringSchema),
  }),
  rawFields: array(NonEmptyStringSchema),
  parsed: union([
    strictObject({
      kind: literal("commit"),
      ledgerHash: NonEmptyStringSchema,
      innerActionState: NonEmptyStringSchema,
      innerActionStateLength: NonNegativeIntegerSchema,
      synchronizedOuterActionState: NonEmptyStringSchema,
      synchronizedOuterActionStateLength: NonNegativeIntegerSchema,
      slotRange: SlotRangeSchema,
    }),
    strictObject({
      kind: literal("witness"),
      aux: NonEmptyStringSchema,
      slotRange: SlotRangeSchema,
    }),
    strictObject({ kind: literal("unknown") }),
  ]),
  archive: strictObject({
    transactionSequenceNumber: NonNegativeIntegerSchema,
    chainStatus: NonEmptyStringSchema,
    distanceFromMaxBlockHeight: NonNegativeIntegerSchema,
  }),
});

export const L1BridgeEventSchema = strictObject({
  ...L1EnvelopeSchema.entries,
  subject: literal(NATS_SUBJECTS.l1BridgeEvents),
  bridgeEventId: NonEmptyStringSchema,
  type: picklist(["deposit_submitted", "withdrawal_finalized", "deposit_cancelled"]),
  userPk: NonEmptyStringSchema,
  userPkSource: picklist(["account_update", "fee_payer", "event_log", "unknown"]),
  txHash: NonEmptyStringSchema,
  aux: optional(NonEmptyStringSchema),
  amount: optional(NonEmptyStringSchema),
  recipient: optional(NonEmptyStringSchema),
  operationIndex: optional(NonNegativeIntegerSchema),
  deposit: optional(
    strictObject({
      timeoutSlot: NonNegativeIntegerSchema,
      holderAccountL1: NonEmptyStringSchema,
      outerPk: NonEmptyStringSchema,
      rawActionFields: array(NonEmptyStringSchema),
    }),
  ),
  withdrawal: optional(
    strictObject({
      withdrawalIndex: optional(NonNegativeIntegerSchema),
      rawEventFields: array(NonEmptyStringSchema),
    }),
  ),
  cancel: optional(
    strictObject({
      cancelledDepositIndex: optional(NonNegativeIntegerSchema),
      helperAccountL1: NonEmptyStringSchema,
      prevNextCancelledDepositBefore: optional(NonEmptyStringSchema),
      prevNextCancelledDepositAfter: optional(NonEmptyStringSchema),
    }),
  ),
});

export const L1RollbackEventSchema = strictObject({
  schemaVersion: SchemaVersion1Schema,
  provider: L1ProviderSchema,
  network: NetworkIdSchema,
  source: literal("l1-watcher"),
  subject: literal(NATS_SUBJECTS.l1Rollbacks),
  rollbackId: NonEmptyStringSchema,
  detectedAt: NonEmptyStringSchema,
  commonAncestor: strictObject({
    height: NonNegativeIntegerSchema,
    hash: NonEmptyStringSchema,
  }),
  orphanedBlocks: array(
    strictObject({
      height: NonNegativeIntegerSchema,
      hash: NonEmptyStringSchema,
      parentHash: NonEmptyStringSchema,
    }),
  ),
  replacementBlocks: array(
    strictObject({
      height: NonNegativeIntegerSchema,
      hash: NonEmptyStringSchema,
      parentHash: NonEmptyStringSchema,
    }),
  ),
  affected: strictObject({
    settlementIds: array(NonEmptyStringSchema),
    outerActionIds: array(NonEmptyStringSchema),
    bridgeEventIds: array(NonEmptyStringSchema),
  }),
});

export type L1SettlementEventType = InferOutput<typeof L1SettlementEventTypeSchema>;
export type L1SettlementEvent = InferOutput<typeof L1SettlementEventSchema>;
export type L1OuterActionEvent = InferOutput<typeof L1OuterActionEventSchema>;
export type L1BridgeEvent = InferOutput<typeof L1BridgeEventSchema>;
export type L1RollbackEvent = InferOutput<typeof L1RollbackEventSchema>;
