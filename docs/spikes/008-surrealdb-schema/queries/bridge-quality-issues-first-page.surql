-- Open bridge evidence issues derived from canonical bridge operations.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> IndexScan; indexes idx_bo_data_quality.
-- Full plan: harness/reports/explain-current.md#bridge-quality-issues-first-page.
-- EXPLAIN END
SELECT
  id AS bridge_operation,
  aux,
  aux_sequence,
  type,
  status,
  data_quality,
  data_quality_reasons[0] AS reason,
  data_quality_reasons AS reasons,
  sender,
  recipient,
  submit_block_height,
  sort_submit_block_height,
  submit_timestamp
FROM bridge_operation
WHERE data_quality = $data_quality
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
