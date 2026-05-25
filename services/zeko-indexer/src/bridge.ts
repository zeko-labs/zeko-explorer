import type { IndexerStore } from "./store.ts";
import { normalizeTimestamp } from "./store.ts";
import type {
  BridgeOperationRow,
  InnerActionRow,
  L1BridgeEventInput,
  L1OuterActionInput,
  TransactionRow,
  ZkappActionRow,
} from "./types.ts";

export type BridgeProjectorOptions = {
  withdrawalDelaySlots?: number;
};

const DEFAULT_WITHDRAWAL_DELAY_SLOTS = 100;
const UNKNOWN = "unknown";

export function consumeL1BridgeEvent(store: IndexerStore, event: L1BridgeEventInput): void {
  if (store.l1RollbackAffectedBridgeEventIds.has(event.bridgeEventId)) {
    return;
  }
  if (store.bridgeEventOperationIds.has(event.bridgeEventId)) {
    return;
  }

  switch (event.type) {
    case "deposit_submitted":
      upsertDepositSubmission(store, event);
      return;
    case "deposit_cancelled":
      cancelDeposit(store, event);
      return;
    case "withdrawal_finalized":
      upsertWithdrawalFinalization(store, event);
      return;
  }
}

export function consumeL1OuterAction(
  store: IndexerStore,
  event: L1OuterActionInput,
  options: BridgeProjectorOptions = {},
): void {
  if (event.actionKind === "unknown" || event.parsed.kind === "unknown") {
    return;
  }

  const timestamp = normalizeTimestamp(event.observedAt);
  const parsed = event.parsed;
  const afterState = event.actionState.after ?? event.actionState.current;
  const row = {
    id: event.outerActionId,
    outer_action_id: event.outerActionId,
    after_state: afterState,
    before_state: event.actionState.before,
    kind: parsed.kind,
    action_index: event.archive.transactionSequenceNumber,
    block_height: event.block.height,
    block_state_hash: event.block.hash,
    timestamp,
    network: event.network,
    provider: event.provider,
    global_slot: event.block.slot,
    distance_from_max_block_height: event.archive.distanceFromMaxBlockHeight,
    txn_hash: event.txHash,
    fields: event.rawFields,
    slot_range_lower: parsed.slotRange.lower,
    slot_range_upper: parsed.slotRange.upper,
    marked_as_canonical_at: timestamp,
    ...(parsed.kind === "commit"
      ? {
          ledger: parsed.ledgerHash,
          inner_action_state: parsed.innerActionState,
          inner_action_state_length: parsed.innerActionStateLength,
          synchronized_outer_action_state: parsed.synchronizedOuterActionState,
          synchronized_outer_action_state_length: parsed.synchronizedOuterActionStateLength,
        }
      : { aux: parsed.aux }),
  };
  store.outerActions.set(event.outerActionId, row);

  if (parsed.kind === "witness") {
    applyOuterWitness(store, row, parsed.aux);
  } else {
    applyOuterCommit(store, row, parsed.innerActionState, parsed.innerActionStateLength);
  }

  markTimedOutDeposits(store, event.block.slot);
  markWithdrawalDelayPassed(store, event.block.slot, options.withdrawalDelaySlots);
}

export function consumeBridgeInnerAction(
  store: IndexerStore,
  transaction: TransactionRow,
  action: ZkappActionRow,
): void {
  const aux = bridgeAuxFromInnerFields(action.fields);
  if (!aux) {
    return;
  }

  const row: InnerActionRow = {
    id: action.id,
    after_state: action.action_state,
    before_state: action.before_action_state,
    action_index: action.sequence_number,
    block_height: action.block_height,
    timestamp: action.timestamp,
    txn_hash: transaction.hash,
    transaction: transaction.id,
    fields: action.fields,
    aux,
    marked_as_canonical_at: action.timestamp,
    target_ledger_hash: action.target_ledger_hash,
  };
  store.innerActions.set(row.after_state, row);

  const existingDeposit = firstOperationNeeding(
    store,
    aux,
    (operation) => operation.type === "deposit" && operation.l2_action_state === undefined,
  );
  if (existingDeposit) {
    existingDeposit.l2_action_state = row.after_state;
    existingDeposit.l2_tx_hash = transaction.hash;
    existingDeposit.l2_block_height = transaction.block_height;
    existingDeposit.l2_timestamp = transaction.timestamp;
    existingDeposit.status = depositStatus(existingDeposit);
    linkL2Action(store, existingDeposit, row, "mint");
    linkBridgeTransaction(store, existingDeposit, transaction, "l2_finalize");
    return;
  }

  const existingWithdrawal = firstOperationNeeding(
    store,
    aux,
    (operation) => operation.type === "withdrawal" && operation.l2_action_state === undefined,
  );
  const operation =
    existingWithdrawal ??
    createBridgeOperation(store, {
      type: "withdrawal",
      status: "submitted",
      aux,
      sender: transaction.sender_public_key ?? transaction.fee_payer_public_key ?? UNKNOWN,
      recipient: action.fields[2] ?? transaction.receiver_public_key ?? UNKNOWN,
      amount: action.fields[3] ?? transaction.amount ?? UNKNOWN,
      submit_tx_hash: transaction.hash,
      submit_block_height: transaction.block_height,
      submit_timestamp: transaction.timestamp,
      data_quality: action.fields.length >= 4 ? "complete" : "partial",
      data_quality_reasons:
        action.fields.length >= 4 ? undefined : ["inner_action_missing_user_fields"],
    });

  enrichWithdrawalFromL2Submit(operation, transaction, action);
  operation.l2_action_state = row.after_state;
  operation.l2_tx_hash = transaction.hash;
  operation.l2_block_height = transaction.block_height;
  operation.l2_timestamp = transaction.timestamp;
  operation.status = withdrawalStatus(operation);
  linkL2Action(store, operation, row, "burn");
  linkBridgeTransaction(store, operation, transaction, "submit");
}

function enrichWithdrawalFromL2Submit(
  operation: BridgeOperationRow,
  transaction: TransactionRow,
  action: ZkappActionRow,
): void {
  operation.sender = transaction.sender_public_key ?? transaction.fee_payer_public_key ?? UNKNOWN;
  operation.recipient = action.fields[2] ?? transaction.receiver_public_key ?? UNKNOWN;
  operation.amount = action.fields[3] ?? transaction.amount ?? UNKNOWN;
  operation.submit_tx_hash = transaction.hash;
  operation.submit_block_height = transaction.block_height;
  operation.sort_submit_block_height = -transaction.block_height;
  operation.submit_timestamp = transaction.timestamp;
  operation.data_quality = action.fields.length >= 4 ? "complete" : "partial";
  operation.data_quality_reasons =
    action.fields.length >= 4 ? undefined : ["inner_action_missing_user_fields"];
  operation.search_text = [
    operation.aux,
    operation.status,
    operation.type,
    operation.sender,
    operation.recipient,
  ]
    .filter((value) => value && value !== UNKNOWN)
    .join(" ");
}

export function consumeBridgeRollback(
  store: IndexerStore,
  event: {
    rollbackId: string;
    detectedAt: string;
    affected: {
      outerActionIds: string[];
      bridgeEventIds: string[];
    };
  },
): void {
  for (const bridgeEventId of event.affected.bridgeEventIds) {
    store.l1RollbackAffectedBridgeEventIds.add(bridgeEventId);
    const operationId = store.bridgeEventOperationIds.get(bridgeEventId);
    const operation = operationId ? store.bridgeOperationById(operationId) : undefined;
    if (operation) {
      operation.status = "rolled_back";
      operation.rollback_reason = event.rollbackId;
    }
  }

  for (const outerActionId of event.affected.outerActionIds) {
    const outerAction = store.outerActions.get(outerActionId);
    store.outerActions.delete(outerActionId);
    if (!outerAction) {
      continue;
    }

    for (const operation of store.bridgeOperations.values()) {
      if (operation.l1_witness_action_state === outerAction.after_state) {
        operation.l1_witness_action_state = undefined;
        operation.l1_witness_tx_hash = undefined;
        operation.l1_witness_block_height = undefined;
        operation.l1_witness_timestamp = undefined;
        operation.l1_slot_range_lower = undefined;
        operation.l1_slot_range_upper = undefined;
      }
      if (operation.commit_action_state === outerAction.after_state) {
        operation.commit_action_state = undefined;
      }
      operation.status =
        operation.type === "deposit" ? depositStatus(operation) : withdrawalStatus(operation);
    }
  }
}

function upsertDepositSubmission(store: IndexerStore, event: L1BridgeEventInput): void {
  if (!event.aux) {
    return;
  }
  const operation = createBridgeOperation(store, {
    type: "deposit",
    status: "submitted",
    aux: event.aux,
    auxSequence: event.operationIndex,
    sender: event.userPk,
    recipient: event.recipient ?? UNKNOWN,
    amount: event.amount ?? UNKNOWN,
    submit_tx_hash: event.txHash,
    submit_block_height: event.block.height,
    submit_timestamp: normalizeTimestamp(event.observedAt),
    timeout_slot: event.deposit?.timeoutSlot,
    holder_account_l1: event.deposit?.holderAccountL1,
    source_network: event.network,
    source_provider: event.provider,
    data_quality: event.amount && event.recipient ? "complete" : "partial",
    data_quality_reasons:
      event.amount && event.recipient ? undefined : ["bridge_event_missing_amount_or_recipient"],
  });
  operation.status = depositStatus(operation);
  store.bridgeEventOperationIds.set(event.bridgeEventId, operation.id);
}

function cancelDeposit(store: IndexerStore, event: L1BridgeEventInput): void {
  if (!event.aux) {
    return;
  }
  const cancelledSequence = event.cancel?.cancelledDepositIndex;
  const operation =
    cancelledSequence === undefined
      ? firstOperationNeeding(
          store,
          event.aux,
          (candidate) => candidate.type === "deposit" && candidate.status !== "cancelled",
        )
      : store
          .bridgeOperationsByAux(event.aux)
          .find(
            (candidate) =>
              candidate.type === "deposit" &&
              candidate.aux_sequence === cancelledSequence &&
              candidate.status !== "cancelled",
          );
  if (!operation) {
    return;
  }
  operation.cancel_tx_hash = event.txHash;
  operation.status = "cancelled";
  store.bridgeEventOperationIds.set(event.bridgeEventId, operation.id);
}

function upsertWithdrawalFinalization(store: IndexerStore, event: L1BridgeEventInput): void {
  if (!event.aux) {
    return;
  }
  const operation =
    firstOperationNeeding(
      store,
      event.aux,
      (candidate) => candidate.type === "withdrawal" && candidate.l1_witness_tx_hash === undefined,
    ) ??
    createBridgeOperation(store, {
      type: "withdrawal",
      status: "completed",
      aux: event.aux,
      auxSequence: event.operationIndex,
      sender: event.userPk,
      recipient: event.recipient ?? UNKNOWN,
      amount: event.amount ?? UNKNOWN,
      submit_tx_hash: event.txHash,
      submit_block_height: event.block.height,
      submit_timestamp: normalizeTimestamp(event.observedAt),
      source_network: event.network,
      source_provider: event.provider,
      data_quality: event.amount && event.recipient ? "complete" : "partial",
      data_quality_reasons:
        event.amount && event.recipient ? undefined : ["l1_withdrawal_event_without_l2_action"],
    });

  operation.l1_witness_tx_hash = event.txHash;
  operation.l1_witness_block_height = event.block.height;
  operation.l1_witness_timestamp = normalizeTimestamp(event.observedAt);
  operation.status = "completed";
  store.bridgeEventOperationIds.set(event.bridgeEventId, operation.id);
}

function applyOuterWitness(
  store: IndexerStore,
  outerAction: {
    id: string;
    after_state: string;
    txn_hash: string;
    block_height: number;
    timestamp: string;
    slot_range_lower: number;
    slot_range_upper: number;
  },
  aux: string,
): void {
  const existingWithdrawal = firstOperationNeeding(
    store,
    aux,
    (operation) =>
      operation.type === "withdrawal" && operation.l1_witness_action_state === undefined,
  );
  if (existingWithdrawal) {
    existingWithdrawal.l1_witness_action_state = outerAction.after_state;
    existingWithdrawal.l1_witness_tx_hash = outerAction.txn_hash;
    existingWithdrawal.l1_witness_block_height = outerAction.block_height;
    existingWithdrawal.l1_witness_timestamp = outerAction.timestamp;
    existingWithdrawal.l1_slot_range_lower = outerAction.slot_range_lower;
    existingWithdrawal.l1_slot_range_upper = outerAction.slot_range_upper;
    existingWithdrawal.status = "completed";
    linkL1Action(store, outerAction.id, existingWithdrawal, "witness");
    return;
  }

  const operation =
    firstOperationNeeding(
      store,
      aux,
      (candidate) =>
        candidate.type === "deposit" && candidate.l1_witness_action_state === undefined,
    ) ??
    createBridgeOperation(store, {
      type: "deposit",
      status: "l1_witnessed",
      aux,
      sender: UNKNOWN,
      recipient: UNKNOWN,
      amount: UNKNOWN,
      submit_block_height: outerAction.block_height,
      submit_timestamp: outerAction.timestamp,
      data_quality: "partial",
      data_quality_reasons: ["l1_witness_arrived_before_deposit_submission"],
    });

  operation.l1_witness_action_state = outerAction.after_state;
  operation.l1_witness_tx_hash = outerAction.txn_hash;
  operation.l1_witness_block_height = outerAction.block_height;
  operation.l1_witness_timestamp = outerAction.timestamp;
  operation.l1_slot_range_lower = outerAction.slot_range_lower;
  operation.l1_slot_range_upper = outerAction.slot_range_upper;
  operation.status = depositStatus(operation);
  linkL1Action(store, outerAction.id, operation, "witness");
}

function applyOuterCommit(
  store: IndexerStore,
  outerAction: { id: string; after_state: string; slot_range_upper: number },
  innerActionState: string,
  innerActionStateLength: number,
): void {
  for (const innerAction of coveredInnerActions(store, innerActionState, innerActionStateLength)) {
    const operation = firstOperationNeeding(
      store,
      innerAction.aux,
      (candidate) =>
        candidate.l2_action_state === innerAction.after_state &&
        candidate.commit_action_state === undefined,
    );
    if (!operation) {
      continue;
    }
    operation.commit_action_state = outerAction.after_state;
    operation.l1_slot_range_upper = outerAction.slot_range_upper;
    operation.status =
      operation.type === "deposit" ? depositStatus(operation) : withdrawalStatus(operation);
    linkL1Action(store, outerAction.id, operation, "commit");
  }
}

function coveredInnerActions(
  store: IndexerStore,
  headState: string,
  length: number,
): InnerActionRow[] {
  const covered: InnerActionRow[] = [];
  let cursor: string | undefined = headState;
  for (let index = 0; index < length && cursor; index += 1) {
    const action = store.innerActionByState(cursor);
    if (!action) {
      break;
    }
    covered.push(action);
    cursor = action.before_state;
  }
  return covered.reverse();
}

function markTimedOutDeposits(store: IndexerStore, currentSlot: number | undefined): void {
  if (currentSlot === undefined) {
    return;
  }
  for (const operation of store.bridgeOperations.values()) {
    if (
      operation.type === "deposit" &&
      operation.timeout_slot !== undefined &&
      operation.timeout_slot < currentSlot &&
      ["submitted", "l1_witnessed", "committed"].includes(operation.status)
    ) {
      operation.status = "timed_out";
    }
  }
}

function markWithdrawalDelayPassed(
  store: IndexerStore,
  currentSlot: number | undefined,
  withdrawalDelaySlots = DEFAULT_WITHDRAWAL_DELAY_SLOTS,
): void {
  if (currentSlot === undefined) {
    return;
  }
  for (const operation of store.bridgeOperations.values()) {
    if (
      operation.type === "withdrawal" &&
      operation.status === "committed" &&
      operation.l1_slot_range_upper !== undefined &&
      currentSlot > operation.l1_slot_range_upper + withdrawalDelaySlots
    ) {
      operation.status = "delay_passed";
    }
  }
}

function bridgeAuxFromInnerFields(fields: string[]): string | undefined {
  if (fields[0] !== "1") {
    return undefined;
  }
  return fields[1];
}

function createBridgeOperation(
  store: IndexerStore,
  input: {
    type: BridgeOperationRow["type"];
    status: BridgeOperationRow["status"];
    aux: string;
    auxSequence?: number;
    sender: string;
    recipient: string;
    amount: string;
    submit_tx_hash?: string;
    submit_block_height: number;
    submit_timestamp: string;
    timeout_slot?: number;
    holder_account_l1?: string;
    source_network?: string;
    source_provider?: string;
    data_quality: BridgeOperationRow["data_quality"];
    data_quality_reasons?: string[];
  },
): BridgeOperationRow {
  const auxSequence = input.auxSequence ?? store.nextBridgeSequence(input.aux);
  const existing = store.bridgeOperations.get(bridgeKey(input.aux, auxSequence));
  const operation: BridgeOperationRow = {
    ...existing,
    id: existing?.id ?? store.idFactory.newId(input.submit_timestamp),
    type: input.type,
    status: input.status,
    aux: input.aux,
    aux_sequence: auxSequence,
    sender: input.sender,
    recipient: input.recipient,
    amount: input.amount,
    search_text: [input.aux, input.status, input.type, input.sender, input.recipient]
      .filter((value) => value && value !== UNKNOWN)
      .join(" "),
    data_quality: input.data_quality,
    data_quality_reasons: input.data_quality_reasons,
    source_network: input.source_network,
    source_provider: input.source_provider,
    submit_tx_hash: input.submit_tx_hash,
    submit_block_height: input.submit_block_height,
    sort_submit_block_height: -input.submit_block_height,
    submit_timestamp: input.submit_timestamp,
    timeout_slot: input.timeout_slot,
    holder_account_l1: input.holder_account_l1,
  };
  store.bridgeOperations.set(bridgeKey(input.aux, auxSequence), operation);
  return operation;
}

function firstOperationNeeding(
  store: IndexerStore,
  aux: string,
  predicate: (operation: BridgeOperationRow) => boolean,
): BridgeOperationRow | undefined {
  return store.bridgeOperationsByAux(aux).find(predicate);
}

function depositStatus(operation: BridgeOperationRow): BridgeOperationRow["status"] {
  if (operation.status === "rolled_back" || operation.status === "cancelled") {
    return operation.status;
  }
  if (operation.l2_action_state) {
    return "completed";
  }
  if (operation.commit_action_state) {
    return "committed";
  }
  if (operation.l1_witness_action_state) {
    return "l1_witnessed";
  }
  return "submitted";
}

function withdrawalStatus(operation: BridgeOperationRow): BridgeOperationRow["status"] {
  if (operation.status === "rolled_back" || operation.status === "cancelled") {
    return operation.status;
  }
  if (operation.l1_witness_action_state || operation.l1_witness_tx_hash) {
    return "completed";
  }
  if (operation.commit_action_state) {
    return "committed";
  }
  return "submitted";
}

function linkL1Action(
  store: IndexerStore,
  outerActionId: string,
  operation: BridgeOperationRow,
  role: "witness" | "commit",
): void {
  const key = `${outerActionId}:${operation.id}:${role}`;
  store.l1ActionLinks.set(key, { id: key, in: outerActionId, out: operation.id, role });
}

function linkL2Action(
  store: IndexerStore,
  operation: BridgeOperationRow,
  action: InnerActionRow,
  role: "mint" | "burn",
): void {
  const key = `${operation.id}:${action.id}:${role}`;
  store.l2ActionLinks.set(key, { id: key, in: operation.id, out: action.id, role });
}

function linkBridgeTransaction(
  store: IndexerStore,
  operation: BridgeOperationRow,
  transaction: TransactionRow,
  role: "submit" | "l2_finalize",
): void {
  const key = `${operation.id}:${transaction.id}:${role}`;
  store.bridgeTransactionLinks.set(key, { id: key, in: operation.id, out: transaction.id, role });
}

function bridgeKey(aux: string, sequence: number): string {
  return `${aux}:${sequence}`;
}
