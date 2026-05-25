import { DaSignatureEventSchema, EventSchemas } from "@zeko/nats";
import { parse } from "valibot";
import { type IndexerStore, normalizeTimestamp } from "./store";
import type {
  AccountActivityRow,
  AccountRow,
  ConsumeEnvelope,
  DaSignatureInput,
  DaSignerRow,
  DaSource,
  L1RollbackInput,
  L1SettlementInput,
  L2AccountUpdateInput,
  L2CommandInput,
  L2FinalityInput,
  L2TransactionInput,
  ObservedZkappActionInput,
  PendingDaAttestationRow,
  TransactionRow,
} from "./types";

export type ZekoIndexerOptions = {
  da?: {
    authorizedSigners?: Set<string>;
    quorum?: number;
    verifySignature?: (event: DaSignatureInput) => boolean;
  };
};

const L2_SOURCE = "l2-transactions";
const GENESIS_ACTION_STATE = "0";
const PRECEDENCE: Record<DaSource, number> = {
  proved: 1,
  "da-direct": 2,
  settlement: 3,
};

export class ZekoIndexer {
  readonly #store: IndexerStore;
  readonly #options: ZekoIndexerOptions;
  readonly #pendingDaSigners = new Map<
    string,
    {
      receivedAt: string;
      implementation: string;
      quorum: number;
      signers: DaSignerRow[];
    }
  >();

  constructor(store: IndexerStore, options: ZekoIndexerOptions = {}) {
    this.#store = store;
    this.#options = options;
  }

  async consume(envelope: ConsumeEnvelope): Promise<void> {
    switch (envelope.subject) {
      case "zeko.l2.transactions":
        this.consumeL2Transaction(
          parse(EventSchemas.l2Transactions, envelope.payload) as unknown as L2TransactionInput,
        );
        break;
      case "zeko.l2.finality":
        this.consumeL2Finality(
          parse(EventSchemas.l2Finality, envelope.payload) as unknown as L2FinalityInput,
        );
        break;
      case "zeko.l1.settlements":
        this.consumeL1Settlement(
          parse(EventSchemas.l1Settlements, envelope.payload) as unknown as L1SettlementInput,
        );
        break;
      case "zeko.l1.rollbacks":
        this.consumeL1Rollback(
          parse(EventSchemas.l1Rollbacks, envelope.payload) as unknown as L1RollbackInput,
        );
        break;
      case "zeko.da.signatures":
        this.consumeDaSignature(
          parse(DaSignatureEventSchema, envelope.payload) as unknown as DaSignatureInput,
        );
        break;
    }
  }

  consumeL2Transaction(event: L2TransactionInput): void {
    const txHash = event.command?.hash ?? `${event.target_ledger_hash}:diff`;
    const existing = this.#store.transactionByHash(txHash);
    if (
      existing &&
      existing.source_ledger_hash === event.source_ledger_hash &&
      existing.target_ledger_hash === event.target_ledger_hash
    ) {
      return;
    }

    this.reconcileLedgerChain(event);
    this.assertNewZkappActionStates(event);

    const timestamp = normalizeTimestamp(event.timestamp);
    const sequence = this.#store.nextTransactionSequence();
    const row: TransactionRow = {
      id: this.#store.idFactory.newId(timestamp),
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
    this.#store.transactions.set(txHash, row);
    if (this.#store.ledgerOrder.length === 0) {
      this.#store.ledgerOrder.push(event.source_ledger_hash);
    }
    this.#store.ledgerOrder.push(event.target_ledger_hash);

    event.changed_accounts.forEach((change) => {
      const activityIndex = change.index;
      const publicKey = change.account.public_key;
      const previous = this.#store.accountByPublicKey(publicKey);
      const account: AccountRow = {
        id: previous?.id ?? this.#store.idFactory.newId(timestamp),
        public_key: publicKey,
        token_id: change.account.token_id ?? previous?.token_id ?? "1",
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
      this.#store.accounts.set(publicKey, account);
      this.#store.accountActivities.set(`${txHash}:${publicKey}:${activityIndex}`, {
        id: this.#store.idFactory.newId(timestamp),
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
      this.writeZkappChildren(event, row);
    }

    this.#store.syncStatus.set(L2_SOURCE, {
      source: L2_SOURCE,
      status: "healthy",
      last_sequence: sequence,
      last_hash: event.target_ledger_hash,
      last_height: sequence,
      last_processed_at: timestamp,
    });
    this.linkTransactionsToBatch(event.target_ledger_hash, timestamp);
  }

  private assertNewZkappActionStates(event: L2TransactionInput): void {
    if (event.command?.type !== "zkapp_command") {
      return;
    }

    const existingActionStates = new Set(
      [...this.#store.zkappActions.values()].map((action) => action.action_state),
    );
    const incomingActionStates = new Set<string>();
    for (const update of event.command.account_updates ?? []) {
      const publicKey = accountUpdatePublicKey(update);
      if (!publicKey) {
        continue;
      }
      const changedAccount = event.changed_accounts.find(
        (change) => change.account.public_key === publicKey,
      );
      const actions = normalizeObservedActions(update.actions ?? update.body?.actions ?? [], {
        beforeHead: this.#store.accountByPublicKey(publicKey)?.action_state?.[0],
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

  consumeL2Finality(event: L2FinalityInput): void {
    if (event.level !== "proved") {
      return;
    }

    const batch = this.#store.batchByLedger(event.ledger_hash);
    if (batch?.settlement_status === "rolled_back") {
      return;
    }
    const indexedTargetLedger = [...this.#store.transactions.values()].some(
      (transaction) =>
        transaction.status === "applied" && transaction.target_ledger_hash === event.ledger_hash,
    );
    if (!batch && !indexedTargetLedger) {
      this.upsertPendingDa(event.ledger_hash, "proved", event.timestamp);
      return;
    }

    this.#store.upsertBatch(
      event.ledger_hash,
      { proof_status: "proved", proved_at: event.timestamp },
      event.timestamp,
    );
    this.linkTransactionsToBatch(event.ledger_hash, event.timestamp);
    this.applyDaAttestation(event.ledger_hash, "proved", event.timestamp);
  }

  consumeL1Settlement(event: L1SettlementInput): void {
    const ledgerHash = event.commit.ledgerHash;
    const observedAt = event.observedAt;
    const incomingStatus = event.finalityLevel === "finalized" ? "finalized" : "settling";
    const existing = this.#store.batchByLedger(ledgerHash);
    if (existing?.settlement_status === "rolled_back") {
      return;
    }
    const settlementStatus = chooseSettlementStatus(existing?.settlement_status, incomingStatus);
    const downgradeFromFinalized =
      existing?.settlement_status === "finalized" && incomingStatus !== "finalized";
    this.#store.upsertBatch(
      ledgerHash,
      {
        settlement_id: event.settlementId,
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
    this.linkTransactionsToBatch(ledgerHash, observedAt);
    this.applyDaAttestation(ledgerHash, "settlement", observedAt);
    this.#store.pendingDa.delete(ledgerHash);
  }

  consumeL1Rollback(event: L1RollbackInput): void {
    for (const settlementId of event.affected.settlementIds) {
      const batch = [...this.#store.batches.values()].find(
        (candidate) => candidate.settlement_id === settlementId,
      );
      if (!batch) {
        continue;
      }
      if (batch.da_status === "attested" && batch.da_source) {
        this.upsertPendingDa(batch.target_ledger_hash, batch.da_source, batch.da_attested_at);
      }
      this.#store.upsertBatch(
        batch.target_ledger_hash,
        {
          settlement_status: "pending",
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

  consumeDaSignature(event: DaSignatureInput): void {
    if (event.implementation !== "zeko-multisig-v1") {
      return;
    }

    const { authorizedSigners, quorum = 1, verifySignature = () => false } = this.#options.da ?? {};
    if (authorizedSigners && !authorizedSigners.has(event.publicKey)) {
      return;
    }
    if (!verifySignature(event)) {
      return;
    }

    const signer: DaSignerRow = {
      publicKey: event.publicKey,
      signedAt: event.signedAt,
      instanceId: event.instanceId,
    };
    const batch = this.#store.batchByLedger(event.ledgerHash);
    const pending = this.#store.pendingDa.get(event.ledgerHash);
    const pendingSigners = this.#pendingDaSigners.get(event.ledgerHash);
    const signers = appendSigner(
      batch?.da_signers ?? pending?.signers ?? pendingSigners?.signers ?? [],
      signer,
    );
    if (batch) {
      const patch =
        signers.length >= quorum
          ? {
              da_status: "attested" as const,
              da_source: chooseDaSource(batch.da_source, "da-direct"),
              da_attested_at:
                batch.da_source === "settlement" ? batch.da_attested_at : event.signedAt,
              da_implementation: event.implementation,
              da_quorum_threshold: quorum,
              da_signers: signers,
            }
          : { da_signers: signers };
      this.#store.upsertBatch(event.ledgerHash, patch, event.signedAt);
      return;
    }

    if (signers.length < quorum) {
      this.#pendingDaSigners.set(event.ledgerHash, {
        receivedAt: pendingSigners?.receivedAt ?? event.signedAt,
        implementation: event.implementation,
        quorum,
        signers,
      });
      this.#store.pendingDa.set(event.ledgerHash, {
        ledger_hash: event.ledgerHash,
        source: chooseDaSource(pending?.source, "da-direct"),
        received_at: pending?.received_at ?? pendingSigners?.receivedAt ?? event.signedAt,
        attested_at: shouldReplaceAttestedAt(pending?.source, "da-direct")
          ? undefined
          : pending?.attested_at,
        implementation: event.implementation,
        quorum_threshold: quorum,
        signers,
      });
      return;
    }

    this.#store.pendingDa.set(event.ledgerHash, {
      ledger_hash: event.ledgerHash,
      source: chooseDaSource(pending?.source, "da-direct"),
      received_at: pending?.received_at ?? event.signedAt,
      attested_at: shouldReplaceAttestedAt(pending?.source, "da-direct")
        ? event.signedAt
        : pending?.attested_at,
      implementation: event.implementation,
      quorum_threshold: quorum,
      signers,
    });
    this.#pendingDaSigners.delete(event.ledgerHash);
  }

  prunePendingDa(now: string | number, maxAgeDays = 30): void {
    const cutoff = Date.parse(normalizeTimestamp(now)) - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const [ledgerHash, pending] of this.#store.pendingDa) {
      if (Date.parse(pending.received_at) <= cutoff) {
        this.#store.pendingDa.delete(ledgerHash);
      }
    }
  }

  private reconcileLedgerChain(event: L2TransactionInput): void {
    const lastHash = this.#store.syncStatus.get(L2_SOURCE)?.last_hash;
    if (!lastHash || event.source_ledger_hash === lastHash) {
      return;
    }

    const ancestorIndex = this.#store.ledgerOrder.indexOf(event.source_ledger_hash);
    if (ancestorIndex < 0) {
      this.#store.syncStatus.set(L2_SOURCE, {
        source: L2_SOURCE,
        status: "paused",
        last_hash: lastHash,
        error: `Unknown source ledger hash ${event.source_ledger_hash}; backfill required`,
      });
      throw new Error(`L2 gap detected from ${lastHash} to ${event.source_ledger_hash}`);
    }

    const rolledBack = this.#store.ledgerOrder.splice(ancestorIndex + 1);
    const rollbackScope = new Set(rolledBack);
    const detectedAt = normalizeTimestamp(event.timestamp);
    for (const ledgerHash of rolledBack) {
      this.rollbackL2Ledger(ledgerHash, rollbackScope, detectedAt);
    }
  }

  private rollbackL2Ledger(
    ledgerHash: string,
    rollbackScope = new Set([ledgerHash]),
    detectedAt = normalizeTimestamp(Date.now()),
  ): void {
    const invalidatedBatchIds = new Set(
      [...this.#store.batches.values()]
        .filter((batch) => rollbackScope.has(batch.target_ledger_hash))
        .map((batch) => batch.id),
    );
    for (const tx of this.#store.transactions.values()) {
      if (tx.batch && invalidatedBatchIds.has(tx.batch)) {
        tx.batch = undefined;
      }
      if (tx.target_ledger_hash === ledgerHash) {
        tx.status = "reverted";
        tx.rollback_reason = "l2_hash_chain_break";
      }
    }
    for (const batch of this.#store.batches.values()) {
      if (rollbackScope.has(batch.target_ledger_hash)) {
        this.#store.upsertBatch(
          batch.target_ledger_hash,
          {
            first_tx_height: 0,
            last_tx_height: 0,
            transaction_count: 0,
            settlement_status: "rolled_back",
          },
          detectedAt,
        );
      }
    }
    for (const [id, event] of this.#store.zkappEvents) {
      if (event.target_ledger_hash === ledgerHash) {
        this.#store.zkappEvents.delete(id);
      }
    }
    for (const [id, action] of this.#store.zkappActions) {
      if (action.target_ledger_hash === ledgerHash) {
        this.#store.zkappActions.delete(id);
      }
    }

    const affectedAccounts = new Set(
      [...this.#store.accountActivities.values()]
        .filter((activity) => activity.target_ledger_hash === ledgerHash)
        .map((activity) => activity.account_public_key),
    );
    for (const publicKey of affectedAccounts) {
      const latest = [...this.#store.accountActivities.values()]
        .filter((activity) => {
          const transaction = [...this.#store.transactions.values()].find(
            (candidate) => candidate.id === activity.transaction,
          );
          return (
            activity.account_public_key === publicKey &&
            !rollbackScope.has(activity.target_ledger_hash) &&
            transaction?.status !== "reverted"
          );
        })
        .sort((left, right) => right.block_height - left.block_height)[0];
      const account = this.#store.accountByPublicKey(publicKey);
      if (!account) {
        continue;
      }
      if (!latest) {
        this.#store.accounts.delete(publicKey);
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
      this.#store.accounts.set(publicKey, account);
    }
  }

  private linkTransactionsToBatch(ledgerHash: string, timestamp: string): void {
    const batch = this.#store.batchByLedger(ledgerHash);
    const targetTransaction = [...this.#store.transactions.values()].find(
      (transaction) =>
        transaction.status === "applied" && transaction.target_ledger_hash === ledgerHash,
    );
    if (!batch || !targetTransaction) {
      return;
    }

    const newlyCovered = [...this.#store.transactions.values()]
      .filter(
        (transaction) =>
          transaction.status === "applied" &&
          transaction.batch === undefined &&
          transaction.block_height <= targetTransaction.block_height,
      )
      .sort((left, right) => left.block_height - right.block_height);
    for (const transaction of newlyCovered) {
      transaction.batch = batch.id;
    }

    const covered = [...this.#store.transactions.values()]
      .filter((transaction) => transaction.batch === batch.id)
      .sort((left, right) => left.block_height - right.block_height);
    const first = covered[0];
    const last = covered.at(-1);
    if (!first || !last) {
      return;
    }

    this.#store.upsertBatch(
      ledgerHash,
      {
        first_tx_height: first.block_height,
        last_tx_height: last.block_height,
        transaction_count: covered.length,
      },
      timestamp,
    );
  }

  private writeZkappChildren(event: L2TransactionInput, transaction: TransactionRow): void {
    const updates = event.command?.account_updates ?? [];
    for (const update of updates) {
      const publicKey = accountUpdatePublicKey(update);
      if (!publicKey) {
        continue;
      }
      const account = this.#store.accountByPublicKey(publicKey);
      if (!account) {
        continue;
      }
      const activity = [...this.#store.accountActivities.values()].find(
        (candidate) =>
          candidate.transaction === transaction.id && candidate.account_public_key === publicKey,
      );
      const events = normalizeFieldArrays(update.events ?? update.body?.events ?? []);
      events.forEach((fields, eventIndex) => {
        const key = `${transaction.hash}:${publicKey}:event:${eventIndex}`;
        if (this.#store.zkappEvents.has(key)) {
          return;
        }
        this.#store.zkappEvents.set(key, {
          id: this.#store.idFactory.newId(transaction.timestamp),
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
          sequence_number: this.#store.nextEventSequence(),
          target_ledger_hash: event.target_ledger_hash,
        });
      });

      const actions = normalizeObservedActions(update.actions ?? update.body?.actions ?? [], {
        beforeHead: activity?.action_state_before?.[0],
        afterHeads: activity?.action_state_after,
      });
      actions.forEach((action, actionIndex) => {
        const key = `${transaction.hash}:${publicKey}:action:${actionIndex}`;
        if (this.#store.zkappActions.has(key)) {
          return;
        }
        this.#store.zkappActions.set(key, {
          id: this.#store.idFactory.newId(transaction.timestamp),
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
          sequence_number: this.#store.nextActionSequence(),
          target_ledger_hash: event.target_ledger_hash,
        });
      });
    }
  }

  private applyDaAttestation(ledgerHash: string, source: DaSource, attestedAt?: string): void {
    const batch = this.#store.batchByLedger(ledgerHash);
    if (!batch) {
      this.upsertPendingDa(ledgerHash, source, attestedAt);
      return;
    }

    const pending = this.#store.pendingDa.get(ledgerHash);
    const pendingSigners = this.#pendingDaSigners.get(ledgerHash);
    const pendingDirectHasQuorum =
      pending?.source === "da-direct" &&
      (pending.signers?.length ?? 0) >= (pending.quorum_threshold ?? Number.POSITIVE_INFINITY);
    const pendingAttestation =
      pending?.source && (pending.source !== "da-direct" || pendingDirectHasQuorum)
        ? pending
        : undefined;
    const pendingSource = pendingAttestation?.source;
    const incomingSource = pendingSource ? chooseDaSource(pendingSource, source) : source;
    const nextSource = chooseDaSource(batch.da_source, incomingSource);
    const incomingAttestedAt =
      pendingSource && incomingSource === pendingSource
        ? (pendingAttestation.attested_at ?? attestedAt)
        : attestedAt;
    this.#store.upsertBatch(
      ledgerHash,
      {
        da_status: "attested",
        da_source: nextSource,
        da_attested_at: shouldReplaceAttestedAt(batch.da_source, incomingSource)
          ? incomingAttestedAt
          : batch.da_attested_at,
        da_implementation:
          pending?.implementation ?? pendingSigners?.implementation ?? batch.da_implementation,
        da_quorum_threshold:
          pending?.quorum_threshold ?? pendingSigners?.quorum ?? batch.da_quorum_threshold,
        da_signers: mergeSigners(
          mergeSigners(batch.da_signers, pending?.signers),
          pendingSigners?.signers,
        ),
      },
      attestedAt ?? normalizeTimestamp(Date.now()),
    );
    this.#store.pendingDa.delete(ledgerHash);
    this.#pendingDaSigners.delete(ledgerHash);
  }

  private upsertPendingDa(ledgerHash: string, source: DaSource, attestedAt?: string): void {
    const existing = this.#store.pendingDa.get(ledgerHash);
    const nextSource = chooseDaSource(existing?.source, source);
    const row: PendingDaAttestationRow = {
      ledger_hash: ledgerHash,
      source: nextSource,
      attested_at: shouldReplaceAttestedAt(existing?.source, source)
        ? attestedAt
        : existing?.attested_at,
      received_at: existing?.received_at ?? attestedAt ?? normalizeTimestamp(Date.now()),
      implementation: existing?.implementation,
      quorum_threshold: existing?.quorum_threshold,
      signers: existing?.signers,
    };
    this.#store.pendingDa.set(ledgerHash, row);
  }
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

const accountUpdatePublicKey = (update: L2AccountUpdateInput): string | undefined =>
  update.public_key ?? update.account?.public_key ?? update.body?.public_key;

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
): ObservedZkappActionInput[] =>
  items.flatMap((item, index) => {
    const rawFields = rawActionFields(item);
    if (rawFields) {
      const before = actionStateBefore(index, items.length, state);
      const after = actionStateAfter(index, items.length, state);
      if (!before || !after) {
        throw new Error("Cannot index raw zkApp action without action_state snapshots");
      }
      return [
        {
          fields: rawFields,
          before_action_state: before,
          action_state: after,
        },
      ];
    }
    if (!isRecord(item) || !Array.isArray(item.fields)) {
      return [];
    }
    if (typeof item.before_action_state !== "string" || typeof item.action_state !== "string") {
      return [];
    }
    return [
      {
        fields: item.fields.map(String),
        before_action_state: item.before_action_state,
        action_state: item.action_state,
      },
    ];
  });

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

const actionStateBefore = (
  actionIndex: number,
  actionCount: number,
  state: ActionStateContext,
): string | undefined => {
  if (actionIndex === 0) {
    return state.beforeHead ?? GENESIS_ACTION_STATE;
  }
  return state.afterHeads?.[actionCount - actionIndex];
};

const actionStateAfter = (
  actionIndex: number,
  actionCount: number,
  state: ActionStateContext,
): string | undefined => state.afterHeads?.[actionCount - actionIndex - 1];

const isRecord = (item: unknown): item is Record<string, unknown> =>
  typeof item === "object" && item !== null;

const chooseDaSource = (current: DaSource | undefined, incoming: DaSource): DaSource => {
  if (!current) {
    return incoming;
  }
  return PRECEDENCE[incoming] > PRECEDENCE[current] ? incoming : current;
};

const shouldReplaceAttestedAt = (current: DaSource | undefined, incoming: DaSource): boolean =>
  !current || PRECEDENCE[incoming] > PRECEDENCE[current];

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

const appendSigner = (signers: DaSignerRow[], signer: DaSignerRow): DaSignerRow[] => {
  if (signers.some((existing) => existing.publicKey === signer.publicKey)) {
    return signers;
  }
  return [...signers, signer].sort((left, right) => left.publicKey.localeCompare(right.publicKey));
};

const mergeSigners = (
  first: DaSignerRow[] | undefined,
  second: DaSignerRow[] | undefined,
): DaSignerRow[] | undefined => {
  const signers = [...(first ?? [])];
  for (const signer of second ?? []) {
    if (!signers.some((existing) => existing.publicKey === signer.publicKey)) {
      signers.push(signer);
    }
  }
  return signers.length > 0
    ? signers.sort((left, right) => left.publicKey.localeCompare(right.publicKey))
    : undefined;
};
