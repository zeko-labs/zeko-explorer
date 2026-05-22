-- Status page subscription.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.
-- Finite freshness lookups use sync-status-by-source and idx_sync_status_source.
-- EXPLAIN END
LIVE SELECT * FROM sync_status;
