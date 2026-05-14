-- GraphQL accountTransactionFeed subscription.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.
-- Initial pages use account-transaction-feed-first-page/account-transaction-feed, which document the indexed relation-table plan.
-- EXPLAIN END
LIVE SELECT * FROM account_transaction
WHERE account_public_key = $public_key;
