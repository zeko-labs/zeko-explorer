-- Source freshness lookup for API _meta.
SELECT * FROM sync_status
WHERE source = $source
LIMIT 1;
