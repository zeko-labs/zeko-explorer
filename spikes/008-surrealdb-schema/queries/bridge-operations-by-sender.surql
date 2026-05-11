-- Sender-side bridge history page after cursor.
SELECT * FROM bridge_operation
WHERE sender = $public_key
  AND sort_submit_block_height > $after_sort_submit_block_height
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
