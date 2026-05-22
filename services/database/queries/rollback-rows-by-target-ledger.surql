-- Rows that must be considered when reverting an L2 ledger hash range.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): compound RETURN query; component rollback plans are documented in harness/reports/explain-current.md.
-- Rollback lookups use idx_tx_ledger plus child target-ledger indexes and account_transaction.in.
-- EXPLAIN END
RETURN {
  transactions: (SELECT * FROM transaction WHERE target_ledger_hash = $target_ledger_hash),
  account_activity: (SELECT * FROM account_activity WHERE target_ledger_hash = $target_ledger_hash),
  account_transactions: (SELECT * FROM account_transaction WHERE in IN (SELECT VALUE id FROM transaction WHERE target_ledger_hash = $target_ledger_hash)),
  inner_actions: (SELECT * FROM inner_action WHERE target_ledger_hash = $target_ledger_hash),
  zkapp_events: (SELECT * FROM zkapp_event WHERE target_ledger_hash = $target_ledger_hash),
  zkapp_actions: (SELECT * FROM zkapp_action WHERE target_ledger_hash = $target_ledger_hash)
};
