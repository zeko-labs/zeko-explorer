import type { DaSignatureEvent } from "./da";
import type { L1SettlementEventType } from "./l1";
import type { L2FinalityLevel } from "./l2";
import type { NetworkId } from "./shared";

export const NATS_MESSAGE_ID = {
  l2Transaction: (targetLedgerHash: string) => targetLedgerHash,
  l2Finality: (level: L2FinalityLevel, ledgerHash: string) => `finality-${level}-${ledgerHash}`,
  l1Settlement: (
    network: NetworkId,
    settlementId: string,
    eventType: L1SettlementEventType,
    confirmationDepth: number,
  ) =>
    eventType === "finalized"
      ? `l1-settlement:${network}:${settlementId}:finalized`
      : `l1-settlement:${network}:${settlementId}:detected:${confirmationDepth}`,
  l1OuterAction: (network: NetworkId, outerActionId: string) =>
    `l1-outer-action:${network}:${outerActionId}`,
  l1BridgeEvent: (network: NetworkId, bridgeEventId: string) =>
    `l1-bridge-event:${network}:${bridgeEventId}`,
  l1Rollback: (network: NetworkId, rollbackId: string) => `l1-rollback:${network}:${rollbackId}`,
  daSignature: (event: DaSignatureEvent) =>
    event.implementation === "zeko-multisig-v1"
      ? `da-sig-${event.publicKey}-${event.ledgerHash}`
      : `da-sig-celestia-${event.ledgerHash}`,
} as const;
