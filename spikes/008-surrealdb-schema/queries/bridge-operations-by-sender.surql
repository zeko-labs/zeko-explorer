-- Sender-side bridge history page after cursor.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_bo_sender_order.
-- Full plan: harness/reports/explain-current.md#bridge-operations-by-sender.
-- EXPLAIN END
SELECT * FROM bridge_operation
WHERE sender = $public_key
  AND [sort_submit_block_height, aux, aux_sequence, id] > [
    $after_sort_submit_block_height,
    $after_aux,
    $after_aux_sequence,
    $after_id
  ]
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
