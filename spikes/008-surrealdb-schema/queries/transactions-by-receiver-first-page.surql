-- First page for one receiver/smart-contract transaction feed.
LET $edges = (
  SELECT in AS tx, sort_block_height, sort_tx_index FROM account_transaction
  WHERE account_public_key = $public_key
    AND role = "receiver"
  ORDER BY sort_block_height ASC, sort_tx_index ASC
  LIMIT $limit
);

SELECT * FROM $edges.tx;
