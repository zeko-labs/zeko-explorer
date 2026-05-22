-- Natural-key account lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_account_public_key.
-- Full plan: harness/reports/explain-current.md#account-by-public-key.
-- EXPLAIN END
SELECT * FROM account
WHERE public_key = $public_key
LIMIT 1;
