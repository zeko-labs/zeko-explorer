import type { DaSource } from "@zeko/domain";
import type { FinalityEvent, SettlementEvent } from "@zeko/nats-protocol";

export interface BatchDaProjection {
  readonly targetLedgerHash: string;
  readonly daStatus?: "attested";
  readonly daSource?: DaSource;
  readonly daAttestedAt?: string;
}

export interface PendingDaAttestation {
  readonly ledgerHash: string;
  readonly source: DaSource;
  readonly attestedAt?: string;
  readonly receivedAt: string;
}

export interface DaStatusState {
  readonly batches: ReadonlyMap<string, BatchDaProjection>;
  readonly pending: ReadonlyMap<string, PendingDaAttestation>;
}

export function applySettlement(state: DaStatusState, event: SettlementEvent): DaStatusState {
  const existing = state.batches.get(event.targetLedgerHash);
  const nextBatch: BatchDaProjection =
    existing?.daStatus === "attested"
      ? existing
      : {
          targetLedgerHash: event.targetLedgerHash,
          daStatus: "attested",
          daSource: "settlement",
          daAttestedAt: event.timestamp,
        };

  const batches = new Map(state.batches);
  const pending = new Map(state.pending);
  batches.set(event.targetLedgerHash, nextBatch);
  pending.delete(event.targetLedgerHash);

  return { batches, pending };
}

export function applyFinality(
  state: DaStatusState,
  event: FinalityEvent,
  receivedAt = event.timestamp,
): DaStatusState {
  if (event.level !== "proved") {
    return state;
  }

  const existing = state.batches.get(event.ledgerHash);
  const batches = new Map(state.batches);
  const pending = new Map(state.pending);

  if (existing) {
    if (!existing.daStatus) {
      batches.set(event.ledgerHash, {
        ...existing,
        daStatus: "attested",
        daSource: "proved",
        daAttestedAt: event.timestamp,
      });
    }

    return { batches, pending };
  }

  pending.set(event.ledgerHash, {
    ledgerHash: event.ledgerHash,
    source: "proved",
    attestedAt: event.timestamp,
    receivedAt,
  });

  return { batches, pending };
}

export const emptyDaStatusState: DaStatusState = {
  batches: new Map(),
  pending: new Map(),
};
