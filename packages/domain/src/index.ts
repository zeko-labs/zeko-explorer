export type NetworkId =
  | "zeko-m-local"
  | "zeko-m-devnet"
  | "zeko-m-alphanet"
  | "zeko-m-mainnet"
  | "zeko-e-testnet"
  | "zeko-e-mainnet";

export type HealthStatus = "ok" | "degraded" | "down";

export type DaStatus = "attested";

export type DaSource = "settlement" | "proved" | "da-direct";

export interface ComponentHealth {
  readonly component: string;
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly details?: Record<string, unknown>;
}

export interface BatchStatus {
  readonly network: NetworkId;
  readonly targetLedgerHash: string;
  readonly daStatus?: DaStatus;
  readonly daSource?: DaSource;
  readonly daAttestedAt?: string;
}
