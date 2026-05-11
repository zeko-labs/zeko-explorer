-- Open-ended global transaction feed.
SELECT * FROM transaction
WHERE sort_block_height > $after_sort_block_height
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT $limit;
