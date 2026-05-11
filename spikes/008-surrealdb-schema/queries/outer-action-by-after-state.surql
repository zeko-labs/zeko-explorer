-- Outer action natural-key lookup.
SELECT * FROM outer_action
WHERE after_state = $after_state
LIMIT 1;
