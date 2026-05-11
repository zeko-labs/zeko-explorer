-- First zkApp action page for a contract/account.
SELECT * FROM zkapp_action
WHERE emitting_account = $account
ORDER BY block_height DESC, tx_index DESC, action_index DESC, id ASC
LIMIT $limit;
