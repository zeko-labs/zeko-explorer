-- Open bridge evidence issues for one missing/inferred source reason.
SELECT * FROM bridge_quality_issue
WHERE reason = $reason
ORDER BY sort_submit_block_height ASC, id ASC
LIMIT $limit;
