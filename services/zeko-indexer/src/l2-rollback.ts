import { consumeBridgeL2Rollback } from "#src/bridge";
import { removePendingDa } from "#src/da";
import {
  latestAccountActivityInLedger,
  latestAccountActivityOutsideRollback,
} from "#src/indexer-queries";
import type { ZekoIndexerState } from "#src/indexer-state";
import { accountTransactionRelationId, isAccountTransactionRole } from "#src/indexer-utils";
import { accountKey, normalizeTimestamp } from "#src/store";
import type { AccountActivityRow, AccountRow, L2TransactionInput } from "#src/types";

const L2_SOURCE = "l2-transactions";

export function reconcileLedgerChain(state: ZekoIndexerState, event: L2TransactionInput): void {
  const lastHash = state.store.syncStatus.get(L2_SOURCE)?.last_hash;
  if (!lastHash || event.source_ledger_hash === lastHash) {
    return;
  }

  const ancestorIndex = state.store.ledgerOrder.indexOf(event.source_ledger_hash);
  if (ancestorIndex < 0) {
    state.store.syncStatus.set(L2_SOURCE, {
      source: L2_SOURCE,
      status: "paused",
      last_hash: lastHash,
      error: `Unknown source ledger hash ${event.source_ledger_hash}; backfill required`,
    });
    throw new Error(`L2 gap detected from ${lastHash} to ${event.source_ledger_hash}`);
  }

  const rolledBack = state.store.ledgerOrder.splice(ancestorIndex + 1);
  const rollbackScope = new Set(rolledBack);
  const detectedAt = normalizeTimestamp(event.timestamp);
  const preRollbackAccounts = snapshotAccountsForRollback(state, rollbackScope);
  for (const ledgerHash of rolledBack) {
    rollbackL2Ledger(state, ledgerHash, rollbackScope, detectedAt, preRollbackAccounts);
  }
}

function rollbackL2Ledger(
  state: ZekoIndexerState,
  ledgerHash: string,
  rollbackScope = new Set([ledgerHash]),
  detectedAt = normalizeTimestamp(Date.now()),
  preRollbackAccounts = snapshotAccountsForRollback(state, rollbackScope),
): void {
  removePendingDa(state, ledgerHash);
  state.store.pendingFinality.delete(ledgerHash);
  state.pendingDaSigners.delete(ledgerHash);
  const invalidatedBatchIds = new Set<string>();
  for (const batch of state.store.batches.values()) {
    if (rollbackScope.has(batch.target_ledger_hash)) {
      invalidatedBatchIds.add(batch.id);
    }
  }
  for (const tx of state.store.transactions.values()) {
    if (tx.batch && invalidatedBatchIds.has(tx.batch)) {
      state.store.coreProjectionRemovals.batchTransactionIds.add(`${tx.batch}:${tx.id}`);
      tx.batch = undefined;
    }
    if (tx.target_ledger_hash === ledgerHash) {
      tx.status = "reverted";
      tx.rollback_reason = "l2_hash_chain_break";
      for (const activity of state.store.accountActivities.values()) {
        if (activity.transaction === tx.id && isAccountTransactionRole(activity.role)) {
          state.store.coreProjectionRemovals.accountTransactionIds.add(
            accountTransactionRelationId(activity),
          );
        }
      }
    }
  }
  for (const batch of state.store.batches.values()) {
    if (rollbackScope.has(batch.target_ledger_hash)) {
      state.store.upsertBatch(
        batch.target_ledger_hash,
        {
          first_tx_height: 0,
          last_tx_height: 0,
          transaction_count: 0,
          proof_status: "pending",
          settlement_status: "rolled_back",
          settlement_id: undefined,
          proved_at: undefined,
          l1_chain: undefined,
          l1_block_height: undefined,
          l1_block_hash: undefined,
          l1_tx_hash: undefined,
          l1_confirmations: undefined,
          l1_finality_level: undefined,
          da_status: undefined,
          da_source: undefined,
          da_attested_at: undefined,
          da_implementation: undefined,
          da_quorum_threshold: undefined,
          da_signers: undefined,
          submitted_at: undefined,
          settled_at: undefined,
        },
        detectedAt,
      );
    }
  }
  for (const [id, event] of state.store.zkappEvents) {
    if (event.target_ledger_hash === ledgerHash) {
      state.store.coreProjectionRemovals.zkappEventIds.add(event.id);
      state.store.zkappEvents.delete(id);
    }
  }
  for (const [id, action] of state.store.zkappActions) {
    if (action.target_ledger_hash === ledgerHash) {
      state.store.coreProjectionRemovals.zkappActionIds.add(action.id);
      state.store.zkappActions.delete(id);
    }
  }
  consumeBridgeL2Rollback(state.store, { rollbackId: `l2-rollback-${ledgerHash}`, ledgerHash });

  const affectedAccounts = new Set<string>();
  for (const activity of state.store.accountActivityByLedger(ledgerHash)) {
    affectedAccounts.add(activity.account);
  }
  for (const accountId of affectedAccounts) {
    const latest = latestAccountActivityOutsideRollback(state, accountId, rollbackScope);
    const beforeRollback = preRollbackAccounts.get(accountId);
    if (!beforeRollback) {
      continue;
    }
    const account = state.store.accountById(accountId) ?? { ...beforeRollback };
    const revertedActivity = latestAccountActivityInLedger(state, accountId, ledgerHash);
    if (!latest) {
      if (revertedActivity) {
        writeRollbackActivity(
          state,
          ledgerHash,
          revertedActivity,
          beforeRollback,
          undefined,
          detectedAt,
        );
      }
      markAccountRemoved(state, beforeRollback);
      state.store.accounts.delete(accountKey(beforeRollback.public_key, beforeRollback.token_id));
      continue;
    }
    account.balance = latest.balance_after ?? account.balance;
    account.nonce = latest.nonce_after ?? account.nonce;
    account.delegate = latest.delegate_after;
    account.zkapp_state = latest.zkapp_state_after;
    account.action_state = latest.action_state_after;
    account.verification_key_hash = latest.verification_key_hash_after;
    account.zkapp_uri = latest.zkapp_uri_after;
    account.last_activity_height = latest.block_height;
    account.last_activity_at = latest.timestamp;
    state.store.accounts.set(accountKey(account.public_key, account.token_id), account);
    if (revertedActivity) {
      writeRollbackActivity(
        state,
        ledgerHash,
        revertedActivity,
        beforeRollback,
        account,
        detectedAt,
      );
    }
  }
}

function snapshotAccountsForRollback(
  state: ZekoIndexerState,
  rollbackScope: Set<string>,
): Map<string, AccountRow> {
  const accountIds = new Set<string>();
  for (const activity of state.store.accountActivities.values()) {
    if (rollbackScope.has(activity.target_ledger_hash)) {
      accountIds.add(activity.account);
    }
  }

  const accounts = new Map<string, AccountRow>();
  for (const accountId of accountIds) {
    const account = state.store.accountById(accountId);
    if (account) {
      accounts.set(account.id, { ...account });
    }
  }
  return accounts;
}

function writeRollbackActivity(
  state: ZekoIndexerState,
  ledgerHash: string,
  revertedActivity: AccountActivityRow,
  before: AccountRow,
  after: AccountRow | undefined,
  detectedAt: string,
): void {
  const key = `${revertedActivity.transaction}:${before.public_key}:${before.token_id}:rollback:${ledgerHash}`;
  if (state.store.accountActivities.has(key)) {
    return;
  }
  state.store.accountActivities.set(key, {
    id: state.store.idFactory.newId(detectedAt, `account_activity:${key}`),
    account: before.id,
    account_public_key: before.public_key,
    transaction: revertedActivity.transaction,
    role: "rollback",
    block_height: revertedActivity.block_height,
    tx_index: revertedActivity.tx_index,
    activity_index: revertedActivity.activity_index + 1_000_000,
    sort_block_height: revertedActivity.sort_block_height,
    sort_tx_index: revertedActivity.sort_tx_index,
    sort_activity_index: revertedActivity.sort_activity_index + 1_000_000,
    timestamp: detectedAt,
    balance_before: before.balance,
    balance_after: after?.balance,
    nonce_before: before.nonce,
    nonce_after: after?.nonce,
    delegate_before: before.delegate,
    delegate_after: after?.delegate,
    zkapp_state_before: before.zkapp_state,
    zkapp_state_after: after?.zkapp_state,
    action_state_before: before.action_state,
    action_state_after: after?.action_state,
    verification_key_hash_before: before.verification_key_hash,
    verification_key_hash_after: after?.verification_key_hash,
    zkapp_uri_before: before.zkapp_uri,
    zkapp_uri_after: after?.zkapp_uri,
    target_ledger_hash: ledgerHash,
  });
}

function markAccountRemoved(state: ZekoIndexerState, account: AccountRow): void {
  state.store.coreProjectionRemovals.accountIds.add(account.id);
  for (const activity of state.store.accountActivities.values()) {
    if (activity.account === account.id && isAccountTransactionRole(activity.role)) {
      state.store.coreProjectionRemovals.accountTransactionIds.add(
        accountTransactionRelationId(activity),
      );
    }
  }
}
