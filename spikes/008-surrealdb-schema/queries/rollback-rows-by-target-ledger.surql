-- Rows that must be considered when reverting an L2 ledger hash range.
RETURN {
  transactions: (SELECT * FROM transaction WHERE target_ledger_hash = $target_ledger_hash),
  account_activity: (SELECT * FROM account_activity WHERE target_ledger_hash = $target_ledger_hash),
  inner_actions: (SELECT * FROM inner_action WHERE target_ledger_hash = $target_ledger_hash),
  zkapp_events: (SELECT * FROM zkapp_event WHERE target_ledger_hash = $target_ledger_hash),
  zkapp_actions: (SELECT * FROM zkapp_action WHERE target_ledger_hash = $target_ledger_hash)
};
