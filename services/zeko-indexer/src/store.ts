import { createHash } from "node:crypto";
import { ulid as makeUlid, monotonicFactory } from "ulid";
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
  newId(timestamp: string | number, stableKey?: string): string;
};

export type BridgeProjectionRemovals = {
  readonly outerActionIds: Set<string>;
  readonly innerActionIds: Set<string>;
  readonly bridgeOperationIds: Set<string>;
  readonly l1ActionLinkIds: Set<string>;
  readonly l2ActionLinkIds: Set<string>;
  readonly bridgeTransactionLinkIds: Set<string>;
};

export type CoreProjectionRemovals = {
  readonly accountIds: Set<string>;
  readonly accountTransactionIds: Set<string>;
  readonly pendingDaLedgerHashes: Set<string>;
  readonly zkappEventIds: Set<string>;
  readonly zkappActionIds: Set<string>;
  readonly batchTransactionIds: Set<string>;
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
  readonly coreProjectionRemovals: CoreProjectionRemovals;
  readonly bridgeProjectionRemovals: BridgeProjectionRemovals;
  readonly idFactory: IdFactory;

  accountByPublicKey(publicKey: string, tokenId?: string): AccountRow | undefined;
  accountById(id: string): AccountRow | undefined;
  transactionByHash(hash: string): TransactionRow | undefined;
  transactionById(id: string): TransactionRow | undefined;
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

  newId(timestamp: string | number, stableKey?: string): string {
    if (stableKey) {
      return stableUlid(timestamp, stableKey);
    }
    return this.#factory(timestampToMillis(timestamp));
  }
}

const stableUlid = (timestamp: string | number, key: string): string => {
  const entropy = createHash("sha256").update(key).digest();
  let offset = 0;
  const deterministicPrng = () => {
    const value = entropy[offset % entropy.length] ?? 0;
    offset += 1;
    return value / 256;
  };
  return makeUlid(timestampToMillis(timestamp), deterministicPrng);
};

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

type IndexedMapHooks<Key, Value> = {
  set?(key: Key, value: Value, previous: Value | undefined): void;
  delete?(key: Key, previous: Value): void;
  clear?(): void;
};

class IndexedMap<Key, Value> extends Map<Key, Value> {
  readonly #hooks: IndexedMapHooks<Key, Value>;

  constructor(hooks: IndexedMapHooks<Key, Value>) {
    super();
    this.#hooks = hooks;
  }

  override set(key: Key, value: Value): this {
    const previous = super.get(key);
    super.set(key, value);
    this.#hooks.set?.(key, value, previous);
    return this;
  }

  override delete(key: Key): boolean {
    const previous = super.get(key);
    const deleted = super.delete(key);
    if (deleted && previous !== undefined) {
      this.#hooks.delete?.(key, previous);
    }
    return deleted;
  }

  override clear(): void {
    if (this.size === 0) {
      return;
    }
    super.clear();
    this.#hooks.clear?.();
  }
}

export class InMemoryIndexerStore implements IndexerStore {
  readonly #accountsById = new Map<string, AccountRow>();
  readonly #transactionsById = new Map<string, TransactionRow>();
  readonly #transactionsByHash = new Map<string, Set<TransactionRow>>();
  readonly #accountActivitiesByLedger = new Map<string, Set<AccountActivityRow>>();
  readonly #zkappEventsByAccount = new Map<string, Set<ZkappEventRow>>();
  readonly #zkappActionsByAccount = new Map<string, Set<ZkappActionRow>>();
  readonly #zkappEventsByLedger = new Map<string, Set<ZkappEventRow>>();
  readonly #zkappActionsByLedger = new Map<string, Set<ZkappActionRow>>();
  readonly #bridgeOperationsByAux = new Map<string, Set<BridgeOperationRow>>();
  readonly #bridgeOperationsById = new Map<string, BridgeOperationRow>();

  readonly accounts = new IndexedMap<string, AccountRow>({
    set: (_key, account, previous) => {
      if (previous) {
        this.#accountsById.delete(previous.id);
      }
      this.#accountsById.set(account.id, account);
    },
    delete: (_key, account) => {
      if (this.#accountsById.get(account.id) === account) {
        this.#accountsById.delete(account.id);
      }
    },
    clear: () => this.#accountsById.clear(),
  });
  readonly transactions = new IndexedMap<string, TransactionRow>({
    set: (_key, transaction, previous) => {
      if (previous) {
        removeFromSetIndex(this.#transactionsByHash, previous.hash, previous);
        if (this.#transactionsById.get(previous.id) === previous) {
          this.#transactionsById.delete(previous.id);
        }
      }
      addToSetIndex(this.#transactionsByHash, transaction.hash, transaction);
      this.#transactionsById.set(transaction.id, transaction);
    },
    delete: (_key, transaction) => {
      removeFromSetIndex(this.#transactionsByHash, transaction.hash, transaction);
      if (this.#transactionsById.get(transaction.id) === transaction) {
        this.#transactionsById.delete(transaction.id);
      }
    },
    clear: () => {
      this.#transactionsByHash.clear();
      this.#transactionsById.clear();
    },
  });
  readonly accountActivities = new IndexedMap<string, AccountActivityRow>({
    set: (_key, activity, previous) => {
      if (previous) {
        removeFromSetIndex(this.#accountActivitiesByLedger, previous.target_ledger_hash, previous);
      }
      addToSetIndex(this.#accountActivitiesByLedger, activity.target_ledger_hash, activity);
    },
    delete: (_key, activity) => {
      removeFromSetIndex(this.#accountActivitiesByLedger, activity.target_ledger_hash, activity);
    },
    clear: () => this.#accountActivitiesByLedger.clear(),
  });
  readonly zkappEvents = new IndexedMap<string, ZkappEventRow>({
    set: (_key, event, previous) => {
      if (previous) {
        removeFromSetIndex(
          this.#zkappEventsByAccount,
          previous.emitting_account_public_key,
          previous,
        );
        removeFromSetIndex(this.#zkappEventsByLedger, previous.target_ledger_hash, previous);
      }
      addToSetIndex(this.#zkappEventsByAccount, event.emitting_account_public_key, event);
      addToSetIndex(this.#zkappEventsByLedger, event.target_ledger_hash, event);
    },
    delete: (_key, event) => {
      removeFromSetIndex(this.#zkappEventsByAccount, event.emitting_account_public_key, event);
      removeFromSetIndex(this.#zkappEventsByLedger, event.target_ledger_hash, event);
    },
    clear: () => {
      this.#zkappEventsByAccount.clear();
      this.#zkappEventsByLedger.clear();
    },
  });
  readonly zkappActions = new IndexedMap<string, ZkappActionRow>({
    set: (_key, action, previous) => {
      if (previous) {
        removeFromSetIndex(
          this.#zkappActionsByAccount,
          previous.emitting_account_public_key,
          previous,
        );
        removeFromSetIndex(this.#zkappActionsByLedger, previous.target_ledger_hash, previous);
      }
      addToSetIndex(this.#zkappActionsByAccount, action.emitting_account_public_key, action);
      addToSetIndex(this.#zkappActionsByLedger, action.target_ledger_hash, action);
    },
    delete: (_key, action) => {
      removeFromSetIndex(this.#zkappActionsByAccount, action.emitting_account_public_key, action);
      removeFromSetIndex(this.#zkappActionsByLedger, action.target_ledger_hash, action);
    },
    clear: () => {
      this.#zkappActionsByAccount.clear();
      this.#zkappActionsByLedger.clear();
    },
  });
  readonly outerActions = new Map<string, OuterActionRow>();
  readonly innerActions = new Map<string, InnerActionRow>();
  readonly bridgeOperations = new IndexedMap<string, BridgeOperationRow>({
    set: (_key, operation, previous) => {
      if (previous) {
        removeFromSetIndex(this.#bridgeOperationsByAux, previous.aux, previous);
        if (this.#bridgeOperationsById.get(previous.id) === previous) {
          this.#bridgeOperationsById.delete(previous.id);
        }
      }
      addToSetIndex(this.#bridgeOperationsByAux, operation.aux, operation);
      this.#bridgeOperationsById.set(operation.id, operation);
    },
    delete: (_key, operation) => {
      removeFromSetIndex(this.#bridgeOperationsByAux, operation.aux, operation);
      if (this.#bridgeOperationsById.get(operation.id) === operation) {
        this.#bridgeOperationsById.delete(operation.id);
      }
    },
    clear: () => {
      this.#bridgeOperationsByAux.clear();
      this.#bridgeOperationsById.clear();
    },
  });
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
  readonly coreProjectionRemovals: CoreProjectionRemovals = {
    accountIds: new Set(),
    accountTransactionIds: new Set(),
    pendingDaLedgerHashes: new Set(),
    zkappEventIds: new Set(),
    zkappActionIds: new Set(),
    batchTransactionIds: new Set(),
  };
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
    return this.#accountsById.get(id);
  }

  transactionByHash(hash: string): TransactionRow | undefined {
    const matches = this.#transactionsByHash.get(hash);
    if (!matches) {
      return undefined;
    }
    let latest: TransactionRow | undefined;
    let latestApplied: TransactionRow | undefined;
    for (const transaction of matches) {
      if (!latest || transaction.block_height > latest.block_height) {
        latest = transaction;
      }
      if (
        transaction.status === "applied" &&
        (!latestApplied || transaction.block_height > latestApplied.block_height)
      ) {
        latestApplied = transaction;
      }
    }
    return latestApplied ?? latest;
  }

  transactionById(id: string): TransactionRow | undefined {
    return this.#transactionsById.get(id);
  }

  batchByLedger(ledgerHash: string): BatchRow | undefined {
    return this.batches.get(ledgerHash);
  }

  accountActivityByLedger(ledgerHash: string): AccountActivityRow[] {
    return [...(this.#accountActivitiesByLedger.get(ledgerHash) ?? [])];
  }

  zkappEventsByAccount(publicKey: string): ZkappEventRow[] {
    return [...(this.#zkappEventsByAccount.get(publicKey) ?? [])].sort(
      (left, right) => left.sequence_number - right.sequence_number,
    );
  }

  zkappActionsByAccount(publicKey: string): ZkappActionRow[] {
    return [...(this.#zkappActionsByAccount.get(publicKey) ?? [])].sort(
      (left, right) => left.sequence_number - right.sequence_number,
    );
  }

  zkappEventsByLedger(ledgerHash: string): ZkappEventRow[] {
    return [...(this.#zkappEventsByLedger.get(ledgerHash) ?? [])];
  }

  zkappActionsByLedger(ledgerHash: string): ZkappActionRow[] {
    return [...(this.#zkappActionsByLedger.get(ledgerHash) ?? [])];
  }

  bridgeOperationsByAux(aux: string): BridgeOperationRow[] {
    return [...(this.#bridgeOperationsByAux.get(aux) ?? [])].sort(
      (left, right) => left.aux_sequence - right.aux_sequence,
    );
  }

  bridgeOperationById(id: string): BridgeOperationRow | undefined {
    return this.#bridgeOperationsById.get(id);
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
    return this.#bridgeOperationsByAux.get(aux)?.size ?? 0;
  }

  upsertBatchForTest(ledgerHash: string, patch: Partial<BatchRow>): BatchRow {
    return this.upsertBatch(ledgerHash, patch, patch.submitted_at ?? "2026-05-13T00:00:00.000Z");
  }

  upsertBatch(ledgerHash: string, patch: Partial<BatchRow>, timestamp: string): BatchRow {
    const existing = this.batches.get(ledgerHash);
    const batch: BatchRow = {
      id: existing?.id ?? this.idFactory.newId(timestamp, `batch:${ledgerHash}`),
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

function addToSetIndex<Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = index.get(key);
  if (values) {
    values.add(value);
    return;
  }
  index.set(key, new Set([value]));
}

function removeFromSetIndex<Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = index.get(key);
  if (!values) {
    return;
  }
  values.delete(value);
  if (values.size === 0) {
    index.delete(key);
  }
}

export const accountKey = (publicKey: string, tokenId = "1"): string => `${publicKey}:${tokenId}`;
