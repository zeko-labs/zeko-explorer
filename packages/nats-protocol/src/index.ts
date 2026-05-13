import { z } from "zod";

export const NATS_STREAMS = {
  l2: "zeko-l2",
  l1: "zeko-l1",
  health: "zeko-health",
} as const;

export const NATS_SUBJECTS = {
  l2Transactions: "zeko.l2.transactions",
  l2Finality: "zeko.l2.finality",
  l1Settlements: "zeko.l1.settlements",
  l1Rollbacks: "zeko.l1.rollbacks",
  l1OuterActions: "zeko.l1.outer-actions",
  l1BridgeEvents: "zeko.l1.bridge-events",
  health: "zeko.health",
} as const;

export const NetworkIdSchema = z.enum([
  "zeko-m-local",
  "zeko-m-devnet",
  "zeko-m-alphanet",
  "zeko-m-mainnet",
  "zeko-e-testnet",
  "zeko-e-mainnet",
]);

export const FinalityEventSchema = z.object({
  network: NetworkIdSchema,
  level: z.enum(["proved", "committed"]),
  ledgerHash: z.string().min(1),
  timestamp: z.string().datetime(),
});

export const SettlementEventSchema = z.object({
  network: NetworkIdSchema,
  targetLedgerHash: z.string().min(1),
  l1TransactionHash: z.string().min(1),
  blockHeight: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

export const HealthEventSchema = z.object({
  network: NetworkIdSchema,
  component: z.string().min(1),
  status: z.enum(["ok", "degraded", "down"]),
  timestamp: z.string().datetime(),
  details: z.record(z.unknown()).optional(),
});

export type FinalityEvent = z.infer<typeof FinalityEventSchema>;
export type SettlementEvent = z.infer<typeof SettlementEventSchema>;
export type HealthEvent = z.infer<typeof HealthEventSchema>;
