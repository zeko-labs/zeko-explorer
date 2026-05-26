import type {
  DaSignatureEvent,
  L1BridgeEvent,
  L1OuterActionEvent,
  L1RollbackEvent,
  L1SettlementEvent,
  L2FinalityEvent,
  L2TransactionEvent,
} from "@zeko/nats";

export type DaSource = "proved" | "da-direct" | "settlement";
export type DaStatus = "attested";
export type TransactionStatus = "applied" | "reverted";
export type BridgeOperationStatus =
  | "submitted"
  | "l1_witnessed"
  | "l2_witnessed"
  | "committed"
  | "delay_passed"
  | "completed"
  | "timed_out"
  | "cancelled"
  | "rolled_back";

export type L2AccountChangeInput = {
  index: number;
  account: {
    public_key: string;
    balance: string;
    nonce: number;
    delegate?: string;
    token_id?: string;
    zkapp_state?: string[];
    action_state?: string[];
    verification_key_hash?: string;
    zkapp_uri?: string;
    permissions?: Record<string, string>;
    timing?: Record<string, string>;
  };
};

export type ObservedZkappActionInput = {
  fields: string[];
  before_action_state: string;
  action_state: string;
};

export type L2AccountUpdateInput = {
  public_key?: string;
  token_id?: string;
  account?: { public_key?: string; token_id?: string };
  body?: {
    public_key?: string;
    token_id?: string;
    events?: unknown[];
    actions?: unknown[];
  };
  events?: unknown[];
  actions?: unknown[];
};

export type L2CommandInput = {
  type: "signed_command" | "zkapp_command";
  hash: string;
  sender?: string;
  receiver?: string;
  amount?: string;
  fee?: string;
  nonce?: number;
  memo?: string;
  account_updates?: L2AccountUpdateInput[];
};

export type L2TransactionInput = {
  source_ledger_hash: string;
  target_ledger_hash: string;
  timestamp: string | number;
  acc_set: string;
  command: L2CommandInput | null;
  changed_accounts: L2AccountChangeInput[];
  genesis?: boolean;
};

export type L2FinalityInput = {
  ledger_hash: string;
  level: "proved" | "committed";
  source_ledger_hash: string;
  timestamp: string;
};

export type L1SettlementInput = {
  provider: "mina" | "ethereum";
  settlementId: string;
  eventType: "detected" | "finalized";
  finalityLevel: "settling" | "finalized";
  txHash: string;
  observedAt: string;
  block: {
    height: number;
    hash: string;
    slot?: number;
    timestamp: string;
    confirmationDepth: number;
  };
  commit: {
    ledgerHash: string;
    innerActionState: string;
    innerActionStateLength: number;
    synchronizedOuterActionState: string;
    synchronizedOuterActionStateLength: number;
    slotRange: { lower: number; upper: number };
    rawFields: string[];
  };
};

export type L1RollbackInput = {
  rollbackId: string;
  detectedAt: string;
  affected: {
    settlementIds: string[];
    outerActionIds: string[];
    bridgeEventIds: string[];
  };
};

export type L1OuterActionInput = L1OuterActionEvent;
export type L1BridgeEventInput = L1BridgeEvent;

export type ZekoMultisigSignatureInput = {
  implementation: "zeko-multisig-v1";
  ledgerHash: string;
  accSet: string;
  publicKey: string;
  signature: string;
  instanceId: string;
  signedAt: string;
};

export type CelestiaSignatureInput = {
  implementation: "celestia-v1";
  ledgerHash: string;
  publishedAt: string;
  celestia: {
    height: number;
    namespace: string;
    commitment: string;
    inclusionProof: string;
  };
};

export type DaSignatureInput = ZekoMultisigSignatureInput | CelestiaSignatureInput;

export type AccountRow = {
  id: string;
  public_key: string;
  token_id: string;
  balance: string;
  nonce: number;
  delegate?: string;
  zkapp_state?: string[];
  action_state?: string[];
  verification_key_hash?: string;
  zkapp_uri?: string;
  first_seen_height?: number;
  last_activity_height?: number;
  last_activity_at?: string;
  search_text?: string;
};

export type TransactionRow = {
  id: string;
  hash: string;
  sequence_number: number;
  type: "payment" | "zkapp_command" | "fee_transfer" | "genesis" | "sync";
  status: TransactionStatus;
  sender_public_key?: string;
  receiver_public_key?: string;
  fee_payer_public_key?: string;
  amount?: string;
  fee?: string;
  nonce?: number;
  memo?: string;
  block_height: number;
  tx_index: number;
  sort_block_height: number;
  sort_tx_index: number;
  timestamp: string;
  source_ledger_hash: string;
  target_ledger_hash: string;
  batch?: string;
  rollback_reason?: string;
  raw_command?: unknown;
};

export type AccountActivityRow = {
  id: string;
  account: string;
  account_public_key: string;
  transaction: string;
  role: "sender" | "receiver" | "fee_payer" | "touched" | "delegate" | "rollback";
  block_height: number;
  tx_index: number;
  activity_index: number;
  sort_block_height: number;
  sort_tx_index: number;
  sort_activity_index: number;
  timestamp: string;
  balance_before?: string;
  balance_after?: string;
  nonce_before?: number;
  nonce_after?: number;
  delegate_before?: string;
  delegate_after?: string;
  zkapp_state_before?: string[];
  zkapp_state_after?: string[];
  action_state_before?: string[];
  action_state_after?: string[];
  verification_key_hash_before?: string;
  verification_key_hash_after?: string;
  zkapp_uri_before?: string;
  zkapp_uri_after?: string;
  target_ledger_hash: string;
};

export type ZkappEventRow = {
  id: string;
  transaction: string;
  transaction_hash: string;
  emitting_account: string;
  emitting_account_public_key: string;
  event_index: number;
  block_height: number;
  tx_index: number;
  sort_block_height: number;
  sort_tx_index: number;
  sort_event_index: number;
  timestamp: string;
  fields: string[];
  sequence_number: number;
  target_ledger_hash: string;
};

export type ZkappActionRow = {
  id: string;
  transaction: string;
  transaction_hash: string;
  emitting_account: string;
  emitting_account_public_key: string;
  action_index: number;
  block_height: number;
  tx_index: number;
  sort_block_height: number;
  sort_tx_index: number;
  sort_action_index: number;
  timestamp: string;
  fields: string[];
  before_action_state: string;
  action_state: string;
  sequence_number: number;
  target_ledger_hash: string;
};

export type OuterActionRow = {
  id: string;
  outer_action_id: string;
  after_state: string;
  before_state?: string;
  kind: "commit" | "witness";
  action_index: number;
  block_height: number;
  block_state_hash: string;
  timestamp: string;
  network: string;
  provider: string;
  global_slot?: number;
  distance_from_max_block_height?: number;
  txn_hash: string;
  fields: string[];
  slot_range_lower: number;
  slot_range_upper: number;
  marked_as_canonical_at?: string;
  ledger?: string;
  inner_action_state?: string;
  inner_action_state_length?: number;
  synchronized_outer_action_state?: string;
  synchronized_outer_action_state_length?: number;
  aux?: string;
};

export type InnerActionRow = {
  id: string;
  after_state: string;
  before_state?: string;
  action_index: number;
  block_height: number;
  timestamp: string;
  txn_hash: string;
  transaction?: string;
  fields: string[];
  aux: string;
  marked_as_canonical_at?: string;
  target_ledger_hash: string;
};

export type BridgeOperationRow = {
  id: string;
  type: "deposit" | "withdrawal";
  status: BridgeOperationStatus;
  aux: string;
  aux_sequence: number;
  sender: string;
  recipient: string;
  amount: string;
  search_text?: string;
  data_quality: "complete" | "partial" | "inferred" | "unrecoverable";
  data_quality_reasons?: string[];
  source_network?: string;
  source_provider?: string;
  submit_tx_hash?: string;
  submit_block_height?: number;
  sort_submit_block_height?: number;
  submit_timestamp?: string;
  timeout_slot?: number;
  holder_account_l1?: string;
  l1_witness_action_state?: string;
  l1_witness_tx_hash?: string;
  l1_witness_block_height?: number;
  l1_witness_timestamp?: string;
  l1_slot_range_lower?: number;
  l1_slot_range_upper?: number;
  l2_action_state?: string;
  l2_tx_hash?: string;
  l2_block_height?: number;
  l2_timestamp?: string;
  commit_action_state?: string;
  cancel_tx_hash?: string;
  rollback_reason?: string;
};

export type L1ActionLinkRow = {
  id: string;
  in: string;
  out: string;
  role: "witness" | "commit";
};

export type L2ActionLinkRow = {
  id: string;
  in: string;
  out: string;
  role: "mint" | "burn";
};

export type BridgeTransactionLinkRow = {
  id: string;
  in: string;
  out: string;
  role: "submit" | "l1_witness" | "l2_finalize" | "cancel" | "rollback";
};

export type BridgeEventEffectRow = {
  bridge_event_id: string;
  operation: string;
  type: L1BridgeEvent["type"];
  previous?: BridgeOperationRow;
};

export type DaSignerRow = {
  publicKey: string;
  signedAt: string;
  instanceId: string;
};

export type BatchRow = {
  id: string;
  target_ledger_hash: string;
  settlement_id?: string;
  batch_height: number;
  sort_batch_height: number;
  first_tx_height: number;
  last_tx_height: number;
  transaction_count: number;
  proof_status: "pending" | "proved" | "failed";
  settlement_status: "pending" | "settling" | "finalized" | "rolled_back";
  proved_at?: string;
  l1_chain?: string;
  l1_block_height?: number;
  l1_block_hash?: string;
  l1_tx_hash?: string;
  l1_confirmations?: number;
  l1_finality_level?: "detected" | "confirming" | "settling" | "finalized" | "canonical";
  da_status?: DaStatus;
  da_source?: DaSource;
  da_attested_at?: string;
  da_implementation?: string;
  da_quorum_threshold?: number;
  da_signers?: DaSignerRow[];
  submitted_at?: string;
  settled_at?: string;
};

export type PendingDaAttestationRow = {
  ledger_hash: string;
  source: DaSource;
  attested_at?: string;
  received_at: string;
  implementation?: string;
  quorum_threshold?: number;
  signers?: DaSignerRow[];
};

export type PendingFinalityRow = {
  ledger_hash: string;
  proved_at: string;
};

export type SyncStatusRow = {
  source: string;
  status: "healthy" | "degraded" | "paused" | "failed";
  last_sequence?: number;
  last_hash?: string;
  last_height?: number;
  last_processed_at?: string;
  lag_seconds?: number;
  error?: string;
};

export type ConsumeEnvelope =
  | { subject: "zeko.l2.transactions"; payload: L2TransactionEvent }
  | { subject: "zeko.l2.finality"; payload: L2FinalityEvent }
  | { subject: "zeko.l1.settlements"; payload: L1SettlementEvent }
  | { subject: "zeko.l1.rollbacks"; payload: L1RollbackEvent }
  | { subject: "zeko.l1.outer-actions"; payload: L1OuterActionEvent }
  | { subject: "zeko.l1.bridge-events"; payload: L1BridgeEvent }
  | { subject: "zeko.da.signatures"; payload: DaSignatureEvent };

type IsEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type AssertTrue<Value extends true> = Value;
type ConsumePayload<Subject extends ConsumeEnvelope["subject"]> = Extract<
  ConsumeEnvelope,
  { subject: Subject }
>["payload"];

type _ConsumePayloadsMatchNatsContracts = [
  AssertTrue<IsEqual<ConsumePayload<"zeko.l2.transactions">, L2TransactionEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.l2.finality">, L2FinalityEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.l1.settlements">, L1SettlementEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.l1.rollbacks">, L1RollbackEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.l1.outer-actions">, L1OuterActionEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.l1.bridge-events">, L1BridgeEvent>>,
  AssertTrue<IsEqual<ConsumePayload<"zeko.da.signatures">, DaSignatureEvent>>,
];
