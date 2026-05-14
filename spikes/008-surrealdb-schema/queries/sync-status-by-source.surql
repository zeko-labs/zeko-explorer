-- Source freshness lookup for API _meta.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_sync_status_source.
-- Full plan: harness/reports/explain-current.md#sync-status-by-source.
-- EXPLAIN END
SELECT * FROM sync_status
WHERE source = $source
LIMIT 1;
