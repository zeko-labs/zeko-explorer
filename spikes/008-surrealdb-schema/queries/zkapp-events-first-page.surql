-- First zkApp event page for a contract/account.
SELECT * FROM zkapp_event
WHERE emitting_account = $account
ORDER BY block_height DESC, tx_index DESC, event_index DESC, id ASC
LIMIT $limit;
