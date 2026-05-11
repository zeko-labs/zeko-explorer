-- One indexed step backward in the inner action state chain.
SELECT * FROM inner_action
WHERE after_state = $after_state
LIMIT 1;
