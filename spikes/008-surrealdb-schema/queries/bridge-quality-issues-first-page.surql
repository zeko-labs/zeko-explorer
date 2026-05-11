-- Open bridge evidence issues. This replaces scanning bridge_operation by data_quality.
SELECT * FROM bridge_quality_issue
WHERE is_open = true
  AND data_quality = $data_quality
ORDER BY sort_submit_block_height ASC, id ASC
LIMIT $limit;
