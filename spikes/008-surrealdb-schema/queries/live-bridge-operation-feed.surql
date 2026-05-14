-- GraphQL bridgeOperationFeed subscription.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): LIVE SELECT is a subscription surface and is not explainable as a finite read plan.
-- Initial sender/recipient history pages use idx_bo_sender_order and idx_bo_recipient_order.
-- EXPLAIN END
LIVE SELECT * FROM bridge_operation
WHERE sender = $public_key OR recipient = $public_key;
