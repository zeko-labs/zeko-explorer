export * from "./constants";
export * from "./da";
export * from "./health";
export * from "./l1";
export * from "./l2";
export * from "./message-id";
export * from "./shared";

import { DaSignatureEventSchema } from "./da";
import { HealthEventSchema } from "./health";
import {
  L1BridgeEventSchema,
  L1OuterActionEventSchema,
  L1RollbackEventSchema,
  L1SettlementEventSchema,
} from "./l1";
import { L2FinalityEventSchema, L2TransactionEventSchema } from "./l2";

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
