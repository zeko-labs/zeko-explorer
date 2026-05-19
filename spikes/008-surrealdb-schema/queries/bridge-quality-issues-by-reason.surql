-- Open bridge evidence issues for the primary missing/inferred source reason,
-- derived from canonical bridge operations.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> IndexScan; indexes idx_bo_quality_primary_reason.
-- Full plan: harness/reports/explain-current.md#bridge-quality-issues-by-reason.
-- EXPLAIN END
SELECT
  id AS bridge_operation,
  aux,
  aux_sequence,
  type,
  status,
  data_quality,
  $reason AS reason,
  data_quality_reasons AS reasons,
  sender,
  recipient,
  submit_block_height,
  sort_submit_block_height,
  submit_timestamp
FROM bridge_operation
WHERE data_quality_reasons[0] = $reason
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
