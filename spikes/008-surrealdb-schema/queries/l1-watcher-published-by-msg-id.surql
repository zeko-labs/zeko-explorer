-- Published-message idempotency lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_l1_published_msg.
-- Full plan: harness/reports/explain-current.md#l1-watcher-published-by-msg-id.
-- EXPLAIN END
SELECT * FROM l1_watcher_published
WHERE msg_id = $msg_id
LIMIT 1;
