-- First batch page.
SELECT * FROM batch
ORDER BY batch_height DESC, id ASC
LIMIT $limit;
