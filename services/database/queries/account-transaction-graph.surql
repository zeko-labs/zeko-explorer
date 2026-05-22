-- Bounded graph traversal for an account detail page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> RecordIdScan -> GraphEdgeScan -> CurrentValueSource; no explicit secondary index in plan.
-- Full plan: harness/reports/explain-current.md#account-transaction-graph.
-- EXPLAIN END
SELECT <-account_transaction<-transaction AS transactions
FROM $account;
