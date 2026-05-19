export type L1Provider = "mina" | "ethereum";

export type ZekoMNetwork = "zeko-m-devnet" | "zeko-m-alphanet" | "zeko-m-mainnet";
export type ZekoENetwork = "zeko-e-testnet-1" | "zeko-e-mainnet";
export type L1Network = ZekoMNetwork | ZekoENetwork;

export type L1BlockRef = {
  height: number;
  hash: string;
  parentHash: string;
  slot?: number;
  timestamp?: string;
  confirmationDepth?: number;
};

export type L1SourceHealth = {
  liveNode: "healthy" | "degraded" | "down";
  archive: "healthy" | "degraded" | "down";
  tipHeight?: number;
  archiveHeight?: number;
  lagBlocks?: number;
  lastError?: string;
};

export type L1SettlementFact = {
  settlementId: string;
  txHash: string;
  block: L1BlockRef;
  finalityLevel: "settling" | "finalized";
  providerPayload: Record<string, unknown>;
};

export type L1OuterActionFact = {
  outerActionId: string;
  txHash: string;
  block: L1BlockRef;
  actionKind: "commit" | "witness" | "unknown";
  rawFields: string[];
  providerPayload: Record<string, unknown>;
};

export type L1BridgeEventFact = {
  bridgeEventId: string;
  type: "deposit_submitted" | "withdrawal_finalized" | "deposit_cancelled";
  txHash: string;
  block: L1BlockRef;
  userPk: string;
  userPkSource: "account_update" | "fee_payer" | "event_log" | "unknown";
  aux?: string;
  amount?: string;
  recipient?: string;
  operationIndex?: number;
  providerPayload: Record<string, unknown>;
};

export type L1RollbackFact = {
  rollbackId: string;
  commonAncestor: L1BlockRef;
  orphanedBlocks: L1BlockRef[];
  replacementBlocks: L1BlockRef[];
};

export interface L1Adapter {
  readonly provider: L1Provider;
  readonly network: L1Network;

  getBestChain(depth: number): Promise<L1BlockRef[]>;
  watchBestChainHints(onHint: () => Promise<void>): Promise<AbortController>;
  getSourceHealth(): Promise<L1SourceHealth>;
}

export type MinaAccountUpdate = {
  accountUpdateId: string;
  publicKey: string;
  tokenId: string;
  authorizationKind: "signature" | "proof" | "none" | "unknown";
  actions: string[][];
  events: string[][];
  appState: string[];
  balanceChange?: string;
  preconditions: {
    accountState?: string[];
    actionState?: string;
    validWhileLower?: number;
    validWhileUpper?: number;
  };
};

export type MinaZkappCommand = {
  txHash: string;
  status: "applied" | "failed" | "unknown";
  memo?: string;
  feePayer: string;
  sequenceNumber?: number;
  accountUpdates: MinaAccountUpdate[];
};

export type MinaArchiveOuterAction = {
  block: L1BlockRef & {
    chainStatus: string;
    distanceFromMaxBlockHeight: number;
  };
  txHash: string;
  transactionSequenceNumber: number;
  accountUpdateId: string;
  actionIndex: number;
  actionStateVector: [string, string, string, string, string];
  fields: string[];
};

export type MinaArchiveZkappCommandPage = {
  fromHeight: number;
  toHeight: number;
  commands: MinaZkappCommand[];
};

export interface MinaL1Adapter extends L1Adapter {
  readonly provider: "mina";
  readonly network: ZekoMNetwork;

  getAccountState(publicKey: string): Promise<string[]>;
  getOuterActions(input: {
    contractPublicKey: string;
    fromHeight: number;
    toHeight: number;
  }): Promise<MinaArchiveOuterAction[]>;
  getHistoricalZkappCommands(input: {
    fromHeight: number;
    toHeight: number;
  }): Promise<MinaArchiveZkappCommandPage>;
}

export type EthereumLog = {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
};

export interface EthereumL1Adapter extends L1Adapter {
  readonly provider: "ethereum";
  readonly network: ZekoENetwork;

  getSettlementLogs(input: {
    fromBlock: number;
    toBlock: number;
  }): Promise<EthereumLog[]>;
  getBridgeEventLogs(input: {
    fromBlock: number;
    toBlock: number;
  }): Promise<EthereumLog[]>;
}

export interface MinaBridgeDecoder {
  detectDepositSubmissions(command: MinaZkappCommand, block: L1BlockRef): L1BridgeEventFact[];
  detectWithdrawalFinalizations(command: MinaZkappCommand, block: L1BlockRef): L1BridgeEventFact[];
  detectDepositCancellations(command: MinaZkappCommand, block: L1BlockRef): L1BridgeEventFact[];
}

export interface EthereumBridgeDecoder {
  detectBridgeEvents(logs: EthereumLog[], block: L1BlockRef): L1BridgeEventFact[];
}
