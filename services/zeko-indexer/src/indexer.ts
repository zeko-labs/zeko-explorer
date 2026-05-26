import { DaSignatureEventSchema, EventSchemas } from "@zeko/nats";
import { parse } from "valibot";
import { linkTransactionsToBatch } from "./batch-links.ts";
import {
  advanceBridgeClock,
  consumeBridgeRollback,
  consumeL1BridgeEvent,
  consumeL1OuterAction,
} from "./bridge.ts";
import {
  applyDaAttestation,
  consumeDaSignature,
  prunePendingDa,
  removePendingDa,
  upsertPendingDa,
} from "./da.ts";
import {
  batchBySettlementId,
  ledgerHasAppliedTransactions,
  transactionByHashAndLedger,
} from "./indexer-queries.ts";
import {
  ledgerHasRevertedTransactions,
  type ZekoIndexerOptions,
  type ZekoIndexerState,
} from "./indexer-state.ts";
import {
  accountRole,
  chooseSettlementStatus,
  transactionKey,
  transactionType,
} from "./indexer-utils.ts";
import { reconcileLedgerChain } from "./l2-rollback.ts";
import { accountKey, type IndexerStore, normalizeTimestamp } from "./store.ts";
import type {
  AccountRow,
  ConsumeEnvelope,
  L1BridgeEventInput,
  L1OuterActionInput,
  L1RollbackInput,
  L1SettlementInput,
  L2FinalityInput,
  L2TransactionInput,
  TransactionRow,
} from "./types.ts";
import { assertNewZkappActionStates, writeZkappChildren } from "./zkapp-projection.ts";

export type { ZekoIndexerOptions } from "./indexer-state.ts";

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
      consumeL2Transaction(state, parse(EventSchemas.l2Transactions, envelope.payload));
      break;
    case "zeko.l2.finality":
      consumeL2Finality(state, parse(EventSchemas.l2Finality, envelope.payload));
      break;
    case "zeko.l1.settlements":
      consumeL1Settlement(state, parse(EventSchemas.l1Settlements, envelope.payload));
      break;
    case "zeko.l1.rollbacks":
      consumeL1Rollback(state, parse(EventSchemas.l1Rollbacks, envelope.payload));
      break;
    case "zeko.l1.outer-actions":
      consumeL1OuterActionEnvelope(state, parse(EventSchemas.l1OuterActions, envelope.payload));
      break;
    case "zeko.l1.bridge-events":
      consumeL1BridgeEventEnvelope(state, parse(EventSchemas.l1BridgeEvents, envelope.payload));
      break;
    case "zeko.da.signatures":
      consumeDaSignature(state, parse(DaSignatureEventSchema, envelope.payload));
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
  const indexedTargetLedger = ledgerHasAppliedTransactions(state, event.ledger_hash);
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
    const batch = batchBySettlementId(state, settlementId);
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
