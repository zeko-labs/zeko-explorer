-- DA observations for a batch detail page.
SELECT * FROM da_attestation
WHERE batch = $batch
ORDER BY observed_at DESC, id ASC
LIMIT $limit;
