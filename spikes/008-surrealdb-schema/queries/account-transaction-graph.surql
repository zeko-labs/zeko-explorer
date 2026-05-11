-- Bounded graph traversal for an account detail page.
SELECT <-account_transaction<-transaction AS transactions
FROM $account;
