-- First page for one sender's transaction feed.
SELECT * FROM transaction
WHERE sender = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT $limit;
