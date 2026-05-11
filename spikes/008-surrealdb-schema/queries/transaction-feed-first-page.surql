-- First page for the global transaction feed.
SELECT * FROM transaction
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT $limit;
