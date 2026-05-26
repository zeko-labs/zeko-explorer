import type { ZekoIndexerState } from "#src/indexer-state";
import type { IndexerStore } from "#src/store";
import type { AccountActivityRow, TransactionRow } from "#src/types";

export function ledgerHasAppliedTransactions(state: ZekoIndexerState, ledgerHash: string): boolean {
  for (const transaction of state.store.transactions.values()) {
    if (transaction.status === "applied" && transaction.target_ledger_hash === ledgerHash) {
      return true;
    }
  }
  return false;
}

export function transactionByHashAndLedger(
  state: ZekoIndexerState,
  hash: string,
  targetLedgerHash: string,
): TransactionRow | undefined {
  return [...state.store.transactions.values()].find(
    (transaction) =>
      transaction.hash === hash && transaction.target_ledger_hash === targetLedgerHash,
  );
}

export function batchBySettlementId(
  state: ZekoIndexerState,
  settlementId: string,
): ReturnType<IndexerStore["batchByLedger"]> {
  for (const batch of state.store.batches.values()) {
    if (batch.settlement_id === settlementId) {
      return batch;
    }
  }
  return undefined;
}

export function latestAccountActivityOutsideRollback(
  state: ZekoIndexerState,
  accountId: string,
  rollbackScope: Set<string>,
): AccountActivityRow | undefined {
  let latest: AccountActivityRow | undefined;
  for (const activity of state.store.accountActivities.values()) {
    if (activity.account !== accountId || rollbackScope.has(activity.target_ledger_hash)) {
      continue;
    }
    const transaction = state.store.transactionById(activity.transaction);
    if (transaction?.status === "reverted") {
      continue;
    }
    if (!latest || activity.block_height > latest.block_height) {
      latest = activity;
    }
  }
  return latest;
}

export function latestAccountActivityInLedger(
  state: ZekoIndexerState,
  accountId: string,
  ledgerHash: string,
): AccountActivityRow | undefined {
  let latest: AccountActivityRow | undefined;
  for (const activity of state.store.accountActivityByLedger(ledgerHash)) {
    if (activity.account !== accountId) {
      continue;
    }
    if (!latest || activity.block_height > latest.block_height) {
      latest = activity;
    }
  }
  return latest;
}
