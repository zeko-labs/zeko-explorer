import type { IndexerStore } from "./store.ts";
import type { DaSignatureInput, DaSignerRow } from "./types.ts";

export type ZekoIndexerOptions = {
  da?: {
    authorizedSigners?: Set<string>;
    quorum?: number;
    verifySignature?: (event: DaSignatureInput) => boolean;
  };
  bridge?: {
    innerActionPublicKeys?: ReadonlySet<string>;
    withdrawalDelaySlots?: number;
  };
};

export type PendingDaSignerState = {
  receivedAt: string;
  implementation: string;
  quorum: number;
  signers: DaSignerRow[];
};

export type ZekoIndexerState = {
  store: IndexerStore;
  options: ZekoIndexerOptions;
  pendingDaSigners: Map<string, PendingDaSignerState>;
};

export function ledgerHasRevertedTransactions(
  state: ZekoIndexerState,
  ledgerHash: string,
): boolean {
  return [...state.store.transactions.values()].some(
    (transaction) =>
      transaction.target_ledger_hash === ledgerHash && transaction.status === "reverted",
  );
}
