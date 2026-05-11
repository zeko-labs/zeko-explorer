-- Batch feed.
SELECT * FROM batch
WHERE batch_height < $after_batch_height
  OR (batch_height = $after_batch_height AND id > $after_id)
ORDER BY batch_height DESC, id ASC
LIMIT $limit;
