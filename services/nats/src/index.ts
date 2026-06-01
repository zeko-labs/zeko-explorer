export * from "./constants.ts";
export * from "./da.ts";
export * from "./health.ts";
export * from "./l1.ts";
export * from "./l2.ts";
export * from "./message-id.ts";
export * from "./shared.ts";

import { DaSignatureEventSchema } from "./da.ts";
import { HealthEventSchema } from "./health.ts";
import {
  L1BridgeEventSchema,
  L1OuterActionEventSchema,
  L1RollbackEventSchema,
  L1SettlementEventSchema,
} from "./l1.ts";
import { L2FinalityEventSchema, L2TransactionEventSchema } from "./l2.ts";

export const EventSchemas = {
  l2Transactions: L2TransactionEventSchema,
  l2Finality: L2FinalityEventSchema,
  l1Settlements: L1SettlementEventSchema,
  l1Rollbacks: L1RollbackEventSchema,
  l1OuterActions: L1OuterActionEventSchema,
  l1BridgeEvents: L1BridgeEventSchema,
  daSignatures: DaSignatureEventSchema,
  health: HealthEventSchema,
} as const;
