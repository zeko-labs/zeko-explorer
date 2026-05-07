export type L1Network = "zeko-m-devnet" | "zeko-m-alphanet" | "zeko-m-mainnet";

export type L1BlockRef = {
  height: number;
  stateHash: string;
  parentHash: string;
  slot: number;
  timestamp?: string;
};

export type L1AccountUpdate = {
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

export type L1ZkappCommand = {
  txHash: string;
  status: "applied" | "failed" | "unknown";
  memo?: string;
  feePayer: string;
  sequenceNumber?: number;
  accountUpdates: L1AccountUpdate[];
};

export type L1Block = L1BlockRef & {
  zkappCommands: L1ZkappCommand[];
};

export type ArchiveOuterAction = {
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

export type ArchiveAccountUpdatePage = {
  fromHeight: number;
  toHeight: number;
  commands: L1ZkappCommand[];
};

export interface L1Adapter {
  readonly chain: "mina" | "ethereum";
  readonly network: L1Network;

  getBestChain(depth: number): Promise<L1Block[]>;
  watchBestChainHints(onHint: () => Promise<void>): Promise<AbortController>;
  getAccountState(publicKey: string): Promise<string[]>;

  getOuterActions(input: {
    contractPublicKey: string;
    fromHeight: number;
    toHeight: number;
  }): Promise<ArchiveOuterAction[]>;

  getHistoricalZkappCommands(input: {
    fromHeight: number;
    toHeight: number;
  }): Promise<ArchiveAccountUpdatePage>;
}

export interface L1BridgeDecoder {
  detectDepositSubmissions(command: L1ZkappCommand, block: L1BlockRef): DecodedBridgeEvent[];
  detectWithdrawalFinalizations(command: L1ZkappCommand, block: L1BlockRef): DecodedBridgeEvent[];
  detectDepositCancellations(command: L1ZkappCommand, block: L1BlockRef): DecodedBridgeEvent[];
}

export type DecodedBridgeEvent = {
  bridgeEventId: string;
  type: "deposit_submitted" | "withdrawal_finalized" | "deposit_cancelled";
  txHash: string;
  userPk: string;
  userPkSource: "account_update" | "fee_payer";
  aux?: string;
  amount?: string;
  recipient?: string;
  operationIndex?: number;
  payload: Record<string, unknown>;
};
