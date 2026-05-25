import { seedSurqlWithSurrealKit } from "../lib/surreal-client";

type RawSurql = {
  readonly kind: "raw";
  readonly value: string;
};

type DateTimeSurql = {
  readonly kind: "datetime";
  readonly value: string;
};

type SurqlValue =
  | null
  | boolean
  | number
  | string
  | RawSurql
  | DateTimeSurql
  | readonly SurqlValue[]
  | { readonly [key: string]: SurqlValue };

type Fields = Readonly<Record<string, SurqlValue>>;

const ids = {
  alice: "account:01J0000000000000000000ALIC",
  bob: "account:01J0000000000000000000BOB0",
  contract: "account:01J0000000000000000000ZKAP",
  batch1: "batch:01J0000000000000000000BAT1",
  tx1: 'transaction:[-101, 0, "tx-001"]',
  tx2: 'transaction:[-102, 0, "tx-002"]',
  tx3: 'transaction:[-103, 0, "tx-003"]',
  tx4: 'transaction:[-104, 0, "tx-004"]',
  tx5: 'transaction:[-105, 0, "tx-005"]',
  tx6: 'transaction:[-106, 0, "tx-006"]',
  activity1: "account_activity:01J0000000000000000000AC01",
  activity2: "account_activity:01J0000000000000000000AC02",
  activity3: "account_activity:01J0000000000000000000AC03",
  activity4: "account_activity:01J0000000000000000000AC04",
  event1: "zkapp_event:01J0000000000000000000EV01",
  event2: "zkapp_event:01J0000000000000000000EV02",
  action1: "zkapp_action:01J0000000000000000000ZA01",
  action2: "zkapp_action:01J0000000000000000000ZA02",
  outerWitness: "outer_action:01J0000000000000000000OA01",
  outerCommit: "outer_action:01J0000000000000000000OA02",
  innerMint: "inner_action:01J0000000000000000000IA01",
  bridge1: "bridge_operation:01J0000000000000000000BO01",
  bridge2: "bridge_operation:01J0000000000000000000BO02",
  attestation1: "da_attestation:01J0000000000000000000DA01",
};

const accountFixtures: Array<{ readonly id: string; readonly fields: Fields }> = [
  {
    id: ids.alice,
    fields: {
      public_key: "B62qAlice",
      balance: "900",
      nonce: 3,
      last_activity_height: 106,
      last_activity_at: datetime("2026-05-01T00:06:00Z"),
      search_text: "B62qAlice account",
    },
  },
  {
    id: ids.bob,
    fields: {
      public_key: "B62qBob",
      balance: "600",
      nonce: 1,
      last_activity_height: 105,
      last_activity_at: datetime("2026-05-01T00:05:00Z"),
      search_text: "B62qBob account",
    },
  },
  {
    id: ids.contract,
    fields: {
      public_key: "B62qContract",
      balance: "0",
      nonce: 0,
      zkapp_state: ["1", "2", "3", "4", "5", "6", "7", "8"],
      action_state: ["as2", "as1", "0", "0", "0"],
      verification_key_hash: "vkey-1",
      search_text: "B62qContract zkapp contract",
    },
  },
];

const transactionFixtures = [
  transaction(ids.tx1, "tx-001", 1, "payment", ids.alice, ids.bob, "B62qAlice", "B62qBob", 101, {
    amount: "10",
    fee: "1",
    nonce: 0,
    memo: "alice pays bob",
    search_text: "tx-001 payment B62qAlice B62qBob alice pays bob",
    source_ledger_hash: "ledger-100",
    target_ledger_hash: "ledger-101",
  }),
  transaction(
    ids.tx2,
    "tx-002",
    2,
    "zkapp_command",
    ids.alice,
    ids.contract,
    "B62qAlice",
    "B62qContract",
    102,
    {
      amount: "0",
      fee: "1",
      nonce: 1,
      source_ledger_hash: "ledger-101",
      target_ledger_hash: "ledger-102",
    },
  ),
  transaction(ids.tx3, "tx-003", 3, "payment", ids.bob, ids.alice, "B62qBob", "B62qAlice", 103, {
    amount: "20",
    fee: "1",
    nonce: 0,
    source_ledger_hash: "ledger-102",
    target_ledger_hash: "ledger-103",
  }),
  transaction(
    ids.tx4,
    "tx-004",
    4,
    "zkapp_command",
    ids.alice,
    ids.contract,
    "B62qAlice",
    "B62qContract",
    104,
    {
      amount: "0",
      fee: "1",
      nonce: 2,
      source_ledger_hash: "ledger-103",
      target_ledger_hash: "ledger-104",
    },
  ),
  transaction(ids.tx5, "tx-005", 5, "payment", ids.alice, ids.bob, "B62qAlice", "B62qBob", 105, {
    amount: "30",
    fee: "1",
    nonce: 3,
    memo: "alice pays bob again",
    search_text: "tx-005 payment B62qAlice B62qBob alice pays bob again",
    source_ledger_hash: "ledger-104",
    target_ledger_hash: "ledger-105",
  }),
  transaction(
    ids.tx6,
    "tx-006",
    6,
    "zkapp_command",
    ids.bob,
    ids.contract,
    "B62qBob",
    "B62qContract",
    106,
    {
      amount: "0",
      fee: "1",
      nonce: 1,
      source_ledger_hash: "ledger-105",
      target_ledger_hash: "ledger-106",
    },
  ),
] as const;

const accountTransactionFixtures = [
  accountTransaction(ids.tx1, ids.alice, "sender", "B62qAlice", -101, { amount_delta: "-11" }),
  accountTransaction(ids.tx1, ids.bob, "receiver", "B62qBob", -101, { amount_delta: "10" }),
  accountTransaction(ids.tx2, ids.contract, "touched", "B62qContract", -102),
  accountTransaction(ids.tx2, ids.contract, "receiver", "B62qContract", -102),
  accountTransaction(ids.tx3, ids.alice, "receiver", "B62qAlice", -103),
  accountTransaction(ids.tx4, ids.contract, "receiver", "B62qContract", -104),
  accountTransaction(ids.tx5, ids.alice, "sender", "B62qAlice", -105),
  accountTransaction(ids.tx6, ids.contract, "receiver", "B62qContract", -106),
  accountTransaction(ids.tx6, ids.bob, "sender", "B62qBob", -106),
] as const;

const accountActivities = [
  activity(ids.activity1, ids.alice, ids.tx5, "sender", 105, {
    balance_before: "931",
    balance_after: "900",
    nonce_before: 2,
    nonce_after: 3,
  }),
  activity(ids.activity2, ids.alice, ids.tx4, "touched", 104, {
    balance_before: "932",
    balance_after: "931",
    nonce_before: 1,
    nonce_after: 2,
    zkapp_state_before: ["0", "0", "0", "0", "0", "0", "0", "0"],
    zkapp_state_after: ["1", "2", "3", "4", "5", "6", "7", "8"],
  }),
  activity(ids.activity3, ids.bob, ids.tx6, "sender", 106, {
    balance_before: "601",
    balance_after: "600",
    nonce_before: 0,
    nonce_after: 1,
  }),
  activity(ids.activity4, ids.alice, ids.tx3, "receiver", 103, {
    balance_before: "912",
    balance_after: "932",
  }),
] as const;

export function fixtureIds() {
  return ids;
}

export async function seedExplorerFixture(db: string): Promise<void> {
  const statements = [
    ...accountFixtures.map((fixture) => create(fixture.id, fixture.fields)),
    create(ids.batch1, {
      batch_height: 1,
      sort_batch_height: -1,
      target_ledger_hash: "ledger-106",
      first_tx_height: 101,
      last_tx_height: 106,
      transaction_count: 6,
      proof_status: "proved",
      settlement_status: "settling",
      l1_chain: "mina",
      l1_block_height: 5000,
      l1_block_hash: "l1-block-5000",
      l1_tx_hash: "l1-settle-1",
      l1_confirmations: 20,
      l1_finality_level: "settling",
      da_status: "attested",
      da_source: "proved",
      da_attestation_hash: "da-1",
      submitted_at: datetime("2026-05-01T00:06:30Z"),
    }),
    ...transactionFixtures.map((fixture) => create(fixture.id, fixture.fields)),
    ...transactionFixtures.map((fixture, position) =>
      relate(ids.batch1, "batch_transaction", fixture.id, { position }),
    ),
    ...accountTransactionFixtures.map((fixture) =>
      relate(fixture.transaction, "account_transaction", fixture.account, fixture.fields),
    ),
    ...accountActivities.map((fixture) => create(fixture.id, fixture.fields)),
    createZkappEvent(ids.event1, ids.tx4, "tx-004", 104, ["11", "12"]),
    createZkappEvent(ids.event2, ids.tx6, "tx-006", 106, ["21", "22"]),
    createZkappAction(ids.action1, ids.tx4, "tx-004", 104, ["31", "32"], "as0", "as1"),
    createZkappAction(ids.action2, ids.tx6, "tx-006", 106, ["41", "42"], "as1", "as2"),
    create(ids.outerWitness, {
      after_state: "outer-witness-1",
      before_state: "outer-0",
      kind: "witness",
      action_index: 1,
      block_height: 5000,
      block_state_hash: "l1-block-5000",
      timestamp: datetime("2026-05-01T00:07:00Z"),
      network: "zeko-m-devnet",
      provider: "mina-archive",
      txn_hash: "l1-witness-1",
      fields: ["1", "aux-shared"],
      slot_range_lower: 100,
      slot_range_upper: 120,
      aux: "aux-shared",
    }),
    create(ids.outerCommit, {
      after_state: "outer-commit-1",
      before_state: "outer-witness-1",
      kind: "commit",
      action_index: 2,
      block_height: 5001,
      block_state_hash: "l1-block-5001",
      timestamp: datetime("2026-05-01T00:08:00Z"),
      network: "zeko-m-devnet",
      provider: "mina-archive",
      txn_hash: "l1-commit-1",
      fields: ["0", "ledger-106"],
      slot_range_lower: 100,
      slot_range_upper: 130,
      inner_action_state: "inner-mint-1",
      inner_action_state_length: 1,
    }),
    create(ids.innerMint, {
      after_state: "inner-mint-1",
      before_state: "inner-0",
      action_index: 1,
      block_height: 106,
      timestamp: datetime("2026-05-01T00:06:00Z"),
      txn_hash: "tx-006",
      transaction: raw(ids.tx6),
      fields: ["1", "aux-shared"],
      aux: "aux-shared",
      target_ledger_hash: "ledger-106",
    }),
    createBridgeOperation(ids.bridge1, "completed", 0, {
      data_quality: "complete",
      submit_tx_hash: "l1-submit-1",
      submit_block_height: 5000,
      sort_submit_block_height: -5000,
      submit_timestamp: datetime("2026-05-01T00:07:00Z"),
      l1_witness_action_state: "outer-witness-1",
      l2_action_state: "inner-mint-1",
      commit_action_state: "outer-commit-1",
    }),
    createBridgeOperation(ids.bridge2, "submitted", 1, {
      data_quality: "partial",
      data_quality_reasons: ["historical_bridge_events_unavailable"],
      submit_tx_hash: "l1-submit-2",
      submit_block_height: 4999,
      sort_submit_block_height: -4999,
      submit_timestamp: datetime("2026-05-01T00:06:30Z"),
    }),
    relate(ids.outerWitness, "l1_action_link", ids.bridge1, { role: "witness" }),
    relate(ids.outerCommit, "l1_action_link", ids.bridge1, { role: "commit" }),
    relate(ids.bridge1, "l2_action_link", ids.innerMint, { role: "mint" }),
    relate(ids.bridge1, "bridge_transaction_link", ids.tx6, { role: "l2_finalize" }),
    create(ids.attestation1, {
      batch: raw(ids.batch1),
      network: "zeko-m-devnet",
      attestation_hash: "da-1",
      status: "attested",
      provider: "ethermint",
      da_block_height: 700,
      confirmation_count: 12,
      observed_at: datetime("2026-05-01T00:09:00Z"),
      raw_payload: { hash: "da-1" },
    }),
    create("l1_watcher_cursor:tip", {
      source: "l1-watcher",
      network: "zeko-m-devnet",
      provider: "mina-daemon",
      adapter: "mina",
      cursor_kind: "tip",
      last_block_height: 5001,
      last_block_hash: "l1-block-5001",
      limitations: [],
    }),
    create("l1_watcher_published:settlement1", {
      msg_id: "settlement-outer-commit-1-settling",
      subject: "zeko.l1.settlements",
      network: "zeko-m-devnet",
      provider: "mina-daemon",
      source_hash: "outer-commit-1",
      source_height: 5001,
      payload_hash: "payload-hash-1",
    }),
    create("sync_status:l1", {
      source: "l1-watcher",
      status: "healthy",
      last_height: 5001,
      last_processed_at: datetime("2026-05-01T00:09:00Z"),
      lag_seconds: 2,
    }),
  ];

  await seedSurqlWithSurrealKit(db, `${statements.join("\n")}\n`);
}

function transaction(
  id: string,
  hash: string,
  sequenceNumber: number,
  type: string,
  sender: string,
  receiver: string,
  senderPublicKey: string,
  receiverPublicKey: string,
  blockHeight: number,
  overrides: Fields,
) {
  return {
    id,
    fields: {
      hash,
      sequence_number: sequenceNumber,
      type,
      status: "applied",
      sender: raw(sender),
      receiver: raw(receiver),
      sender_public_key: senderPublicKey,
      receiver_public_key: receiverPublicKey,
      block_height: blockHeight,
      tx_index: 0,
      sort_block_height: -blockHeight,
      sort_tx_index: 0,
      timestamp: datetime(`2026-05-01T00:${String(blockHeight - 100).padStart(2, "0")}:00Z`),
      batch: raw(ids.batch1),
      ...overrides,
    },
  };
}

function accountTransaction(
  transactionId: string,
  account: string,
  role: string,
  accountPublicKey: string,
  sortBlockHeight: number,
  overrides: Fields = {},
) {
  return {
    transaction: transactionId,
    account,
    fields: {
      role,
      account_public_key: accountPublicKey,
      sort_block_height: sortBlockHeight,
      sort_tx_index: 0,
      ...overrides,
    },
  };
}

function activity(
  id: string,
  account: string,
  transactionId: string,
  role: string,
  blockHeight: number,
  overrides: Fields,
) {
  return {
    id,
    fields: {
      account: raw(account),
      transaction: raw(transactionId),
      role,
      block_height: blockHeight,
      tx_index: 0,
      activity_index: 0,
      sort_block_height: -blockHeight,
      sort_tx_index: 0,
      sort_activity_index: 0,
      timestamp: datetime(`2026-05-01T00:${String(blockHeight - 100).padStart(2, "0")}:00Z`),
      target_ledger_hash: `ledger-${blockHeight}`,
      ...overrides,
    },
  };
}

function createZkappEvent(
  id: string,
  transactionId: string,
  transactionHash: string,
  blockHeight: number,
  fields: readonly string[],
): string {
  return create(id, {
    transaction: raw(transactionId),
    transaction_hash: transactionHash,
    emitting_account: raw(ids.contract),
    event_index: 0,
    block_height: blockHeight,
    tx_index: 0,
    sort_block_height: -blockHeight,
    sort_tx_index: 0,
    sort_event_index: 0,
    timestamp: datetime(`2026-05-01T00:${String(blockHeight - 100).padStart(2, "0")}:00Z`),
    fields,
    sequence_number: blockHeight - 100,
    target_ledger_hash: `ledger-${blockHeight}`,
  });
}

function createZkappAction(
  id: string,
  transactionId: string,
  transactionHash: string,
  blockHeight: number,
  fields: readonly string[],
  beforeActionState: string,
  actionState: string,
): string {
  return create(id, {
    transaction: raw(transactionId),
    transaction_hash: transactionHash,
    emitting_account: raw(ids.contract),
    action_index: 0,
    block_height: blockHeight,
    tx_index: 0,
    sort_block_height: -blockHeight,
    sort_tx_index: 0,
    sort_action_index: 0,
    timestamp: datetime(`2026-05-01T00:${String(blockHeight - 100).padStart(2, "0")}:00Z`),
    fields,
    before_action_state: beforeActionState,
    action_state: actionState,
    sequence_number: blockHeight - 100,
    target_ledger_hash: `ledger-${blockHeight}`,
  });
}

function createBridgeOperation(id: string, status: string, auxSequence: number, overrides: Fields) {
  return create(id, {
    type: "deposit",
    status,
    aux: "aux-shared",
    aux_sequence: auxSequence,
    sender: "B62qAlice",
    recipient: "B62qBob",
    amount: "100",
    search_text: `aux-shared ${status} deposit B62qAlice B62qBob`,
    source_network: "zeko-m-devnet",
    source_provider: "mina-archive",
    ...overrides,
  });
}

function create(id: string, fields: Fields): string {
  return `CREATE ${id} SET ${assignments(fields)};`;
}

function relate(from: string, edge: string, to: string, fields: Fields): string {
  return `RELATE ${from}->${edge}->${to} SET ${assignments(fields)};`;
}

function assignments(fields: Fields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} = ${literal(value)}`)
    .join(", ");
}

function literal(value: SurqlValue): string {
  if (isRaw(value)) return value.value;
  if (isDateTime(value)) return `d"${value.value}"`;
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, child]) => `${key}: ${literal(child)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function raw(value: string): RawSurql {
  return { kind: "raw", value };
}

function datetime(value: string): DateTimeSurql {
  return { kind: "datetime", value };
}

function isRaw(value: SurqlValue): value is RawSurql {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "raw"
  );
}

function isDateTime(value: SurqlValue): value is DateTimeSurql {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "datetime"
  );
}
