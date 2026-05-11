-- First sender-side bridge history page.
SELECT * FROM bridge_operation
WHERE sender = $public_key
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
