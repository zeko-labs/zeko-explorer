-- Durable L1 watcher cursor lookup.
SELECT * FROM l1_watcher_cursor
WHERE source = $source
  AND network = $network
  AND provider = $provider
  AND cursor_kind = $cursor_kind
LIMIT 1;
