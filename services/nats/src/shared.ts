import type { InferOutput } from "valibot";
import {
  integer,
  literal,
  minLength,
  minValue,
  number,
  optional,
  picklist,
  pipe,
  record,
  strictObject,
  string,
  unknown,
} from "valibot";

export const NonEmptyStringSchema = pipe(string(), minLength(1));
export const NonNegativeIntegerSchema = pipe(number(), integer(), minValue(0));
export const SchemaVersion1Schema = literal(1);
export const OptionalStringRecordSchema = optional(record(string(), unknown()));

export const NetworkIdSchema = picklist([
  "zeko-m-local",
  "zeko-m-devnet",
  "zeko-m-alphanet",
  "zeko-m-mainnet",
  "zeko-e-testnet",
  "zeko-e-mainnet",
]);

export const L1ProviderSchema = picklist(["mina", "ethereum"]);

export const L1BlockSchema = strictObject({
  height: NonNegativeIntegerSchema,
  hash: NonEmptyStringSchema,
  parentHash: NonEmptyStringSchema,
  slot: optional(NonNegativeIntegerSchema),
  timestamp: optional(NonEmptyStringSchema),
  confirmationDepth: NonNegativeIntegerSchema,
  providerFields: OptionalStringRecordSchema,
});

export const L1EnvelopeSchema = strictObject({
  schemaVersion: SchemaVersion1Schema,
  provider: L1ProviderSchema,
  network: NetworkIdSchema,
  source: literal("l1-watcher"),
  observedAt: NonEmptyStringSchema,
  block: L1BlockSchema,
});

export const SlotRangeSchema = strictObject({
  lower: NonNegativeIntegerSchema,
  upper: NonNegativeIntegerSchema,
});

export type NetworkId = InferOutput<typeof NetworkIdSchema>;
export type L1Provider = InferOutput<typeof L1ProviderSchema>;
