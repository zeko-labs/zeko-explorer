-- GraphQL transactionFeed subscription. Resolver pairs this with
-- transaction-feed-first-page using a high-water cursor from the initial page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.
-- Initial pages use transaction-feed-first-page/transaction-feed and idx_tx_connection_order.
-- EXPLAIN END
LIVE SELECT * FROM transaction
WHERE status = "applied";
