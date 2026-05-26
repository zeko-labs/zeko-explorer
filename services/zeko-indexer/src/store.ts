import { monotonicFactory } from "ulid";
import type {
  AccountActivityRow,
  AccountRow,
  BatchRow,
  BridgeEventEffectRow,
  BridgeOperationRow,
  BridgeTransactionLinkRow,
  InnerActionRow,
  L1ActionLinkRow,
  L2ActionLinkRow,
  OuterActionRow,
  PendingDaAttestationRow,
  PendingFinalityRow,
  SyncStatusRow,
  TransactionRow,
  ZkappActionRow,
  ZkappEventRow,
} from "./types.ts";

export type IdFactory = {
  newId(timestamp: string | number): string;
};

export type BridgeProjectionRemovals = {
  readonly outerActionIds: Set<string>;
  readonly innerActionIds: Set<string>;
  readonly bridgeOperationIds: Set<string>;
  readonly l1ActionLinkIds: Set<string>;
  readonly l2ActionLinkIds: Set<string>;
  readonly bridgeTransactionLinkIds: Set<string>;
};

export type IndexerStore = {
  readonly accounts: Map<string, AccountRow>;
  readonly transactions: Map<string, TransactionRow>;
  readonly accountActivities: Map<string, AccountActivityRow>;
  readonly zkappEvents: Map<string, ZkappEventRow>;
  readonly zkappActions: Map<string, ZkappActionRow>;
  readonly outerActions: Map<string, OuterActionRow>;
  readonly innerActions: Map<string, InnerActionRow>;
  readonly bridgeOperations: Map<string, BridgeOperationRow>;
  readonly l1ActionLinks: Map<string, L1ActionLinkRow>;
  readonly l2ActionLinks: Map<string, L2ActionLinkRow>;
  readonly bridgeTransactionLinks: Map<string, BridgeTransactionLinkRow>;
  readonly bridgeEventOperationIds: Map<string, string>;
  readonly bridgeEventEffects: Map<string, BridgeEventEffectRow>;
  readonly batches: Map<string, BatchRow>;
  readonly pendingDa: Map<string, PendingDaAttestationRow>;
  readonly pendingFinality: Map<string, PendingFinalityRow>;
  readonly syncStatus: Map<string, SyncStatusRow>;
  readonly ledgerOrder: string[];
  readonly l1RollbackAffectedSettlementIds: Set<string>;
  readonly l1RollbackAffectedBridgeEventIds: Set<string>;
  readonly l1RollbackAffectedOuterActionIds: Set<string>;
  readonly bridgeProjectionRemovals: BridgeProjectionRemovals;
  readonly idFactory: IdFactory;

  accountByPublicKey(publicKey: string, tokenId?: string): AccountRow | undefined;
  accountById(id: string): AccountRow | undefined;
  transactionByHash(hash: string): TransactionRow | undefined;
  batchByLedger(ledgerHash: string): BatchRow | undefined;
  accountActivityByLedger(ledgerHash: string): AccountActivityRow[];
  zkappEventsByAccount(publicKey: string): ZkappEventRow[];
  zkappActionsByAccount(publicKey: string): ZkappActionRow[];
  zkappEventsByLedger(ledgerHash: string): ZkappEventRow[];
  zkappActionsByLedger(ledgerHash: string): ZkappActionRow[];
  bridgeOperationsByAux(aux: string): BridgeOperationRow[];
  bridgeOperationById(id: string): BridgeOperationRow | undefined;
  innerActionByState(actionState: string): InnerActionRow | undefined;
  nextTransactionSequence(): number;
  nextBatchHeight(): number;
  nextEventSequence(): number;
  nextActionSequence(): number;
  nextBridgeSequence(aux: string): number;
  upsertBatchForTest(ledgerHash: string, patch: Partial<BatchRow>): BatchRow;
  upsertBatch(ledgerHash: string, patch: Partial<BatchRow>, timestamp: string): BatchRow;
};

export class UlidFactory implements IdFactory {
  readonly #factory = monotonicFactory();

  newId(timestamp: string | number): string {
    return this.#factory(timestampToMillis(timestamp));
  }
}

export const timestampToMillis = (timestamp: string | number): number => {
  if (typeof timestamp === "number") {
    return timestamp;
  }

  if (/^\d+$/.test(timestamp)) {
    return Number(timestamp);
  }

  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return millis;
};

export const normalizeTimestamp = (timestamp: string | number): string =>
  new Date(timestampToMillis(timestamp)).toISOString();

export class InMemoryIndexerStore implements IndexerStore {
  readonly accounts = new Map<string, AccountRow>();
  readonly transactions = new Map<string, TransactionRow>();
  readonly accountActivities = new Map<string, AccountActivityRow>();
  readonly zkappEvents = new Map<string, ZkappEventRow>();
  readonly zkappActions = new Map<string, ZkappActionRow>();
  readonly outerActions = new Map<string, OuterActionRow>();
  readonly innerActions = new Map<string, InnerActionRow>();
  readonly bridgeOperations = new Map<string, BridgeOperationRow>();
  readonly l1ActionLinks = new Map<string, L1ActionLinkRow>();
  readonly l2ActionLinks = new Map<string, L2ActionLinkRow>();
  readonly bridgeTransactionLinks = new Map<string, BridgeTransactionLinkRow>();
  readonly bridgeEventOperationIds = new Map<string, string>();
  readonly bridgeEventEffects = new Map<string, BridgeEventEffectRow>();
  readonly batches = new Map<string, BatchRow>();
  readonly pendingDa = new Map<string, PendingDaAttestationRow>();
  readonly pendingFinality = new Map<string, PendingFinalityRow>();
  readonly syncStatus = new Map<string, SyncStatusRow>();
  readonly ledgerOrder: string[] = [];
  readonly l1RollbackAffectedSettlementIds = new Set<string>();
  readonly l1RollbackAffectedBridgeEventIds = new Set<string>();
  readonly l1RollbackAffectedOuterActionIds = new Set<string>();
  readonly bridgeProjectionRemovals: BridgeProjectionRemovals = {
    outerActionIds: new Set(),
    innerActionIds: new Set(),
    bridgeOperationIds: new Set(),
    l1ActionLinkIds: new Set(),
    l2ActionLinkIds: new Set(),
    bridgeTransactionLinkIds: new Set(),
  };
  readonly idFactory: IdFactory;

  constructor(idFactory: IdFactory = new UlidFactory()) {
    this.idFactory = idFactory;
  }

  accountByPublicKey(publicKey: string, tokenId = "1"): AccountRow | undefined {
    return this.accounts.get(accountKey(publicKey, tokenId));
  }

  accountById(id: string): AccountRow | undefined {
    return [...this.accounts.values()].find((account) => account.id === id);
  }

  transactionByHash(hash: string): TransactionRow | undefined {
    const matches = [...this.transactions.values()]
      .filter((transaction) => transaction.hash === hash)
      .sort((left, right) => right.block_height - left.block_height);
    return matches.find((transaction) => transaction.status === "applied") ?? matches[0];
  }

  batchByLedger(ledgerHash: string): BatchRow | undefined {
    return this.batches.get(ledgerHash);
  }

  accountActivityByLedger(ledgerHash: string): AccountActivityRow[] {
    return [...this.accountActivities.values()].filter(
      (activity) => activity.target_ledger_hash === ledgerHash,
    );
  }

  zkappEventsByAccount(publicKey: string): ZkappEventRow[] {
    return [...this.zkappEvents.values()]
      .filter((event) => event.emitting_account_public_key === publicKey)
      .sort((left, right) => left.sequence_number - right.sequence_number);
  }

  zkappActionsByAccount(publicKey: string): ZkappActionRow[] {
    return [...this.zkappActions.values()]
      .filter((action) => action.emitting_account_public_key === publicKey)
      .sort((left, right) => left.sequence_number - right.sequence_number);
  }

  zkappEventsByLedger(ledgerHash: string): ZkappEventRow[] {
    return [...this.zkappEvents.values()].filter(
      (event) => event.target_ledger_hash === ledgerHash,
    );
  }

  zkappActionsByLedger(ledgerHash: string): ZkappActionRow[] {
    return [...this.zkappActions.values()].filter(
      (action) => action.target_ledger_hash === ledgerHash,
    );
  }

  bridgeOperationsByAux(aux: string): BridgeOperationRow[] {
    return [...this.bridgeOperations.values()]
      .filter((operation) => operation.aux === aux)
      .sort((left, right) => left.aux_sequence - right.aux_sequence);
  }

  bridgeOperationById(id: string): BridgeOperationRow | undefined {
    return [...this.bridgeOperations.values()].find((operation) => operation.id === id);
  }

  innerActionByState(actionState: string): InnerActionRow | undefined {
    return this.innerActions.get(actionState);
  }

  nextTransactionSequence(): number {
    return this.transactions.size + 1;
  }

  nextBatchHeight(): number {
    return this.batches.size + 1;
  }

  nextEventSequence(): number {
    return this.zkappEvents.size + 1;
  }

  nextActionSequence(): number {
    return this.zkappActions.size + 1;
  }

  nextBridgeSequence(aux: string): number {
    return this.bridgeOperationsByAux(aux).length;
  }

  upsertBatchForTest(ledgerHash: string, patch: Partial<BatchRow>): BatchRow {
    return this.upsertBatch(ledgerHash, patch, patch.submitted_at ?? "2026-05-13T00:00:00.000Z");
  }

  upsertBatch(ledgerHash: string, patch: Partial<BatchRow>, timestamp: string): BatchRow {
    const existing = this.batches.get(ledgerHash);
    const batch: BatchRow = {
      id: existing?.id ?? this.idFactory.newId(timestamp),
      target_ledger_hash: ledgerHash,
      batch_height: existing?.batch_height ?? this.nextBatchHeight(),
      sort_batch_height: existing?.sort_batch_height ?? -this.nextBatchHeight(),
      first_tx_height: existing?.first_tx_height ?? 0,
      last_tx_height: existing?.last_tx_height ?? 0,
      transaction_count: existing?.transaction_count ?? 0,
      proof_status: existing?.proof_status ?? "pending",
      settlement_status: existing?.settlement_status ?? "pending",
      ...existing,
      ...patch,
    };
    this.batches.set(ledgerHash, batch);
    return batch;
  }
}

export const accountKey = (publicKey: string, tokenId = "1"): string => `${publicKey}:${tokenId}`;
