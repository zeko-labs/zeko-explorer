-- zkApp event feed for a contract/account.
SELECT * FROM zkapp_event
WHERE emitting_account = $account
  AND (
    block_height < $after_block_height
    OR (block_height = $after_block_height AND tx_index < $after_tx_index)
    OR (block_height = $after_block_height AND tx_index = $after_tx_index AND event_index < $after_event_index)
    OR (block_height = $after_block_height AND tx_index = $after_tx_index AND event_index = $after_event_index AND id > $after_id)
  )
ORDER BY block_height DESC, tx_index DESC, event_index DESC, id ASC
LIMIT $limit;
