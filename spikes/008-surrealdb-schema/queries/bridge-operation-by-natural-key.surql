-- Bridge operation natural-key lookup.
SELECT * FROM bridge_operation
WHERE aux = $aux AND aux_sequence = $aux_sequence
LIMIT 1;
