import { monotonicFactory } from "ulid";
import type {
  AccountActivityRow,
  AccountRow,
  BatchRow,
  PendingDaAttestationRow,
  SyncStatusRow,
  TransactionRow,
  ZkappActionRow,
  ZkappEventRow,
} from "./types.ts";

export type IdFactory = {
  newId(timestamp: string | number): string;
};

export type IndexerStore = {
  readonly accounts: Map<string, AccountRow>;
  readonly transactions: Map<string, TransactionRow>;
  readonly accountActivities: Map<string, AccountActivityRow>;
  readonly zkappEvents: Map<string, ZkappEventRow>;
  readonly zkappActions: Map<string, ZkappActionRow>;
  readonly batches: Map<string, BatchRow>;
  readonly pendingDa: Map<string, PendingDaAttestationRow>;
  readonly syncStatus: Map<string, SyncStatusRow>;
  readonly ledgerOrder: string[];
  readonly idFactory: IdFactory;

  accountByPublicKey(publicKey: string): AccountRow | undefined;
  transactionByHash(hash: string): TransactionRow | undefined;
  batchByLedger(ledgerHash: string): BatchRow | undefined;
  accountActivityByLedger(ledgerHash: string): AccountActivityRow[];
  zkappEventsByAccount(publicKey: string): ZkappEventRow[];
  zkappActionsByAccount(publicKey: string): ZkappActionRow[];
  zkappEventsByLedger(ledgerHash: string): ZkappEventRow[];
  zkappActionsByLedger(ledgerHash: string): ZkappActionRow[];
  nextTransactionSequence(): number;
  nextBatchHeight(): number;
  nextEventSequence(): number;
  nextActionSequence(): number;
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
  readonly batches = new Map<string, BatchRow>();
  readonly pendingDa = new Map<string, PendingDaAttestationRow>();
  readonly syncStatus = new Map<string, SyncStatusRow>();
  readonly ledgerOrder: string[] = [];
  readonly idFactory: IdFactory;

  constructor(idFactory: IdFactory = new UlidFactory()) {
    this.idFactory = idFactory;
  }

  accountByPublicKey(publicKey: string): AccountRow | undefined {
    return this.accounts.get(publicKey);
  }

  transactionByHash(hash: string): TransactionRow | undefined {
    return this.transactions.get(hash);
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
