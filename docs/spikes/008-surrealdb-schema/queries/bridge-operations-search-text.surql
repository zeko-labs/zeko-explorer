-- Native SurrealDB full-text search over bridge operation search text.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> SortByKey -> FullTextScan; indexes idx_bo_search_text.
-- Full plan: harness/reports/explain-current.md#bridge-operations-search-text.
-- EXPLAIN END
SELECT *
FROM bridge_operation
WHERE search_text @1@ $term
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC
LIMIT $limit;
