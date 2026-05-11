-- First page for one receiver/smart-contract transaction feed.
SELECT * FROM transaction
WHERE receiver = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT $limit;
