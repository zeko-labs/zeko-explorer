import type { CoreProjectionRemovals, IndexerStore } from "../store.ts";
import type {
  AccountActivityRow,
  AccountRow,
  BatchRow,
  PendingDaAttestationRow,
  SyncStatusRow,
  TransactionRow,
  ZkappActionRow,
  ZkappEventRow,
} from "../types.ts";
import {
  date,
  deleteRecord,
  record,
  stripUndefined,
  upsertRecord,
  upsertRelation,
} from "./surreal-sql.ts";

export function coreProjectionStatements(
  store: IndexerStore,
  removals: CoreProjectionRemovals = emptyCoreProjectionRemovals(),
): string[] {
  const statements: string[] = coreRemovalStatements(removals);
  for (const row of store.accounts.values()) {
    statements.push(upsertRecord("account", row.id, serializeAccount(row, store)));
  }
  for (const row of store.batches.values()) {
    statements.push(upsertRecord("batch", row.id, serializeBatch(row, store)));
  }
  for (const row of store.transactions.values()) {
    statements.push(upsertRecord("transaction", row.id, serializeTransaction(row, store)));
  }
  for (const row of store.accountActivities.values()) {
    statements.push(upsertRecord("account_activity", row.id, serializeAccountActivity(row)));
  }
  for (const row of store.zkappEvents.values()) {
    statements.push(upsertRecord("zkapp_event", row.id, serializeZkappEvent(row)));
  }
  for (const row of store.zkappActions.values()) {
    statements.push(upsertRecord("zkapp_action", row.id, serializeZkappAction(row)));
  }
  for (const row of store.pendingDa.values()) {
    statements.push(
      upsertRecord("pending_da_attestation", row.ledger_hash, serializePendingDa(row)),
    );
  }
  for (const row of store.syncStatus.values()) {
    statements.push(upsertRecord("sync_status", row.source, serializeSyncStatus(row)));
  }
  for (const row of accountTransactionRelations(store)) {
    statements.push(
      upsertRelation("transaction", row.in, "account_transaction", "account", row.out, row),
    );
  }
  for (const row of batchTransactionRelations(store)) {
    statements.push(
      upsertRelation("batch", row.in, "batch_transaction", "transaction", row.out, row),
    );
  }
  return statements;
}

function emptyCoreProjectionRemovals(): CoreProjectionRemovals {
  return {
    accountIds: new Set(),
    accountTransactionIds: new Set(),
    pendingDaLedgerHashes: new Set(),
    zkappEventIds: new Set(),
    zkappActionIds: new Set(),
    batchTransactionIds: new Set(),
  };
}

function coreRemovalStatements(removals: CoreProjectionRemovals): string[] {
  return [
    ...[...removals.accountTransactionIds].map((id) => deleteRecord("account_transaction", id)),
    ...[...removals.batchTransactionIds].map((id) => deleteRecord("batch_transaction", id)),
    ...[...removals.pendingDaLedgerHashes].map((id) => deleteRecord("pending_da_attestation", id)),
    ...[...removals.zkappEventIds].map((id) => deleteRecord("zkapp_event", id)),
    ...[...removals.zkappActionIds].map((id) => deleteRecord("zkapp_action", id)),
    ...[...removals.accountIds].map((id) => deleteRecord("account", id)),
  ];
}

function serializeAccount(row: AccountRow, store: IndexerStore): Record<string, unknown> {
  const delegate = row.delegate ? store.accountByPublicKey(row.delegate)?.id : undefined;
  return stripUndefined({
    public_key: row.public_key,
    token_id: row.token_id,
    balance: row.balance,
    nonce: row.nonce,
    delegate: delegate ? record("account", delegate) : undefined,
    zkapp_state: row.zkapp_state,
    action_state: row.action_state,
    verification_key_hash: row.verification_key_hash,
    zkapp_uri: row.zkapp_uri,
    first_seen_height: row.first_seen_height,
    last_activity_height: row.last_activity_height,
    last_activity_at: row.last_activity_at ? date(row.last_activity_at) : undefined,
    search_text: row.search_text,
  });
}

function serializeTransaction(row: TransactionRow, store: IndexerStore): Record<string, unknown> {
  return stripUndefined({
    hash: row.hash,
    sequence_number: row.sequence_number,
    type: row.type,
    status: row.status,
    sender: accountReference(store, row.sender_public_key),
    receiver: accountReference(store, row.receiver_public_key),
    fee_payer: accountReference(store, row.fee_payer_public_key),
    sender_public_key: row.sender_public_key,
    receiver_public_key: row.receiver_public_key,
    fee_payer_public_key: row.fee_payer_public_key,
    amount: row.amount,
    fee: row.fee,
    nonce: row.nonce,
    memo: row.memo,
    search_text: [row.hash, row.type, row.sender_public_key, row.receiver_public_key, row.memo]
      .filter(Boolean)
      .join(" "),
    block_height: row.block_height,
    tx_index: row.tx_index,
    sort_block_height: row.sort_block_height,
    sort_tx_index: row.sort_tx_index,
    timestamp: date(row.timestamp),
    source_ledger_hash: row.source_ledger_hash,
    target_ledger_hash: row.target_ledger_hash,
    batch: row.batch ? record("batch", row.batch) : undefined,
    rollback_reason: row.rollback_reason,
    raw_command: row.raw_command,
  });
}

function serializeAccountActivity(row: AccountActivityRow): Record<string, unknown> {
  return stripUndefined({
    account: record("account", row.account),
    transaction: record("transaction", row.transaction),
    role: row.role,
    block_height: row.block_height,
    tx_index: row.tx_index,
    activity_index: row.activity_index,
    sort_block_height: row.sort_block_height,
    sort_tx_index: row.sort_tx_index,
    sort_activity_index: row.sort_activity_index,
    timestamp: date(row.timestamp),
    balance_before: row.balance_before,
    balance_after: row.balance_after,
    nonce_before: row.nonce_before,
    nonce_after: row.nonce_after,
    zkapp_state_before: row.zkapp_state_before,
    zkapp_state_after: row.zkapp_state_after,
    action_state_before: row.action_state_before,
    action_state_after: row.action_state_after,
    target_ledger_hash: row.target_ledger_hash,
  });
}

function serializeZkappEvent(row: ZkappEventRow): Record<string, unknown> {
  return {
    transaction: record("transaction", row.transaction),
    transaction_hash: row.transaction_hash,
    emitting_account: record("account", row.emitting_account),
    event_index: row.event_index,
    block_height: row.block_height,
    tx_index: row.tx_index,
    sort_block_height: row.sort_block_height,
    sort_tx_index: row.sort_tx_index,
    sort_event_index: row.sort_event_index,
    timestamp: date(row.timestamp),
    fields: row.fields,
    sequence_number: row.sequence_number,
    target_ledger_hash: row.target_ledger_hash,
  };
}

function serializeZkappAction(row: ZkappActionRow): Record<string, unknown> {
  return {
    transaction: record("transaction", row.transaction),
    transaction_hash: row.transaction_hash,
    emitting_account: record("account", row.emitting_account),
    action_index: row.action_index,
    block_height: row.block_height,
    tx_index: row.tx_index,
    sort_block_height: row.sort_block_height,
    sort_tx_index: row.sort_tx_index,
    sort_action_index: row.sort_action_index,
    timestamp: date(row.timestamp),
    fields: row.fields,
    before_action_state: row.before_action_state,
    action_state: row.action_state,
    sequence_number: row.sequence_number,
    target_ledger_hash: row.target_ledger_hash,
  };
}

function serializeBatch(row: BatchRow, store: IndexerStore): Record<string, unknown> {
  const transactions = transactionsInBatch(store, row.id);
  const lastTransaction = transactions.at(-1);
  return stripUndefined({
    batch_height: row.batch_height,
    sort_batch_height: row.sort_batch_height,
    target_ledger_hash: row.target_ledger_hash,
    first_tx_height: row.first_tx_height,
    last_tx_height: row.last_tx_height,
    first_tx: transactions[0] ? record("transaction", transactions[0].id) : undefined,
    last_tx: lastTransaction ? record("transaction", lastTransaction.id) : undefined,
    transaction_count: row.transaction_count,
    proof_status: row.proof_status,
    settlement_status: row.settlement_status,
    proved_at: row.proved_at ? date(row.proved_at) : undefined,
    l1_chain: row.l1_chain,
    l1_block_height: row.l1_block_height,
    l1_block_hash: row.l1_block_hash,
    l1_tx_hash: row.l1_tx_hash,
    l1_confirmations: row.l1_confirmations,
    l1_finality_level: row.l1_finality_level,
    da_status: row.da_status,
    da_source: row.da_source,
    da_attested_at: row.da_attested_at ? date(row.da_attested_at) : undefined,
    da_implementation: row.da_implementation,
    da_quorum_threshold: row.da_quorum_threshold,
    da_signers: row.da_signers?.map(serializeSigner),
    submitted_at: row.submitted_at ? date(row.submitted_at) : undefined,
    settled_at: row.settled_at ? date(row.settled_at) : undefined,
  });
}

function serializePendingDa(row: PendingDaAttestationRow): Record<string, unknown> {
  return stripUndefined({
    ledger_hash: row.ledger_hash,
    source: row.source,
    attested_at: row.attested_at ? date(row.attested_at) : undefined,
    received_at: date(row.received_at),
    implementation: row.implementation,
    quorum_threshold: row.quorum_threshold,
    signers: row.signers?.map(serializeSigner),
  });
}

function serializeSyncStatus(row: SyncStatusRow): Record<string, unknown> {
  return stripUndefined({
    source: row.source,
    status: row.status,
    last_sequence: row.last_sequence,
    last_hash: row.last_hash,
    last_height: row.last_height,
    last_processed_at: row.last_processed_at ? date(row.last_processed_at) : undefined,
    lag_seconds: row.lag_seconds,
    error: row.error,
  });
}

function accountReference(store: IndexerStore, publicKey: string | undefined) {
  const account = publicKey ? store.accountByPublicKey(publicKey) : undefined;
  return account ? record("account", account.id) : undefined;
}

function serializeSigner(row: {
  readonly publicKey: string;
  readonly instanceId: string;
  readonly signedAt: string;
}): Record<string, unknown> {
  return {
    publicKey: row.publicKey,
    instanceId: row.instanceId,
    signedAt: date(row.signedAt),
  };
}

function accountTransactionRelations(store: IndexerStore) {
  return [...store.accountActivities.values()]
    .filter((activity) => isAccountTransactionRole(activity.role))
    .filter((activity) => store.accountById(activity.account) !== undefined)
    .filter((activity) => {
      const transaction = [...store.transactions.values()].find(
        (candidate) => candidate.id === activity.transaction,
      );
      return transaction?.status !== "reverted";
    })
    .map((activity) => ({
      id: `${activity.transaction}:${activity.account}:${activity.role}:${activity.activity_index}`,
      in: activity.transaction,
      out: activity.account,
      role: activity.role,
      amount_delta: amountDelta(activity),
      account_public_key: activity.account_public_key,
      sort_block_height: activity.sort_block_height,
      sort_tx_index: activity.sort_tx_index,
    }));
}

function batchTransactionRelations(store: IndexerStore) {
  return [...store.batches.values()].flatMap((batch) =>
    transactionsInBatch(store, batch.id).map((transaction, index) => ({
      id: `${batch.id}:${transaction.id}`,
      in: batch.id,
      out: transaction.id,
      position: index,
    })),
  );
}

function transactionsInBatch(store: IndexerStore, batchId: string): TransactionRow[] {
  return [...store.transactions.values()]
    .filter((transaction) => transaction.batch === batchId)
    .sort(
      (left, right) => left.block_height - right.block_height || left.tx_index - right.tx_index,
    );
}

function amountDelta(activity: AccountActivityRow): string | undefined {
  if (activity.balance_before === undefined || activity.balance_after === undefined) {
    return undefined;
  }
  try {
    return (BigInt(activity.balance_after) - BigInt(activity.balance_before)).toString();
  } catch {
    return undefined;
  }
}

function isAccountTransactionRole(
  role: AccountActivityRow["role"],
): role is "sender" | "receiver" | "fee_payer" | "touched" {
  return role === "sender" || role === "receiver" || role === "fee_payer" || role === "touched";
}
