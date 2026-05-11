-- Batch detail with bounded containment traversal.
SELECT *, ->batch_transaction->transaction AS transactions
FROM $batch;
