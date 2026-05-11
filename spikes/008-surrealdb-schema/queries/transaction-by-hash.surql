-- Natural-key transaction lookup.
SELECT * FROM transaction
WHERE hash = $hash
LIMIT 1;
