-- Durable L1 watcher cursor lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_l1_cursor_unique.
-- Full plan: harness/reports/explain-current.md#l1-watcher-cursor.
-- EXPLAIN END
SELECT * FROM l1_watcher_cursor
WHERE source = $source
  AND network = $network
  AND provider = $provider
  AND cursor_kind = $cursor_kind
LIMIT 1;
