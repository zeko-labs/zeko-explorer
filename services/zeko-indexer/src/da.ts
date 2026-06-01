import { ledgerHasRevertedTransactions, type ZekoIndexerState } from "./indexer-state.ts";
import { normalizeTimestamp } from "./store.ts";
import type { DaSignatureInput, DaSignerRow, DaSource, PendingDaAttestationRow } from "./types.ts";

const PRECEDENCE: Record<DaSource, number> = {
  proved: 1,
  "da-direct": 2,
  settlement: 3,
};

export function consumeDaSignature(state: ZekoIndexerState, event: DaSignatureInput): void {
  if (event.implementation !== "zeko-multisig-v1") {
    return;
  }
  if (ledgerHasRevertedTransactions(state, event.ledgerHash)) {
    return;
  }

  const { authorizedSigners, quorum = 1, verifySignature = () => false } = state.options.da ?? {};
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
  const batch = state.store.batchByLedger(event.ledgerHash);
  const pending = state.store.pendingDa.get(event.ledgerHash);
  const pendingSigners = state.pendingDaSigners.get(event.ledgerHash);
  const signers = appendSigner(
    batch?.da_signers ?? pending?.signers ?? pendingSigners?.signers ?? [],
    signer,
  );
  if (batch) {
    if (batch.settlement_status === "rolled_back") {
      return;
    }
    const patch =
      signers.length >= quorum
        ? {
            da_status: "attested" as const,
            da_source: chooseDaSource(batch.da_source, "da-direct"),
            da_attested_at: shouldReplaceAttestedAt(batch.da_source, "da-direct")
              ? event.signedAt
              : batch.da_attested_at,
            da_implementation: event.implementation,
            da_quorum_threshold: quorum,
            da_signers: signers,
          }
        : { da_signers: signers };
    state.store.upsertBatch(event.ledgerHash, patch, event.signedAt);
    return;
  }

  if (signers.length < quorum) {
    state.pendingDaSigners.set(event.ledgerHash, {
      receivedAt: pendingSigners?.receivedAt ?? event.signedAt,
      implementation: event.implementation,
      quorum,
      signers,
    });
    state.store.pendingDa.set(event.ledgerHash, {
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

  state.store.pendingDa.set(event.ledgerHash, {
    ledger_hash: event.ledgerHash,
    source: chooseDaSource(pending?.source, "da-direct"),
    received_at: pending?.received_at ?? event.signedAt,
    attested_at: directDaAttestedAt(pending, event.signedAt),
    implementation: event.implementation,
    quorum_threshold: quorum,
    signers,
  });
  state.pendingDaSigners.delete(event.ledgerHash);
}

export function prunePendingDa(
  state: ZekoIndexerState,
  now: string | number,
  maxAgeDays = 30,
): void {
  const cutoff = Date.parse(normalizeTimestamp(now)) - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [ledgerHash, pending] of state.store.pendingDa) {
    if (Date.parse(pending.received_at) <= cutoff) {
      removePendingDa(state, ledgerHash);
      state.pendingDaSigners.delete(ledgerHash);
    }
  }
}

export function applyDaAttestation(
  state: ZekoIndexerState,
  ledgerHash: string,
  source: DaSource,
  attestedAt?: string,
): void {
  const batch = state.store.batchByLedger(ledgerHash);
  if (!batch) {
    upsertPendingDa(state, ledgerHash, source, attestedAt);
    return;
  }

  const pending = state.store.pendingDa.get(ledgerHash);
  const pendingSigners = state.pendingDaSigners.get(ledgerHash);
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
  state.store.upsertBatch(
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
  removePendingDa(state, ledgerHash);
  state.pendingDaSigners.delete(ledgerHash);
}

export function removePendingDa(state: ZekoIndexerState, ledgerHash: string): void {
  if (state.store.pendingDa.has(ledgerHash)) {
    state.store.coreProjectionRemovals.pendingDaLedgerHashes.add(ledgerHash);
  }
  state.store.pendingDa.delete(ledgerHash);
}

export function upsertPendingDa(
  state: ZekoIndexerState,
  ledgerHash: string,
  source: DaSource,
  attestedAt?: string,
  facts: {
    implementation?: string;
    quorum_threshold?: number;
    signers?: DaSignerRow[];
  } = {},
): void {
  const existing = state.store.pendingDa.get(ledgerHash);
  const nextSource = chooseDaSource(existing?.source, source);
  const row: PendingDaAttestationRow = {
    ledger_hash: ledgerHash,
    source: nextSource,
    attested_at: shouldReplaceAttestedAt(existing?.source, source)
      ? attestedAt
      : existing?.attested_at,
    received_at: existing?.received_at ?? attestedAt ?? normalizeTimestamp(Date.now()),
    implementation: facts.implementation ?? existing?.implementation,
    quorum_threshold: facts.quorum_threshold ?? existing?.quorum_threshold,
    signers: mergeSigners(existing?.signers, facts.signers),
  };
  state.store.pendingDa.set(ledgerHash, row);
}

export const chooseDaSource = (current: DaSource | undefined, incoming: DaSource): DaSource => {
  if (!current) {
    return incoming;
  }
  return PRECEDENCE[incoming] > PRECEDENCE[current] ? incoming : current;
};

export const shouldReplaceAttestedAt = (
  current: DaSource | undefined,
  incoming: DaSource,
): boolean => !current || PRECEDENCE[incoming] > PRECEDENCE[current];

const directDaAttestedAt = (
  pending: PendingDaAttestationRow | undefined,
  signedAt: string,
): string | undefined => {
  const nextSource = chooseDaSource(pending?.source, "da-direct");
  if (nextSource !== "da-direct") {
    return pending?.attested_at;
  }
  if (shouldReplaceAttestedAt(pending?.source, "da-direct")) {
    return signedAt;
  }
  return pending?.attested_at ?? signedAt;
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
