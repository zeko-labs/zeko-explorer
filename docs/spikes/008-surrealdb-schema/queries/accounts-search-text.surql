-- Native SurrealDB full-text search over account search text.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> Limit -> FullTextScan; indexes idx_account_search_text.
-- Full plan: harness/reports/explain-current.md#accounts-search-text.
-- EXPLAIN END
SELECT *, search::score(1) AS score
FROM account
WHERE search_text @1@ $term
LIMIT $limit;
