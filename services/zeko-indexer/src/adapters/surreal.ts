import type { BridgeProjectionRemovals, CoreProjectionRemovals, IndexerStore } from "../store.ts";
import type {
  BridgeOperationRow,
  InnerActionRow,
  OuterActionRow,
  TransactionRow,
} from "../types.ts";
import { coreProjectionStatements } from "./surreal-core.ts";
import {
  date,
  deleteRecord,
  record,
  stripUndefined,
  upsertRecord,
  upsertRelation,
} from "./surreal-sql.ts";

export type SurrealHttpConfig = {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
};

export type SurrealHttpClient = {
  query(sql: string): Promise<void>;
};

export function createSurrealHttpClient(config: SurrealHttpConfig): SurrealHttpClient {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  return {
    async query(sql: string): Promise<void> {
      const response = await fetch(`${endpoint}/sql`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Surreal-NS": config.namespace,
          "Surreal-DB": config.database,
          Accept: "application/json",
        },
        body: sql,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`SurrealDB HTTP ${response.status}: ${text}`);
      }
      const result = JSON.parse(text) as Array<{ status: "OK" | "ERR"; result: unknown }>;
      const errors = result.filter((entry) => entry.status !== "OK");
      if (errors.length > 0) {
        throw new Error(errors.map((entry) => String(entry.result)).join("\n"));
      }
    },
  };
}

export async function writeBridgeProjectionToSurreal(
  client: SurrealHttpClient,
  store: IndexerStore,
): Promise<void> {
  const removals = snapshotBridgeProjectionRemovals(store.bridgeProjectionRemovals);
  const statements = bridgeProjectionStatements(store, removals);
  if (statements.length === 0) {
    return;
  }
  await client.query(statements.join("\n"));
  clearSubmittedBridgeProjectionRemovals(store.bridgeProjectionRemovals, removals);
}

export async function writeIndexerProjectionToSurreal(
  client: SurrealHttpClient,
  store: IndexerStore,
): Promise<void> {
  const coreRemovals = snapshotCoreProjectionRemovals(store.coreProjectionRemovals);
  const removals = snapshotBridgeProjectionRemovals(store.bridgeProjectionRemovals);
  const statements: string[] = [
    ...coreProjectionStatements(store, coreRemovals),
    ...bridgeProjectionStatements(store, removals, { includeLinkedTransactions: false }),
  ];
  if (statements.length === 0) {
    return;
  }
  await client.query(statements.join("\n"));
  clearSubmittedCoreProjectionRemovals(store.coreProjectionRemovals, coreRemovals);
  clearSubmittedBridgeProjectionRemovals(store.bridgeProjectionRemovals, removals);
}

type BridgeProjectionStatementOptions = {
  readonly includeLinkedTransactions?: boolean;
};

function bridgeProjectionStatements(
  store: IndexerStore,
  removals: BridgeProjectionRemovals,
  options: BridgeProjectionStatementOptions = {},
): string[] {
  const statements: string[] = bridgeRemovalStatements(removals);
  for (const row of store.outerActions.values()) {
    statements.push(upsertRecord("outer_action", row.id, serializeOuterAction(row)));
  }
  for (const row of store.innerActions.values()) {
    statements.push(upsertRecord("inner_action", row.id, serializeInnerAction(row)));
  }
  for (const row of store.bridgeOperations.values()) {
    statements.push(upsertRecord("bridge_operation", row.id, serializeBridgeOperation(row)));
  }
  if (options.includeLinkedTransactions ?? true) {
    const linkedTransactionIds = new Set(
      [...store.bridgeTransactionLinks.values()].map((row) => row.out),
    );
    for (const row of store.transactions.values()) {
      if (linkedTransactionIds.has(row.id)) {
        statements.push(upsertRecord("transaction", row.id, serializeTransaction(row)));
      }
    }
  }
  for (const row of store.l1ActionLinks.values()) {
    statements.push(
      upsertRelation("outer_action", row.in, "l1_action_link", "bridge_operation", row.out, row),
    );
  }
  for (const row of store.l2ActionLinks.values()) {
    statements.push(
      upsertRelation("bridge_operation", row.in, "l2_action_link", "inner_action", row.out, row),
    );
  }
  for (const row of store.bridgeTransactionLinks.values()) {
    statements.push(
      upsertRelation(
        "bridge_operation",
        row.in,
        "bridge_transaction_link",
        "transaction",
        row.out,
        row,
      ),
    );
  }
  return statements;
}

function snapshotBridgeProjectionRemovals(
  removals: BridgeProjectionRemovals,
): BridgeProjectionRemovals {
  return {
    outerActionIds: new Set(removals.outerActionIds),
    innerActionIds: new Set(removals.innerActionIds),
    bridgeOperationIds: new Set(removals.bridgeOperationIds),
    l1ActionLinkIds: new Set(removals.l1ActionLinkIds),
    l2ActionLinkIds: new Set(removals.l2ActionLinkIds),
    bridgeTransactionLinkIds: new Set(removals.bridgeTransactionLinkIds),
  };
}

function snapshotCoreProjectionRemovals(removals: CoreProjectionRemovals): CoreProjectionRemovals {
  return {
    accountIds: new Set(removals.accountIds),
    accountTransactionIds: new Set(removals.accountTransactionIds),
    pendingDaLedgerHashes: new Set(removals.pendingDaLedgerHashes),
    zkappEventIds: new Set(removals.zkappEventIds),
    zkappActionIds: new Set(removals.zkappActionIds),
    batchTransactionIds: new Set(removals.batchTransactionIds),
  };
}

function bridgeRemovalStatements(removals: BridgeProjectionRemovals): string[] {
  return [
    ...[...removals.bridgeTransactionLinkIds].map((id) =>
      deleteRecord("bridge_transaction_link", id),
    ),
    ...[...removals.l2ActionLinkIds].map((id) => deleteRecord("l2_action_link", id)),
    ...[...removals.l1ActionLinkIds].map((id) => deleteRecord("l1_action_link", id)),
    ...[...removals.outerActionIds].map((id) => deleteRecord("outer_action", id)),
    ...[...removals.innerActionIds].map((id) => deleteRecord("inner_action", id)),
    ...[...removals.bridgeOperationIds].map((id) => deleteRecord("bridge_operation", id)),
  ];
}

function clearSubmittedBridgeProjectionRemovals(
  pending: BridgeProjectionRemovals,
  submitted: BridgeProjectionRemovals,
): void {
  clearSubmittedIds(pending.bridgeTransactionLinkIds, submitted.bridgeTransactionLinkIds);
  clearSubmittedIds(pending.l2ActionLinkIds, submitted.l2ActionLinkIds);
  clearSubmittedIds(pending.l1ActionLinkIds, submitted.l1ActionLinkIds);
  clearSubmittedIds(pending.outerActionIds, submitted.outerActionIds);
  clearSubmittedIds(pending.innerActionIds, submitted.innerActionIds);
  clearSubmittedIds(pending.bridgeOperationIds, submitted.bridgeOperationIds);
}

function clearSubmittedCoreProjectionRemovals(
  pending: CoreProjectionRemovals,
  submitted: CoreProjectionRemovals,
): void {
  clearSubmittedIds(pending.accountIds, submitted.accountIds);
  clearSubmittedIds(pending.accountTransactionIds, submitted.accountTransactionIds);
  clearSubmittedIds(pending.pendingDaLedgerHashes, submitted.pendingDaLedgerHashes);
  clearSubmittedIds(pending.zkappEventIds, submitted.zkappEventIds);
  clearSubmittedIds(pending.zkappActionIds, submitted.zkappActionIds);
  clearSubmittedIds(pending.batchTransactionIds, submitted.batchTransactionIds);
}

function clearSubmittedIds(pending: Set<string>, submitted: Set<string>): void {
  for (const id of submitted) {
    pending.delete(id);
  }
}

function serializeOuterAction(row: OuterActionRow): Record<string, unknown> {
  return stripUndefined({
    after_state: row.after_state,
    before_state: row.before_state,
    kind: row.kind,
    action_index: row.action_index,
    block_height: row.block_height,
    block_state_hash: row.block_state_hash,
    timestamp: date(row.timestamp),
    network: row.network,
    provider: row.provider,
    global_slot: row.global_slot,
    distance_from_max_block_height: row.distance_from_max_block_height,
    txn_hash: row.txn_hash,
    fields: row.fields,
    slot_range_lower: row.slot_range_lower,
    slot_range_upper: row.slot_range_upper,
    marked_as_canonical_at: row.marked_as_canonical_at
      ? date(row.marked_as_canonical_at)
      : undefined,
    ledger: row.ledger,
    inner_action_state: row.inner_action_state,
    inner_action_state_length: row.inner_action_state_length,
    synchronized_outer_action_state: row.synchronized_outer_action_state,
    synchronized_outer_action_state_length: row.synchronized_outer_action_state_length,
    aux: row.aux,
  });
}

function serializeInnerAction(row: InnerActionRow): Record<string, unknown> {
  return stripUndefined({
    after_state: row.after_state,
    before_state: row.before_state,
    action_index: row.action_index,
    block_height: row.block_height,
    timestamp: date(row.timestamp),
    txn_hash: row.txn_hash,
    transaction: row.transaction ? record("transaction", row.transaction) : undefined,
    fields: row.fields,
    aux: row.aux,
    marked_as_canonical_at: row.marked_as_canonical_at
      ? date(row.marked_as_canonical_at)
      : undefined,
    target_ledger_hash: row.target_ledger_hash,
  });
}

function serializeTransaction(row: TransactionRow): Record<string, unknown> {
  return stripUndefined({
    hash: row.hash,
    sequence_number: row.sequence_number,
    type: row.type,
    status: row.status,
    sender_public_key: row.sender_public_key,
    receiver_public_key: row.receiver_public_key,
    fee_payer_public_key: row.fee_payer_public_key,
    amount: row.amount,
    fee: row.fee,
    nonce: row.nonce,
    memo: row.memo,
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

function serializeBridgeOperation(row: BridgeOperationRow): Record<string, unknown> {
  return stripUndefined({
    type: row.type,
    status: row.status,
    aux: row.aux,
    aux_sequence: row.aux_sequence,
    sender: row.sender,
    recipient: row.recipient,
    amount: row.amount,
    search_text: row.search_text,
    data_quality: row.data_quality,
    data_quality_reasons: row.data_quality_reasons,
    source_network: row.source_network,
    source_provider: row.source_provider,
    submit_tx_hash: row.submit_tx_hash,
    submit_block_height: row.submit_block_height,
    sort_submit_block_height: row.sort_submit_block_height,
    submit_timestamp: row.submit_timestamp ? date(row.submit_timestamp) : undefined,
    timeout_slot: row.timeout_slot,
    holder_account_l1: row.holder_account_l1,
    l1_witness_action_state: row.l1_witness_action_state,
    l1_witness_tx_hash: row.l1_witness_tx_hash,
    l1_witness_block_height: row.l1_witness_block_height,
    l1_witness_timestamp: row.l1_witness_timestamp ? date(row.l1_witness_timestamp) : undefined,
    l1_slot_range_lower: row.l1_slot_range_lower,
    l1_slot_range_upper: row.l1_slot_range_upper,
    l2_action_state: row.l2_action_state,
    l2_tx_hash: row.l2_tx_hash,
    l2_block_height: row.l2_block_height,
    l2_timestamp: row.l2_timestamp ? date(row.l2_timestamp) : undefined,
    commit_action_state: row.commit_action_state,
    cancel_tx_hash: row.cancel_tx_hash,
    rollback_reason: row.rollback_reason,
  });
}
