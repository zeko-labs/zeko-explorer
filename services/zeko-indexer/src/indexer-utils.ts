import type {
  AccountActivityRow,
  L2CommandInput,
  L2TransactionInput,
  TransactionRow,
} from "./types.ts";

export function transactionKey(hash: string, targetLedgerHash: string): string {
  return `${hash}:${targetLedgerHash}`;
}

export const transactionType = (event: L2TransactionInput): TransactionRow["type"] => {
  if (event.genesis) {
    return "genesis";
  }
  if (!event.command) {
    return "fee_transfer";
  }
  if (event.command.type === "zkapp_command") {
    return "zkapp_command";
  }
  return "payment";
};

export const accountRole = (
  command: L2CommandInput | null,
  publicKey: string,
): AccountActivityRow["role"] => {
  if (command?.sender === publicKey) {
    return "sender";
  }
  if (command?.receiver === publicKey) {
    return "receiver";
  }
  return "touched";
};

export const accountTransactionRelationId = (activity: AccountActivityRow): string =>
  `${activity.transaction}:${activity.account}:${activity.role}:${activity.activity_index}`;

export const isAccountTransactionRole = (
  role: AccountActivityRow["role"],
): role is "sender" | "receiver" | "fee_payer" | "touched" =>
  role === "sender" || role === "receiver" || role === "fee_payer" || role === "touched";

export type SettlementStatus = "pending" | "settling" | "finalized" | "rolled_back";

export const chooseSettlementStatus = (
  current: SettlementStatus | undefined,
  incoming: SettlementStatus,
): SettlementStatus => {
  if (current === "finalized" && incoming === "settling") {
    return current;
  }
  return incoming;
};

export const isRecord = (item: unknown): item is Record<string, unknown> =>
  typeof item === "object" && item !== null;

export const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const arrayValue = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

export const nestedStringValue = (item: unknown, key: string): string | undefined =>
  isRecord(item) ? stringValue(item[key]) : undefined;

export const nestedArrayValue = (item: unknown, key: string): unknown[] | undefined =>
  isRecord(item) ? arrayValue(item[key]) : undefined;
