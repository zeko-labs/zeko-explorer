# Archive-Node-API zkApp Command Query Requirement

## Why This Is Required

We are not planning to operate a Mina L1 node, run our own archive node, or access the archive database directly. The L1 Watcher must be able to rebuild from public APIs plus NATS retention.

Archive-Node-API is already sufficient for actions on a known account:

- `actions(input: { address: OUTER_PK, ... })` gives commit/witness action field arrays.
- This covers `zeko.l1.outer-actions` and settlement backfill.

It is not sufficient for historical bridge-event detection:

- Deposit submissions are actions emitted by arbitrary user account updates, not by `OUTER_PK`.
- Cancel deposits do not emit an outer witness action.
- Withdrawal finalization needs transaction-level account update and event context.
- Archive-Node-API `blocks` currently exposes zkApp command hash/status/memo/fee payer, but not account update actions/events/app state/preconditions.

## Consequence If Not Fixed

If Archive-Node-API does not expose full zkApp account updates:

- The watcher can detect bridge events only live from Mina daemon blocks and whatever `zeko.l1.bridge-events` still exists in JetStream retention.
- This creates an unfillable gap for any missed bridge event outside those live/retained windows. That includes data before the watcher first starts and data missed during any explorer/watcher downtime after it starts.
- Historical deposits before watcher launch are not recoverable through public APIs.
- Historical cancels are not recoverable from `OUTER_PK` actions because cancel emits no outer action.
- Any watcher outage longer than the Mina daemon frontier creates a permanent bridge-event gap. A shorter outage is only recoverable if the daemon still has the missed blocks in its frontier or NATS retained already-published events.
- Per-user bridge history becomes incomplete for old data and for any downtime gap, so the replacement for `findDeposits(pk)` / `findWithdrawals(pk)` is only correct for continuously observed periods.
- Rebuilding SurrealDB from NATS is only complete if JetStream still retains all `zeko.l1.bridge-events`.

That is not acceptable for a production explorer unless product explicitly accepts both a "bridge history starts at watcher deployment" cutoff and permanent gaps for any watcher downtime not covered by the daemon frontier or NATS retention.

## Required Upstream API

Add this Archive-Node-API query:

```graphql
query ZkappCommands($from: Int!, $to: Int!) {
  zkappCommands(input: { from: $from, to: $to, status: ALL }) {
    blockInfo {
      height
      stateHash
      parentHash
      timestamp
      globalSlotSinceGenesis
      chainStatus
      distanceFromMaxBlockHeight
    }
    hash
    feePayer
    fee
    memo
    status
    failureReason
    sequenceNumber
    accountUpdates {
      id
      publicKey
      tokenId
      authorizationKind
      balanceChange
      incrementNonce
      callDepth
      actions
      events
      appState
      accountPrecondition {
        state
        actionState
        provedState
        isNew
      }
      networkPrecondition {
        globalSlotSinceGenesis
      }
    }
  }
}
```

The L1 Watcher only needs block-range pagination. Optional `accountPublicKey` filtering is useful for diagnostics, but the watcher must be able to scan all account updates because deposits are emitted by arbitrary user public keys.

## Upstream PR Shape

Open a PR against `https://github.com/o1-labs/Archive-Node-API` that adds `Query.zkappCommands`.

Reference implementation was validated locally against base commit `8e52218caf2ba1a16925ec0ac893e1c6bf7c0446` with:

- `npm ci`
- `npm run codegen`
- `npm run build`

Files to change in the upstream PR:

| File | Change |
|---|---|
| `schema.graphql` | Add `ZkappCommandFilterOptionsInput`, `ZkappCommandOutput`, `ZkappAccountUpdateOutput`, `ZkappAccountPrecondition`, `ZkappNetworkPrecondition`, and `Query.zkappCommands`. |
| `src/blockchain/types.ts` | Add output types matching the schema. |
| `src/resolvers.ts` | Add resolver wiring to `context.db_client.getZkappCommands`. |
| `src/db/archive-node-adapter/archive-node-adapter.interface.ts` | Add `getZkappCommands(input, options)`. |
| `src/db/archive-node-adapter/archive-node-adapter.ts` | Instantiate `ZkappCommandsService` and forward `getZkappCommands`. |
| `src/services/zkapp-commands-service/zkapp-commands-service.ts` | New service, following the existing `ActionsService`/`EventsService` pattern. |
| `src/services/zkapp-commands-service/zkapp-commands-service.interface.ts` | New service interface. |
| `src/db/sql/zkapp-commands/queries.ts` | New SQL query for block-range zkApp commands with full account update detail. |
| `src/db/sql/zkapp-commands/types.ts` | New database row type. |
| `src/resolvers-types.ts` | Regenerate with `npm run codegen`; do not edit manually. |

Implementation details that matter:

- Reuse the existing `BLOCK_RANGE_SIZE` enforcement pattern from `ActionsService` and `EventsService`.
- Follow existing tracing style: `zkappCommands.SQL` and `zkappCommands.processing`.
- Return only non-failed zkApp commands in the first version, matching current `actions` behavior.
- Keep the range API height-based: `from` inclusive, `to` exclusive.
- Preserve account update ordering by unnesting `zkc.zkapp_account_updates_ids WITH ORDINALITY`.
- Preserve nested action/event order by unnesting `zkapp_events.element_ids WITH ORDINALITY` and `zkapp_field_array.element_ids WITH ORDINALITY`.
- Return raw field strings exactly as stored. Archive-Node-API should not decode bridge-specific data.
- Include optional `accountPublicKey` and `tokenId` filters, but do not require them. The watcher must scan all account updates.

Core SQL shape:

```sql
SELECT
  b.height,
  b.state_hash,
  b.parent_hash,
  b.global_slot_since_genesis,
  b.timestamp,
  b.chain_status,
  zkc.hash,
  zkc.memo,
  bzkc.status,
  bzkc.sequence_no,
  fee_payer_pk.value AS fee_payer,
  zkau.id AS account_update_id,
  account_update_ids.account_update_order,
  account_update_pk.value AS public_key,
  t.value AS token_id,
  zkub.authorization_kind,
  zkub.balance_change,
  zkub.increment_nonce,
  zkub.call_depth,
  actions.fields AS actions,
  events.fields AS events,
  app_state.fields AS app_state,
  account_precondition.state AS account_precondition_state,
  account_precondition.action_state AS account_precondition_action_state,
  network_precondition.global_slot_since_genesis
FROM blocks b
JOIN blocks_zkapp_commands bzkc ON b.id = bzkc.block_id
JOIN zkapp_commands zkc ON bzkc.zkapp_command_id = zkc.id
JOIN zkapp_fee_payer_body fpb ON zkc.zkapp_fee_payer_body_id = fpb.id
JOIN public_keys fee_payer_pk ON fpb.public_key_id = fee_payer_pk.id
JOIN LATERAL unnest(zkc.zkapp_account_updates_ids)
  WITH ORDINALITY AS account_update_ids(account_update_id, account_update_order) ON true
JOIN zkapp_account_update zkau ON zkau.id = account_update_ids.account_update_id
JOIN zkapp_account_update_body zkub ON zkau.body_id = zkub.id
JOIN account_identifiers ai ON zkub.account_identifier_id = ai.id
JOIN public_keys account_update_pk ON ai.public_key_id = account_update_pk.id
JOIN tokens t ON ai.token_id = t.id
LEFT JOIN zkapp_network_precondition network_precondition
  ON network_precondition.id = zkub.zkapp_network_precondition_id
WHERE b.height >= $from
  AND b.height < $to
  AND bzkc.status <> 'failed'
ORDER BY b.height, bzkc.sequence_no, account_update_ids.account_update_order;
```

The actual PR needs lateral subqueries to materialize `actions`, `events`, app state, and account precondition field arrays. Those subqueries should mirror the existing `src/db/sql/events-actions/queries.ts` event/action field-array joins rather than introducing bridge-specific logic.

## Query Contract For The Watcher

Constraints:

- `from` is inclusive.
- `to` is exclusive.
- Chunk size must stay at or below Archive-Node-API `BLOCK_RANGE_SIZE`, default `10000`.
- Use `status: ALL` so the watcher can map pending/canonical/orphaned facts and handle rollbacks.
- Sort order must be block height, zkApp command sequence number, account update order.
- Preserve raw field strings exactly as returned. Decoding belongs in `packages/l1-watcher`.

Required fields by bridge event:

| Bridge event | Required fields |
|---|---|
| Deposit submission | signed account update public key, `actions`, `balanceChange`, tx hash, block info |
| Withdrawal finalization | outer witness `actions`, finalize-withdrawal `events`, fee payer/signed updater, tx hash, block info |
| Cancel deposit | helper account `appState`, account precondition state/action state, tx hash, block info |

## Watcher Behavior Before Upstream Merge

Before the Archive-Node-API change lands, the watcher can be implemented in a reduced mode:

- Live bridge events from daemon `bestChain` blocks.
- Historical `outer-actions` and settlements from `actions(OUTER_PK)`.
- Health status `degraded` with limitation: `historical_bridge_events_unavailable`.
- Config option `BRIDGE_HISTORY_START_HEIGHT` set to the deployment height.
- Operational warning: any watcher downtime can create an unfillable bridge-event gap once the missed blocks age out of the daemon frontier and were not already published to NATS.

This reduced mode should not be presented as a complete replacement for archive scanning.
