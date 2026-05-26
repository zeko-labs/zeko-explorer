import { ledgerHasAppliedTransactions } from "#src/indexer-queries";
import type { ZekoIndexerState } from "#src/indexer-state";

export function linkTransactionsToBatch(
  state: ZekoIndexerState,
  ledgerHash: string,
  timestamp: string,
): void {
  const indexedTarget = ledgerHasAppliedTransactions(state, ledgerHash);
  if (!indexedTarget) {
    return;
  }
  recomputeBatchLinks(state, timestamp);
}

function recomputeBatchLinks(state: ZekoIndexerState, timestamp: string): void {
  const appliedTransactions = [...state.store.transactions.values()]
    .filter((transaction) => transaction.status === "applied")
    .sort((left, right) => left.block_height - right.block_height);

  for (const transaction of appliedTransactions) {
    if (transaction.batch) {
      state.store.coreProjectionRemovals.batchTransactionIds.add(
        `${transaction.batch}:${transaction.id}`,
      );
    }
    transaction.batch = undefined;
  }

  const ranges = [...state.store.batches.values()]
    .filter((batch) => batch.settlement_status !== "rolled_back")
    .flatMap((batch) => {
      const target = appliedTransactions.find(
        (transaction) => transaction.target_ledger_hash === batch.target_ledger_hash,
      );
      return target ? [{ batch, targetHeight: target.block_height }] : [];
    })
    .sort((left, right) => left.targetHeight - right.targetHeight);

  let previousTargetHeight = 0;
  for (const { batch, targetHeight } of ranges) {
    const covered = appliedTransactions.filter(
      (transaction) =>
        transaction.block_height > previousTargetHeight && transaction.block_height <= targetHeight,
    );
    for (const transaction of covered) {
      transaction.batch = batch.id;
    }
    state.store.upsertBatch(
      batch.target_ledger_hash,
      {
        batch_height: targetHeight,
        sort_batch_height: -targetHeight,
        first_tx_height: covered[0]?.block_height ?? 0,
        last_tx_height: covered.at(-1)?.block_height ?? 0,
        transaction_count: covered.length,
      },
      timestamp,
    );
    previousTargetHeight = targetHeight;
  }
}
