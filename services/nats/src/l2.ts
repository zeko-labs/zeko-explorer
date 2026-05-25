import type { InferOutput } from "valibot";
import {
  array,
  boolean,
  looseObject,
  null_,
  optional,
  picklist,
  strictObject,
  string,
  union,
  unknown,
} from "valibot";

import {
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  OptionalStringRecordSchema,
} from "./shared";

// Transaction diffs are producer-owned Da_layer.Diff JSON plus target_ledger_hash/genesis.
// looseObject preserves future raw diff fields instead of silently stripping them.
export const L2TransactionCommandSchema = looseObject({
  type: picklist(["signed_command", "zkapp_command"]),
  hash: NonEmptyStringSchema,
  sender: optional(NonEmptyStringSchema),
  receiver: optional(NonEmptyStringSchema),
  amount: optional(NonEmptyStringSchema),
  fee: optional(NonEmptyStringSchema),
  nonce: optional(NonNegativeIntegerSchema),
  memo: optional(string()),
  account_updates: optional(array(unknown())),
});

export const L2ChangedAccountSchema = looseObject({
  index: NonNegativeIntegerSchema,
  account: looseObject({
    public_key: NonEmptyStringSchema,
    balance: NonEmptyStringSchema,
    nonce: NonNegativeIntegerSchema,
    delegate: optional(NonEmptyStringSchema),
    token_id: optional(NonEmptyStringSchema),
    zkapp_state: optional(array(NonEmptyStringSchema)),
    permissions: OptionalStringRecordSchema,
    timing: OptionalStringRecordSchema,
  }),
});

export const L2TransactionEventSchema = looseObject({
  source_ledger_hash: NonEmptyStringSchema,
  target_ledger_hash: NonEmptyStringSchema,
  timestamp: union([NonEmptyStringSchema, NonNegativeIntegerSchema]),
  acc_set: NonEmptyStringSchema,
  command: union([L2TransactionCommandSchema, null_()]),
  changed_accounts: array(L2ChangedAccountSchema),
  genesis: optional(boolean()),
});

export const L2FinalityLevelSchema = picklist(["proved", "committed"]);

export const L2FinalityEventSchema = strictObject({
  ledger_hash: NonEmptyStringSchema,
  level: L2FinalityLevelSchema,
  source_ledger_hash: NonEmptyStringSchema,
  timestamp: NonEmptyStringSchema,
});

export type L2TransactionEvent = InferOutput<typeof L2TransactionEventSchema>;
export type L2FinalityLevel = InferOutput<typeof L2FinalityLevelSchema>;
export type L2FinalityEvent = InferOutput<typeof L2FinalityEventSchema>;
