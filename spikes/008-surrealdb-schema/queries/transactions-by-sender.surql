-- Account transaction feed for sender role.
SELECT * FROM transaction
WHERE sender_public_key = $public_key
  AND sort_block_height > $after_sort_block_height
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT $limit;
