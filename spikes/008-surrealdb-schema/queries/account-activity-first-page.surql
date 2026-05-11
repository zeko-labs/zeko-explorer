-- First account activity page.
SELECT * FROM account_activity
WHERE account = $account
ORDER BY block_height DESC, tx_index DESC, activity_index DESC, id ASC
LIMIT $limit;
