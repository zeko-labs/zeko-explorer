import { DaSignatureEventSchema, EventSchemas } from "@zeko/nats";
import { parse } from "valibot";
import {
  EMPTY_ZKAPP_ACTION_STATE,
  isZkappFieldElement,
  tryDeriveZkappActionState,
} from "./action-state";
import {
  advanceBridgeClock,
  consumeBridgeInnerAction,
  consumeBridgeL2Rollback,
  consumeBridgeRollback,
  consumeL1BridgeEvent,
  consumeL1OuterAction,
} from "./bridge";
import {
  applyDaAttestation,
  consumeDaSignature,
  prunePendingDa,
  removePendingDa,
  upsertPendingDa,
} from "./da";
import {
  ledgerHasRevertedTransactions,
  type ZekoIndexerOptions,
  type ZekoIndexerState,
} from "./indexer-state";
import { accountKey, type IndexerStore, normalizeTimestamp } from "./store";
import type {
  AccountActivityRow,
  AccountRow,
  ConsumeEnvelope,
  DaSignatureInput,
  L1BridgeEventInput,
  L1OuterActionInput,
  L1RollbackInput,
  L1SettlementInput,
  L2AccountChangeInput,
  L2AccountUpdateInput,
  L2CommandInput,
  L2FinalityInput,
  L2TransactionInput,
  ObservedZkappActionInput,
  TransactionRow,
} from "./types";

export type { ZekoIndexerOptions } from "./indexer-state";

const L2_SOURCE = "l2-transactions";

export type ZekoIndexer = {
  consume(envelope: ConsumeEnvelope): Promise<void>;
  prunePendingDa(now: string | number, maxAgeDays?: number): void;
};

export function createZekoIndexer(
  store: IndexerStore,
  options: ZekoIndexerOptions = {},
): ZekoIndexer {
  const state: ZekoIndexerState = {
    store,
    options,
    pendingDaSigners: new Map(),
  };
  return {
    consume: (envelope) => consumeEnvelope(state, envelope),
    prunePendingDa: (now, maxAgeDays = 30) => prunePendingDa(state, now, maxAgeDays),
  };
}

async function consumeEnvelope(state: ZekoIndexerState, envelope: ConsumeEnvelope): Promise<void> {
  switch (envelope.subject) {
    case "zeko.l2.transactions":
      consumeL2Transaction(
        state,
        parse(EventSchemas.l2Transactions, envelope.payload) as unknown as L2TransactionInput,
      );
      break;
    case "zeko.l2.finality":
      consumeL2Finality(
        state,
        parse(EventSchemas.l2Finality, envelope.payload) as unknown as L2FinalityInput,
      );
      break;
    case "zeko.l1.settlements":
      consumeL1Settlement(
        state,
        parse(EventSchemas.l1Settlements, envelope.payload) as unknown as L1SettlementInput,
      );
      break;
    case "zeko.l1.rollbacks":
      consumeL1Rollback(
        state,
        parse(EventSchemas.l1Rollbacks, envelope.payload) as unknown as L1RollbackInput,
      );
      break;
    case "zeko.l1.outer-actions":
      consumeL1OuterActionEnvelope(
        state,
        parse(EventSchemas.l1OuterActions, envelope.payload) as unknown as L1OuterActionInput,
      );
      break;
    case "zeko.l1.bridge-events":
      consumeL1BridgeEventEnvelope(
        state,
        parse(EventSchemas.l1BridgeEvents, envelope.payload) as unknown as L1BridgeEventInput,
      );
      break;
    case "zeko.da.signatures":
      consumeDaSignature(
        state,
        parse(DaSignatureEventSchema, envelope.payload) as unknown as DaSignatureInput,
      );
      break;
  }
}

function consumeL2Transaction(state: ZekoIndexerState, event: L2TransactionInput): void {
  const txHash = event.command?.hash ?? `${event.target_ledger_hash}:diff`;
  const existing = transactionByHashAndLedger(state, txHash, event.target_ledger_hash);
  if (existing) {
    return;
  }

  reconcileLedgerChain(state, event);
  assertNewZkappActionStates(state, event);

  const timestamp = normalizeTimestamp(event.timestamp);
  const sequence = state.store.nextTransactionSequence();
  const row: TransactionRow = {
    id: state.store.idFactory.newId(timestamp, `transaction:${txHash}:${event.target_ledger_hash}`),
    hash: txHash,
    sequence_number: sequence,
    type: transactionType(event),
    status: "applied",
    sender_public_key: event.command?.sender,
    receiver_public_key: event.command?.receiver,
    fee_payer_public_key: event.command?.sender,
    amount: event.command?.amount,
    fee: event.command?.fee,
    nonce: event.command?.nonce,
    memo: event.command?.memo,
    block_height: sequence,
    tx_index: 0,
    sort_block_height: -sequence,
    sort_tx_index: 0,
    timestamp,
    source_ledger_hash: event.source_ledger_hash,
    target_ledger_hash: event.target_ledger_hash,
    raw_command: event.command ?? undefined,
  };
  state.store.transactions.set(transactionKey(txHash, event.target_ledger_hash), row);
  if (state.store.ledgerOrder.length === 0) {
    state.store.ledgerOrder.push(event.source_ledger_hash);
  }
  state.store.ledgerOrder.push(event.target_ledger_hash);

  event.changed_accounts.forEach((change) => {
    const activityIndex = change.index;
    const publicKey = change.account.public_key;
    const tokenId = change.account.token_id ?? "1";
    const previous = state.store.accountByPublicKey(publicKey, tokenId);
    const account: AccountRow = {
      id: previous?.id ?? state.store.idFactory.newId(timestamp, `account:${publicKey}:${tokenId}`),
      public_key: publicKey,
      token_id: tokenId,
      balance: change.account.balance,
      nonce: change.account.nonce,
      delegate: change.account.delegate ?? previous?.delegate,
      zkapp_state: change.account.zkapp_state ?? previous?.zkapp_state,
      action_state: change.account.action_state ?? previous?.action_state,
      verification_key_hash:
        change.account.verification_key_hash ?? previous?.verification_key_hash,
      zkapp_uri: change.account.zkapp_uri ?? previous?.zkapp_uri,
      first_seen_height: previous?.first_seen_height ?? sequence,
      last_activity_height: sequence,
      last_activity_at: timestamp,
      search_text: publicKey,
    };
    state.store.accounts.set(accountKey(publicKey, account.token_id), account);
    const activityKey = `${row.id}:${publicKey}:${account.token_id}:${activityIndex}`;
    state.store.accountActivities.set(activityKey, {
      id: state.store.idFactory.newId(timestamp, `account_activity:${activityKey}`),
      account: account.id,
      account_public_key: publicKey,
      transaction: row.id,
      role: accountRole(event.command, publicKey),
      block_height: sequence,
      tx_index: 0,
      activity_index: activityIndex,
      sort_block_height: -sequence,
      sort_tx_index: 0,
      sort_activity_index: activityIndex,
      timestamp,
      balance_before: previous?.balance,
      balance_after: account.balance,
      nonce_before: previous?.nonce,
      nonce_after: account.nonce,
      delegate_before: previous?.delegate,
      delegate_after: account.delegate,
      zkapp_state_before: previous?.zkapp_state,
      zkapp_state_after: account.zkapp_state,
      action_state_before: previous?.action_state,
      action_state_after: account.action_state,
      verification_key_hash_before: previous?.verification_key_hash,
      verification_key_hash_after: account.verification_key_hash,
      zkapp_uri_before: previous?.zkapp_uri,
      zkapp_uri_after: account.zkapp_uri,
      target_ledger_hash: event.target_ledger_hash,
    });
  });

  if (event.command?.type === "zkapp_command") {
    writeZkappChildren(state, event, row);
  }

  state.store.syncStatus.set(L2_SOURCE, {
    source: L2_SOURCE,
    status: "healthy",
    last_sequence: sequence,
    last_hash: event.target_ledger_hash,
    last_height: sequence,
    last_processed_at: timestamp,
  });
  linkTransactionsToBatch(state, event.target_ledger_hash, timestamp);
  materializePendingFinality(state, event.target_ledger_hash);
}

function assertNewZkappActionStates(state: ZekoIndexerState, event: L2TransactionInput): void {
  if (event.command?.type !== "zkapp_command") {
    return;
  }

  const existingActionStates = new Set(
    [...state.store.zkappActions.values()].map((action) => action.action_state),
  );
  const incomingActionStates = new Set<string>();
  for (const update of event.command.account_updates ?? []) {
    const publicKey = accountUpdatePublicKey(update);
    if (!publicKey) {
      continue;
    }
    const changedAccount = accountUpdateChangedAccount(event, update, publicKey);
    const tokenId = accountUpdateTokenId(update) ?? changedAccount?.account.token_id ?? "1";
    const actions = normalizeObservedActions(update.actions ?? update.body?.actions ?? [], {
      beforeHead: state.store.accountByPublicKey(publicKey, tokenId)?.action_state?.[0],
      afterHeads: changedAccount?.account.action_state,
    });
    for (const action of actions) {
      if (
        existingActionStates.has(action.action_state) ||
        incomingActionStates.has(action.action_state)
      ) {
        throw new Error(`Duplicate zkApp action_state ${action.action_state}`);
      }
      incomingActionStates.add(action.action_state);
    }
  }
}

function consumeL2Finality(state: ZekoIndexerState, event: L2FinalityInput): void {
  if (event.level !== "proved") {
    return;
  }

  const batch = state.store.batchByLedger(event.ledger_hash);
  if (
    batch?.settlement_status === "rolled_back" ||
    ledgerHasRevertedTransactions(state, event.ledger_hash)
  ) {
    return;
  }
  const indexedTargetLedger = [...state.store.transactions.values()].some(
    (transaction) =>
      transaction.status === "applied" && transaction.target_ledger_hash === event.ledger_hash,
  );
  if (!batch && !indexedTargetLedger) {
    state.store.pendingFinality.set(event.ledger_hash, {
      ledger_hash: event.ledger_hash,
      proved_at: event.timestamp,
    });
    upsertPendingDa(state, event.ledger_hash, "proved", event.timestamp);
    return;
  }

  state.store.upsertBatch(
    event.ledger_hash,
    { proof_status: "proved", proved_at: event.timestamp },
    event.timestamp,
  );
  linkTransactionsToBatch(state, event.ledger_hash, event.timestamp);
  applyDaAttestation(state, event.ledger_hash, "proved", event.timestamp);
}

function materializePendingFinality(state: ZekoIndexerState, ledgerHash: string): void {
  const pending = state.store.pendingFinality.get(ledgerHash);
  if (!pending || ledgerHasRevertedTransactions(state, ledgerHash)) {
    return;
  }

  state.store.upsertBatch(
    ledgerHash,
    { proof_status: "proved", proved_at: pending.proved_at },
    pending.proved_at,
  );
  linkTransactionsToBatch(state, ledgerHash, pending.proved_at);
  applyDaAttestation(state, ledgerHash, "proved", pending.proved_at);
  state.store.pendingFinality.delete(ledgerHash);
}

function consumeL1Settlement(state: ZekoIndexerState, event: L1SettlementInput): void {
  const ledgerHash = event.commit.ledgerHash;
  const observedAt = event.observedAt;
  if (state.store.l1RollbackAffectedSettlementIds.has(event.settlementId)) {
    return;
  }
  const incomingStatus = event.finalityLevel === "finalized" ? "finalized" : "settling";
  const existing = state.store.batchByLedger(ledgerHash);
  if (
    existing?.settlement_status === "rolled_back" ||
    ledgerHasRevertedTransactions(state, ledgerHash)
  ) {
    return;
  }
  const settlementStatus = chooseSettlementStatus(existing?.settlement_status, incomingStatus);
  const downgradeFromFinalized =
    existing?.settlement_status === "finalized" && incomingStatus !== "finalized";
  state.store.upsertBatch(
    ledgerHash,
    {
      settlement_id: downgradeFromFinalized ? existing.settlement_id : event.settlementId,
      proof_status: "proved",
      settlement_status: settlementStatus,
      l1_chain: downgradeFromFinalized ? existing.l1_chain : event.provider,
      l1_block_height: downgradeFromFinalized ? existing.l1_block_height : event.block.height,
      l1_block_hash: downgradeFromFinalized ? existing.l1_block_hash : event.block.hash,
      l1_tx_hash: downgradeFromFinalized ? existing.l1_tx_hash : event.txHash,
      l1_confirmations: downgradeFromFinalized
        ? existing.l1_confirmations
        : event.block.confirmationDepth,
      l1_finality_level: downgradeFromFinalized
        ? existing.l1_finality_level
        : settlementStatus === "finalized"
          ? "finalized"
          : event.finalityLevel,
      submitted_at: existing?.submitted_at ?? observedAt,
      settled_at: event.finalityLevel === "finalized" ? observedAt : existing?.settled_at,
    },
    observedAt,
  );
  linkTransactionsToBatch(state, ledgerHash, observedAt);
  applyDaAttestation(state, ledgerHash, "settlement", observedAt);
  removePendingDa(state, ledgerHash);
  state.store.pendingFinality.delete(ledgerHash);
  advanceBridgeClock(state.store, event.block.slot, state.options.bridge);
}

function consumeL1Rollback(state: ZekoIndexerState, event: L1RollbackInput): void {
  consumeBridgeRollback(state.store, event);
  for (const settlementId of event.affected.settlementIds) {
    state.store.l1RollbackAffectedSettlementIds.add(settlementId);
    const batch = [...state.store.batches.values()].find(
      (candidate) => candidate.settlement_id === settlementId,
    );
    if (!batch) {
      continue;
    }
    if (batch.da_status === "attested" && batch.da_source) {
      upsertPendingDa(state, batch.target_ledger_hash, batch.da_source, batch.da_attested_at, {
        implementation: batch.da_implementation,
        quorum_threshold: batch.da_quorum_threshold,
        signers: batch.da_signers,
      });
    }
    state.store.upsertBatch(
      batch.target_ledger_hash,
      {
        settlement_status: "pending",
        settlement_id: undefined,
        l1_tx_hash: undefined,
        l1_block_hash: undefined,
        l1_block_height: undefined,
        l1_confirmations: undefined,
        l1_finality_level: undefined,
        da_status: undefined,
        da_source: undefined,
        da_attested_at: undefined,
        da_implementation: undefined,
        da_quorum_threshold: undefined,
        da_signers: undefined,
        settled_at: undefined,
      },
      event.detectedAt,
    );
  }
}

function consumeL1OuterActionEnvelope(state: ZekoIndexerState, event: L1OuterActionInput): void {
  consumeL1OuterAction(state.store, event, state.options.bridge);
}

function consumeL1BridgeEventEnvelope(state: ZekoIndexerState, event: L1BridgeEventInput): void {
  consumeL1BridgeEvent(state.store, event);
}

function reconcileLedgerChain(state: ZekoIndexerState, event: L2TransactionInput): void {
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
  const invalidatedBatchIds = new Set(
    [...state.store.batches.values()]
      .filter((batch) => rollbackScope.has(batch.target_ledger_hash))
      .map((batch) => batch.id),
  );
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

  const affectedAccounts = new Set(
    [...state.store.accountActivities.values()]
      .filter((activity) => activity.target_ledger_hash === ledgerHash)
      .map((activity) => activity.account),
  );
  for (const accountId of affectedAccounts) {
    const latest = [...state.store.accountActivities.values()]
      .filter((activity) => {
        const transaction = [...state.store.transactions.values()].find(
          (candidate) => candidate.id === activity.transaction,
        );
        return (
          activity.account === accountId &&
          !rollbackScope.has(activity.target_ledger_hash) &&
          transaction?.status !== "reverted"
        );
      })
      .sort((left, right) => right.block_height - left.block_height)[0];
    const beforeRollback = preRollbackAccounts.get(accountId);
    if (!beforeRollback) {
      continue;
    }
    const account = state.store.accountById(accountId) ?? { ...beforeRollback };
    const revertedActivity = [...state.store.accountActivities.values()]
      .filter(
        (activity) => activity.account === accountId && activity.target_ledger_hash === ledgerHash,
      )
      .sort((left, right) => right.block_height - left.block_height)[0];
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
  const accountIds = new Set(
    [...state.store.accountActivities.values()]
      .filter((activity) => rollbackScope.has(activity.target_ledger_hash))
      .map((activity) => activity.account),
  );
  return new Map(
    [...accountIds]
      .map((accountId) => state.store.accountById(accountId))
      .filter((account): account is AccountRow => account !== undefined)
      .map((account) => [account.id, { ...account }]),
  );
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

function linkTransactionsToBatch(
  state: ZekoIndexerState,
  ledgerHash: string,
  timestamp: string,
): void {
  const indexedTarget = [...state.store.transactions.values()].some(
    (transaction) =>
      transaction.status === "applied" && transaction.target_ledger_hash === ledgerHash,
  );
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

function writeZkappChildren(
  state: ZekoIndexerState,
  event: L2TransactionInput,
  transaction: TransactionRow,
): void {
  const updates = event.command?.account_updates ?? [];
  const eventIndexesByAccount = new Map<string, number>();
  const actionIndexesByAccount = new Map<string, number>();
  for (const update of updates) {
    const publicKey = accountUpdatePublicKey(update);
    if (!publicKey) {
      continue;
    }
    const changedAccount = accountUpdateChangedAccount(event, update, publicKey);
    const tokenId = accountUpdateTokenId(update) ?? changedAccount?.account.token_id ?? "1";
    const account = state.store.accountByPublicKey(publicKey, tokenId);
    if (!account) {
      continue;
    }
    const accountIndexKey = accountKey(publicKey, tokenId);
    const activity = [...state.store.accountActivities.values()].find(
      (candidate) => candidate.transaction === transaction.id && candidate.account === account.id,
    );
    const events = normalizeFieldArrays(update.events ?? update.body?.events ?? []);
    events.forEach((fields) => {
      const eventIndex = eventIndexesByAccount.get(accountIndexKey) ?? 0;
      eventIndexesByAccount.set(accountIndexKey, eventIndex + 1);
      const key = `${transaction.id}:${publicKey}:${tokenId}:event:${eventIndex}`;
      if (state.store.zkappEvents.has(key)) {
        return;
      }
      state.store.zkappEvents.set(key, {
        id: state.store.idFactory.newId(transaction.timestamp, `zkapp_event:${key}`),
        transaction: transaction.id,
        transaction_hash: transaction.hash,
        emitting_account: account.id,
        emitting_account_public_key: publicKey,
        event_index: eventIndex,
        block_height: transaction.block_height,
        tx_index: transaction.tx_index,
        sort_block_height: transaction.sort_block_height,
        sort_tx_index: transaction.sort_tx_index,
        sort_event_index: eventIndex,
        timestamp: transaction.timestamp,
        fields,
        sequence_number: state.store.nextEventSequence(),
        target_ledger_hash: event.target_ledger_hash,
      });
    });

    const actions = normalizeObservedActions(update.actions ?? update.body?.actions ?? [], {
      beforeHead: activity?.action_state_before?.[0],
      afterHeads: activity?.action_state_after,
    });
    actions.forEach((action) => {
      const actionIndex = actionIndexesByAccount.get(accountIndexKey) ?? 0;
      actionIndexesByAccount.set(accountIndexKey, actionIndex + 1);
      const key = `${transaction.id}:${publicKey}:${tokenId}:action:${actionIndex}`;
      if (state.store.zkappActions.has(key)) {
        return;
      }
      state.store.zkappActions.set(key, {
        id: state.store.idFactory.newId(transaction.timestamp, `zkapp_action:${key}`),
        transaction: transaction.id,
        transaction_hash: transaction.hash,
        emitting_account: account.id,
        emitting_account_public_key: publicKey,
        action_index: actionIndex,
        block_height: transaction.block_height,
        tx_index: transaction.tx_index,
        sort_block_height: transaction.sort_block_height,
        sort_tx_index: transaction.sort_tx_index,
        sort_action_index: actionIndex,
        timestamp: transaction.timestamp,
        fields: action.fields,
        before_action_state: action.before_action_state,
        action_state: action.action_state,
        sequence_number: state.store.nextActionSequence(),
        target_ledger_hash: event.target_ledger_hash,
      });
      const actionRow = state.store.zkappActions.get(key);
      if (actionRow && isBridgeInnerAction(state, publicKey)) {
        consumeBridgeInnerAction(state.store, transaction, actionRow);
      }
    });
  }
}

function isBridgeInnerAction(state: ZekoIndexerState, publicKey: string): boolean {
  const configured = state.options.bridge?.innerActionPublicKeys;
  if (!configured) {
    return false;
  }
  return configured.has(publicKey);
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

function transactionByHashAndLedger(
  state: ZekoIndexerState,
  hash: string,
  targetLedgerHash: string,
): TransactionRow | undefined {
  return [...state.store.transactions.values()].find(
    (transaction) =>
      transaction.hash === hash && transaction.target_ledger_hash === targetLedgerHash,
  );
}
function transactionKey(hash: string, targetLedgerHash: string): string {
  return `${hash}:${targetLedgerHash}`;
}

const transactionType = (event: L2TransactionInput): TransactionRow["type"] => {
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

const accountRole = (
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

const accountTransactionRelationId = (activity: AccountActivityRow): string =>
  `${activity.transaction}:${activity.account}:${activity.role}:${activity.activity_index}`;

const isAccountTransactionRole = (
  role: AccountActivityRow["role"],
): role is "sender" | "receiver" | "fee_payer" | "touched" =>
  role === "sender" || role === "receiver" || role === "fee_payer" || role === "touched";

const accountUpdatePublicKey = (update: L2AccountUpdateInput): string | undefined =>
  update.public_key ?? update.account?.public_key ?? update.body?.public_key;

const accountUpdateTokenId = (update: L2AccountUpdateInput): string | undefined =>
  update.token_id ?? update.account?.token_id ?? update.body?.token_id;

const accountUpdateChangedAccount = (
  event: L2TransactionInput,
  update: L2AccountUpdateInput,
  publicKey: string,
): L2AccountChangeInput | undefined => {
  const matches = event.changed_accounts.filter(
    (change) => change.account.public_key === publicKey,
  );
  const tokenId = accountUpdateTokenId(update);
  if (tokenId) {
    return matches.find((change) => (change.account.token_id ?? "1") === tokenId);
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return matches.find((change) => (change.account.token_id ?? "1") === "1");
};

const normalizeFieldArrays = (items: unknown[]): string[][] =>
  items.flatMap((item) => {
    if (Array.isArray(item)) {
      return [item.map(String)];
    }
    if (isRecord(item) && Array.isArray(item.fields)) {
      return [item.fields.map(String)];
    }
    return [];
  });

type ActionStateContext = {
  beforeHead?: string;
  afterHeads?: string[];
};

const normalizeObservedActions = (
  items: unknown[],
  state: ActionStateContext = {},
): ObservedZkappActionInput[] => {
  const observed: ObservedZkappActionInput[] = [];
  let cursor = state.beforeHead ?? EMPTY_ZKAPP_ACTION_STATE;

  items.forEach((item, index) => {
    const rawFields = rawActionFields(item);
    if (rawFields) {
      const knownAfter = actionStateAfter(index, items.length, state);
      const derivedAfter = tryDeriveZkappActionState(cursor, rawFields);
      if (
        knownAfter &&
        isZkappFieldElement(knownAfter) &&
        derivedAfter &&
        knownAfter !== derivedAfter
      ) {
        throw new Error(
          `Computed zkApp action_state does not match post-state vector at index ${index}`,
        );
      }
      const after = knownAfter ?? derivedAfter;
      if (!after) {
        throw new Error("Cannot index raw zkApp action without action_state snapshots");
      }
      observed.push({
        fields: rawFields,
        before_action_state: cursor,
        action_state: after,
      });
      cursor = after;
      return;
    }
    if (!isRecord(item) || !Array.isArray(item.fields)) {
      return;
    }
    if (typeof item.before_action_state !== "string" || typeof item.action_state !== "string") {
      return;
    }
    const action = {
      fields: item.fields.map(String),
      before_action_state: item.before_action_state,
      action_state: item.action_state,
    };
    observed.push(action);
    cursor = action.action_state;
  });

  return observed;
};

const rawActionFields = (item: unknown): string[] | undefined => {
  if (Array.isArray(item)) {
    return item.map(String);
  }
  if (
    isRecord(item) &&
    Array.isArray(item.fields) &&
    (typeof item.before_action_state !== "string" || typeof item.action_state !== "string")
  ) {
    return item.fields.map(String);
  }
  return undefined;
};

const actionStateAfter = (
  actionIndex: number,
  actionCount: number,
  state: ActionStateContext,
): string | undefined => state.afterHeads?.[actionCount - actionIndex - 1];

const isRecord = (item: unknown): item is Record<string, unknown> =>
  typeof item === "object" && item !== null;

type SettlementStatus = "pending" | "settling" | "finalized" | "rolled_back";

const chooseSettlementStatus = (
  current: SettlementStatus | undefined,
  incoming: SettlementStatus,
): SettlementStatus => {
  if (current === "finalized" && incoming === "settling") {
    return current;
  }
  return incoming;
};
