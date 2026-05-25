import type { InferOutput } from "valibot";
import { boolean, literal, optional, picklist, strictObject, union } from "valibot";

import { NonEmptyStringSchema, NonNegativeIntegerSchema, SchemaVersion1Schema } from "./shared";

export const DaImplementationSchema = picklist(["zeko-multisig-v1", "celestia-v1"]);

// The DA topic carries either current multisig receipts or the future Celestia proof variant.
export const ZekoMultisigDaSignatureEventSchema = strictObject({
  schemaVersion: SchemaVersion1Schema,
  implementation: literal("zeko-multisig-v1"),
  ledgerHash: NonEmptyStringSchema,
  accSet: NonEmptyStringSchema,
  publicKey: NonEmptyStringSchema,
  signature: NonEmptyStringSchema,
  instanceId: NonEmptyStringSchema,
  signedAt: NonEmptyStringSchema,
});

export const CelestiaDaSignatureEventSchema = strictObject({
  schemaVersion: SchemaVersion1Schema,
  implementation: literal("celestia-v1"),
  ledgerHash: NonEmptyStringSchema,
  celestia: strictObject({
    height: NonNegativeIntegerSchema,
    namespace: NonEmptyStringSchema,
    commitment: NonEmptyStringSchema,
    inclusionProof: NonEmptyStringSchema,
  }),
  publishedAt: NonEmptyStringSchema,
});

export const DaSignatureEventSchema = union([
  ZekoMultisigDaSignatureEventSchema,
  CelestiaDaSignatureEventSchema,
]);

export const DaNodeHealthEventSchema = strictObject({
  service: literal("da-node"),
  instanceId: NonEmptyStringSchema,
  publicKey: NonEmptyStringSchema,
  implementation: DaImplementationSchema,
  publishedAt: NonEmptyStringSchema,
  lastSignedHash: optional(NonEmptyStringSchema),
  lastSignedAt: optional(NonEmptyStringSchema),
  natsConnected: boolean(),
});

export type DaImplementation = InferOutput<typeof DaImplementationSchema>;
export type DaSignatureEvent = InferOutput<typeof DaSignatureEventSchema>;
export type DaNodeHealthEvent = InferOutput<typeof DaNodeHealthEventSchema>;
