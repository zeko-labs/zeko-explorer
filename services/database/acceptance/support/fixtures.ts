import { seedSqlWithSurrealKit } from "../lib/surreal-client.ts";

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

export function fixtureIds() {
  return ids;
}

export async function seedExplorerFixture(db: string): Promise<void> {
  const sql = `
CREATE ${ids.alice} SET public_key = "B62qAlice", balance = "900", nonce = 3, last_activity_height = 106, last_activity_at = d"2026-05-01T00:06:00Z", search_text = "B62qAlice account";
CREATE ${ids.bob} SET public_key = "B62qBob", balance = "600", nonce = 1, last_activity_height = 105, last_activity_at = d"2026-05-01T00:05:00Z", search_text = "B62qBob account";
CREATE ${ids.contract} SET public_key = "B62qContract", balance = "0", nonce = 0, zkapp_state = ["1","2","3","4","5","6","7","8"], action_state = ["as2","as1","0","0","0"], verification_key_hash = "vkey-1", search_text = "B62qContract zkapp contract";

CREATE ${ids.batch1} SET batch_height = 1, sort_batch_height = -1, target_ledger_hash = "ledger-106", first_tx_height = 101, last_tx_height = 106, transaction_count = 6, proof_status = "proved", settlement_status = "settling", l1_chain = "mina", l1_block_height = 5000, l1_block_hash = "l1-block-5000", l1_tx_hash = "l1-settle-1", l1_confirmations = 20, l1_finality_level = "settling", da_status = "attested", da_source = "proved", da_attestation_hash = "da-1", submitted_at = d"2026-05-01T00:06:30Z";

CREATE ${ids.tx1} SET hash = "tx-001", sequence_number = 1, type = "payment", status = "applied", sender = ${ids.alice}, receiver = ${ids.bob}, sender_public_key = "B62qAlice", receiver_public_key = "B62qBob", amount = "10", fee = "1", nonce = 0, memo = "alice pays bob", search_text = "tx-001 payment B62qAlice B62qBob alice pays bob", block_height = 101, tx_index = 0, sort_block_height = -101, sort_tx_index = 0, timestamp = d"2026-05-01T00:01:00Z", source_ledger_hash = "ledger-100", target_ledger_hash = "ledger-101", batch = ${ids.batch1};
CREATE ${ids.tx2} SET hash = "tx-002", sequence_number = 2, type = "zkapp_command", status = "applied", sender = ${ids.alice}, receiver = ${ids.contract}, sender_public_key = "B62qAlice", receiver_public_key = "B62qContract", amount = "0", fee = "1", nonce = 1, block_height = 102, tx_index = 0, sort_block_height = -102, sort_tx_index = 0, timestamp = d"2026-05-01T00:02:00Z", source_ledger_hash = "ledger-101", target_ledger_hash = "ledger-102", batch = ${ids.batch1};
CREATE ${ids.tx3} SET hash = "tx-003", sequence_number = 3, type = "payment", status = "applied", sender = ${ids.bob}, receiver = ${ids.alice}, sender_public_key = "B62qBob", receiver_public_key = "B62qAlice", amount = "20", fee = "1", nonce = 0, block_height = 103, tx_index = 0, sort_block_height = -103, sort_tx_index = 0, timestamp = d"2026-05-01T00:03:00Z", source_ledger_hash = "ledger-102", target_ledger_hash = "ledger-103", batch = ${ids.batch1};
CREATE ${ids.tx4} SET hash = "tx-004", sequence_number = 4, type = "zkapp_command", status = "applied", sender = ${ids.alice}, receiver = ${ids.contract}, sender_public_key = "B62qAlice", receiver_public_key = "B62qContract", amount = "0", fee = "1", nonce = 2, block_height = 104, tx_index = 0, sort_block_height = -104, sort_tx_index = 0, timestamp = d"2026-05-01T00:04:00Z", source_ledger_hash = "ledger-103", target_ledger_hash = "ledger-104", batch = ${ids.batch1};
CREATE ${ids.tx5} SET hash = "tx-005", sequence_number = 5, type = "payment", status = "applied", sender = ${ids.alice}, receiver = ${ids.bob}, sender_public_key = "B62qAlice", receiver_public_key = "B62qBob", amount = "30", fee = "1", nonce = 3, memo = "alice pays bob again", search_text = "tx-005 payment B62qAlice B62qBob alice pays bob again", block_height = 105, tx_index = 0, sort_block_height = -105, sort_tx_index = 0, timestamp = d"2026-05-01T00:05:00Z", source_ledger_hash = "ledger-104", target_ledger_hash = "ledger-105", batch = ${ids.batch1};
CREATE ${ids.tx6} SET hash = "tx-006", sequence_number = 6, type = "zkapp_command", status = "applied", sender = ${ids.bob}, receiver = ${ids.contract}, sender_public_key = "B62qBob", receiver_public_key = "B62qContract", amount = "0", fee = "1", nonce = 1, block_height = 106, tx_index = 0, sort_block_height = -106, sort_tx_index = 0, timestamp = d"2026-05-01T00:06:00Z", source_ledger_hash = "ledger-105", target_ledger_hash = "ledger-106", batch = ${ids.batch1};

RELATE ${ids.batch1}->batch_transaction->${ids.tx1} SET position = 0;
RELATE ${ids.batch1}->batch_transaction->${ids.tx2} SET position = 1;
RELATE ${ids.batch1}->batch_transaction->${ids.tx3} SET position = 2;
RELATE ${ids.batch1}->batch_transaction->${ids.tx4} SET position = 3;
RELATE ${ids.batch1}->batch_transaction->${ids.tx5} SET position = 4;
RELATE ${ids.batch1}->batch_transaction->${ids.tx6} SET position = 5;

RELATE ${ids.tx1}->account_transaction->${ids.alice} SET role = "sender", amount_delta = "-11", account_public_key = "B62qAlice", sort_block_height = -101, sort_tx_index = 0;
RELATE ${ids.tx1}->account_transaction->${ids.bob} SET role = "receiver", amount_delta = "10", account_public_key = "B62qBob", sort_block_height = -101, sort_tx_index = 0;
RELATE ${ids.tx2}->account_transaction->${ids.contract} SET role = "touched", account_public_key = "B62qContract", sort_block_height = -102, sort_tx_index = 0;
RELATE ${ids.tx2}->account_transaction->${ids.contract} SET role = "receiver", account_public_key = "B62qContract", sort_block_height = -102, sort_tx_index = 0;
RELATE ${ids.tx3}->account_transaction->${ids.alice} SET role = "receiver", account_public_key = "B62qAlice", sort_block_height = -103, sort_tx_index = 0;
RELATE ${ids.tx4}->account_transaction->${ids.contract} SET role = "receiver", account_public_key = "B62qContract", sort_block_height = -104, sort_tx_index = 0;
RELATE ${ids.tx5}->account_transaction->${ids.alice} SET role = "sender", account_public_key = "B62qAlice", sort_block_height = -105, sort_tx_index = 0;
RELATE ${ids.tx6}->account_transaction->${ids.contract} SET role = "receiver", account_public_key = "B62qContract", sort_block_height = -106, sort_tx_index = 0;
RELATE ${ids.tx6}->account_transaction->${ids.bob} SET role = "sender", account_public_key = "B62qBob", sort_block_height = -106, sort_tx_index = 0;

CREATE ${ids.activity1} SET account = ${ids.alice}, transaction = ${ids.tx5}, role = "sender", block_height = 105, tx_index = 0, activity_index = 0, sort_block_height = -105, sort_tx_index = 0, sort_activity_index = 0, timestamp = d"2026-05-01T00:05:00Z", balance_before = "931", balance_after = "900", nonce_before = 2, nonce_after = 3, target_ledger_hash = "ledger-105";
CREATE ${ids.activity2} SET account = ${ids.alice}, transaction = ${ids.tx4}, role = "touched", block_height = 104, tx_index = 0, activity_index = 0, sort_block_height = -104, sort_tx_index = 0, sort_activity_index = 0, timestamp = d"2026-05-01T00:04:00Z", balance_before = "932", balance_after = "931", nonce_before = 1, nonce_after = 2, zkapp_state_before = ["0","0","0","0","0","0","0","0"], zkapp_state_after = ["1","2","3","4","5","6","7","8"], target_ledger_hash = "ledger-104";
CREATE ${ids.activity3} SET account = ${ids.bob}, transaction = ${ids.tx6}, role = "sender", block_height = 106, tx_index = 0, activity_index = 0, sort_block_height = -106, sort_tx_index = 0, sort_activity_index = 0, timestamp = d"2026-05-01T00:06:00Z", balance_before = "601", balance_after = "600", nonce_before = 0, nonce_after = 1, target_ledger_hash = "ledger-106";
CREATE ${ids.activity4} SET account = ${ids.alice}, transaction = ${ids.tx3}, role = "receiver", block_height = 103, tx_index = 0, activity_index = 0, sort_block_height = -103, sort_tx_index = 0, sort_activity_index = 0, timestamp = d"2026-05-01T00:03:00Z", balance_before = "912", balance_after = "932", target_ledger_hash = "ledger-103";

CREATE ${ids.event1} SET transaction = ${ids.tx4}, transaction_hash = "tx-004", emitting_account = ${ids.contract}, event_index = 0, block_height = 104, tx_index = 0, sort_block_height = -104, sort_tx_index = 0, sort_event_index = 0, timestamp = d"2026-05-01T00:04:00Z", fields = ["11","12"], sequence_number = 4, target_ledger_hash = "ledger-104";
CREATE ${ids.event2} SET transaction = ${ids.tx6}, transaction_hash = "tx-006", emitting_account = ${ids.contract}, event_index = 0, block_height = 106, tx_index = 0, sort_block_height = -106, sort_tx_index = 0, sort_event_index = 0, timestamp = d"2026-05-01T00:06:00Z", fields = ["21","22"], sequence_number = 6, target_ledger_hash = "ledger-106";
CREATE ${ids.action1} SET transaction = ${ids.tx4}, transaction_hash = "tx-004", emitting_account = ${ids.contract}, action_index = 0, block_height = 104, tx_index = 0, sort_block_height = -104, sort_tx_index = 0, sort_action_index = 0, timestamp = d"2026-05-01T00:04:00Z", fields = ["31","32"], before_action_state = "as0", action_state = "as1", sequence_number = 4, target_ledger_hash = "ledger-104";
CREATE ${ids.action2} SET transaction = ${ids.tx6}, transaction_hash = "tx-006", emitting_account = ${ids.contract}, action_index = 0, block_height = 106, tx_index = 0, sort_block_height = -106, sort_tx_index = 0, sort_action_index = 0, timestamp = d"2026-05-01T00:06:00Z", fields = ["41","42"], before_action_state = "as1", action_state = "as2", sequence_number = 6, target_ledger_hash = "ledger-106";

CREATE ${ids.outerWitness} SET after_state = "outer-witness-1", before_state = "outer-0", kind = "witness", action_index = 1, block_height = 5000, block_state_hash = "l1-block-5000", timestamp = d"2026-05-01T00:07:00Z", network = "zeko-m-devnet", provider = "mina-archive", txn_hash = "l1-witness-1", fields = ["1","aux-shared"], slot_range_lower = 100, slot_range_upper = 120, aux = "aux-shared";
CREATE ${ids.outerCommit} SET after_state = "outer-commit-1", before_state = "outer-witness-1", kind = "commit", action_index = 2, block_height = 5001, block_state_hash = "l1-block-5001", timestamp = d"2026-05-01T00:08:00Z", network = "zeko-m-devnet", provider = "mina-archive", txn_hash = "l1-commit-1", fields = ["0","ledger-106"], slot_range_lower = 100, slot_range_upper = 130, inner_action_state = "inner-mint-1", inner_action_state_length = 1;
CREATE ${ids.innerMint} SET after_state = "inner-mint-1", before_state = "inner-0", action_index = 1, block_height = 106, timestamp = d"2026-05-01T00:06:00Z", txn_hash = "tx-006", transaction = ${ids.tx6}, fields = ["1","aux-shared"], aux = "aux-shared", target_ledger_hash = "ledger-106";

CREATE ${ids.bridge1} SET type = "deposit", status = "completed", aux = "aux-shared", aux_sequence = 0, sender = "B62qAlice", recipient = "B62qBob", amount = "100", search_text = "aux-shared completed deposit B62qAlice B62qBob", data_quality = "complete", source_network = "zeko-m-devnet", source_provider = "mina-archive", submit_tx_hash = "l1-submit-1", submit_block_height = 5000, sort_submit_block_height = -5000, submit_timestamp = d"2026-05-01T00:07:00Z", l1_witness_action_state = "outer-witness-1", l2_action_state = "inner-mint-1", commit_action_state = "outer-commit-1";
CREATE ${ids.bridge2} SET type = "deposit", status = "submitted", aux = "aux-shared", aux_sequence = 1, sender = "B62qAlice", recipient = "B62qBob", amount = "100", search_text = "aux-shared submitted deposit B62qAlice B62qBob", data_quality = "partial", data_quality_reasons = ["historical_bridge_events_unavailable"], source_network = "zeko-m-devnet", source_provider = "mina-archive", submit_tx_hash = "l1-submit-2", submit_block_height = 4999, sort_submit_block_height = -4999, submit_timestamp = d"2026-05-01T00:06:30Z";
RELATE ${ids.outerWitness}->l1_action_link->${ids.bridge1} SET role = "witness";
RELATE ${ids.outerCommit}->l1_action_link->${ids.bridge1} SET role = "commit";
RELATE ${ids.bridge1}->l2_action_link->${ids.innerMint} SET role = "mint";
RELATE ${ids.bridge1}->bridge_transaction_link->${ids.tx6} SET role = "l2_finalize";

CREATE ${ids.attestation1} SET batch = ${ids.batch1}, network = "zeko-m-devnet", attestation_hash = "da-1", status = "attested", provider = "ethermint", da_block_height = 700, confirmation_count = 12, observed_at = d"2026-05-01T00:09:00Z", raw_payload = { hash: "da-1" };

CREATE l1_watcher_cursor:tip SET source = "l1-watcher", network = "zeko-m-devnet", provider = "mina-daemon", adapter = "mina", cursor_kind = "tip", last_block_height = 5001, last_block_hash = "l1-block-5001", limitations = [];
CREATE l1_watcher_published:settlement1 SET msg_id = "settlement-outer-commit-1-settling", subject = "zeko.l1.settlements", network = "zeko-m-devnet", provider = "mina-daemon", source_hash = "outer-commit-1", source_height = 5001, payload_hash = "payload-hash-1";
CREATE sync_status:l1 SET source = "l1-watcher", status = "healthy", last_height = 5001, last_processed_at = d"2026-05-01T00:09:00Z", lag_seconds = 2;
`;
  await seedSqlWithSurrealKit(db, sql);
}

export async function seedCoreMigrationData(db: string): Promise<void> {
  await seedSqlWithSurrealKit(
    db,
    `
CREATE account:01J0000000000000000000ALIC SET public_key = "B62qAlice", balance = "100", nonce = 0;
CREATE bridge_operation:01J0000000000000000000BO01 SET type = "deposit", status = "submitted", aux = "aux-migration", aux_sequence = 0, sender = "B62qAlice", recipient = "B62qBob", amount = "10", submit_tx_hash = "l1-migration", submit_block_height = 10, submit_timestamp = d"2026-05-01T00:00:00Z";
`,
  );
}
