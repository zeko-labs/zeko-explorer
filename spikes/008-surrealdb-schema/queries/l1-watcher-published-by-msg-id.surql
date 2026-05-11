-- Published-message idempotency lookup.
SELECT * FROM l1_watcher_published
WHERE msg_id = $msg_id
LIMIT 1;
