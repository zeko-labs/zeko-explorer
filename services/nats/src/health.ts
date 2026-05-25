import type { InferOutput } from "valibot";
import { array, boolean, literal, optional, picklist, strictObject, union } from "valibot";

import { DaNodeHealthEventSchema } from "./da";
import {
  L1ProviderSchema,
  NetworkIdSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  SchemaVersion1Schema,
} from "./shared";

// The spike lists common limitation values, but the contract leaves room for provider-specific reasons.
export const HealthLimitationSchema = NonEmptyStringSchema;

// zeko.health is shared by multiple publishers, so the service discriminator selects the shape.
export const SequencerHealthEventSchema = strictObject({
  service: literal("sequencer-nats-publisher"),
  last_published_hash: NonEmptyStringSchema,
  last_published_at: NonEmptyStringSchema,
  unproved_hash: NonEmptyStringSchema,
});

export const L1WatcherHealthEventSchema = strictObject({
  schemaVersion: SchemaVersion1Schema,
  service: literal("l1-watcher"),
  instanceId: NonEmptyStringSchema,
  provider: L1ProviderSchema,
  network: NetworkIdSchema,
  status: picklist(["healthy", "degraded", "down"]),
  observedAt: NonEmptyStringSchema,
  l1LiveNode: strictObject({
    connected: boolean(),
    syncStatus: optional(NonEmptyStringSchema),
    tipHeight: optional(NonNegativeIntegerSchema),
    tipHash: optional(NonEmptyStringSchema),
    lastBlockAt: optional(NonEmptyStringSchema),
    lastError: optional(NonEmptyStringSchema),
  }),
  l1ArchiveApi: strictObject({
    connected: boolean(),
    pendingMaxBlockHeight: optional(NonNegativeIntegerSchema),
    canonicalMaxBlockHeight: optional(NonNegativeIntegerSchema),
    lastOuterActionHeight: optional(NonNegativeIntegerSchema),
    lagBlocks: optional(NonNegativeIntegerSchema),
    lastError: optional(NonEmptyStringSchema),
  }),
  bridgeBackfill: strictObject({
    available: boolean(),
    lastBridgeEventHeight: optional(NonNegativeIntegerSchema),
    lagBlocks: optional(NonNegativeIntegerSchema),
    lastError: optional(NonEmptyStringSchema),
  }),
  nats: strictObject({
    connected: boolean(),
    pendingBufferSize: NonNegativeIntegerSchema,
    lastPublishError: optional(NonEmptyStringSchema),
  }),
  surrealdb: strictObject({
    connected: boolean(),
    lastWriteAt: optional(NonEmptyStringSchema),
    lastError: optional(NonEmptyStringSchema),
  }),
  tracked: strictObject({
    settlements: NonNegativeIntegerSchema,
    bridgeEvents: NonNegativeIntegerSchema,
    canonicalWindowBlocks: NonNegativeIntegerSchema,
  }),
  limitations: optional(array(HealthLimitationSchema)),
});

export const HealthEventSchema = union([
  SequencerHealthEventSchema,
  L1WatcherHealthEventSchema,
  DaNodeHealthEventSchema,
]);

export type HealthLimitation = InferOutput<typeof HealthLimitationSchema>;
export type SequencerHealthEvent = InferOutput<typeof SequencerHealthEventSchema>;
export type L1WatcherHealthEvent = InferOutput<typeof L1WatcherHealthEventSchema>;
export type HealthEvent = InferOutput<typeof HealthEventSchema>;
