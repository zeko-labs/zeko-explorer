-- Account activity feed.
SELECT * FROM account_activity
WHERE account = $account
  AND (
    block_height < $after_block_height
    OR (block_height = $after_block_height AND tx_index < $after_tx_index)
    OR (block_height = $after_block_height AND tx_index = $after_tx_index AND activity_index < $after_activity_index)
    OR (block_height = $after_block_height AND tx_index = $after_tx_index AND activity_index = $after_activity_index AND id > $after_id)
  )
ORDER BY block_height DESC, tx_index DESC, activity_index DESC, id ASC
LIMIT $limit;
