-- DA observations for a batch detail page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> SortByKey -> IndexScan; indexes idx_da_attestation_batch.
-- Full plan: harness/reports/explain-current.md#da-attestations-by-batch.
-- EXPLAIN END
SELECT * FROM da_attestation
WHERE batch = $batch
ORDER BY observed_at DESC, id ASC
LIMIT $limit;
