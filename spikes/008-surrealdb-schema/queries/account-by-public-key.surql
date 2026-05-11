-- Natural-key account lookup.
SELECT * FROM account
WHERE public_key = $public_key
LIMIT 1;
