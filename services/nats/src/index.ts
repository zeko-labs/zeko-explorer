import {
  type InferOutput,
  integer,
  minLength,
  minValue,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  string,
  unknown,
} from "valibot";

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

export const NetworkIdSchema = picklist([
  "zeko-m-local",
  "zeko-m-devnet",
  "zeko-m-alphanet",
  "zeko-m-mainnet",
  "zeko-e-testnet",
  "zeko-e-mainnet",
]);

const NonEmptyString = pipe(string(), minLength(1));
const NonNegativeInteger = pipe(number(), integer(), minValue(0));

export const FinalityEventSchema = object({
  network: NetworkIdSchema,
  level: picklist(["proved", "committed"]),
  ledgerHash: NonEmptyString,
  timestamp: string(),
});

export const SettlementEventSchema = object({
  network: NetworkIdSchema,
  targetLedgerHash: NonEmptyString,
  l1TransactionHash: NonEmptyString,
  blockHeight: NonNegativeInteger,
  confirmations: NonNegativeInteger,
  timestamp: string(),
});

export const HealthEventSchema = object({
  network: NetworkIdSchema,
  component: NonEmptyString,
  status: picklist(["ok", "degraded", "down"]),
  timestamp: string(),
  details: optional(record(string(), unknown())),
});

export type FinalityEvent = InferOutput<typeof FinalityEventSchema>;
export type SettlementEvent = InferOutput<typeof SettlementEventSchema>;
export type HealthEvent = InferOutput<typeof HealthEventSchema>;
