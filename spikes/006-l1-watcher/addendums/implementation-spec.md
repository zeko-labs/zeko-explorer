# L1 Watcher Implementation Spec

This file is the handoff for the engineer implementing `packages/l1-watcher`.

## Package Boundary

Implement as a TypeScript package in the monorepo:

```
packages/l1-watcher/
  package.json
  tsconfig.json
  src/
    main.ts
    config.ts
    service.ts
    state/
      l1-watcher-state.ts
      surreal-state-store.ts
    nats/
      publisher.ts
      subjects.ts
    adapters/
      mina/
        mina-daemon-client.ts
        mina-archive-api-client.ts
        mina-archive-zkapp-command-client.ts
        mina-action-decoder.ts
        mina-bridge-decoder.ts
        mina-reorg-detector.ts
    health/
      health-server.ts
      heartbeat.ts
```

Suggested dependencies:

- `nats` for JetStream publication.
- GraphQL client already used elsewhere in the repo, or `graphql-request` if no shared client exists.
- Existing SurrealDB client used by the indexer package.
- `o1js` only in the Mina adapter/decoder package path, for public key conversion and Poseidon hash compatibility.

## Boot Sequence

1. Parse config and fail fast only on invalid static configuration, such as missing network name or malformed public keys.
2. Generate `instanceId`.
3. Start `GET /healthz`.
4. Start dependency connection managers for SurrealDB, NATS, Mina daemon HTTP/WebSocket, and Archive-Node-API.
5. When SurrealDB is reachable, load watcher cursors and rolling block window.
6. When Mina daemon is reachable, query `bestChain(290)` and reconcile before publishing new daemon-derived facts.
7. When Archive-Node-API is reachable, verify whether `zkappCommands` is present in the schema.
8. Start runtime loops immediately; each loop waits for its required dependency and otherwise reports degraded health.

Readiness means the process is alive and can report health. Dependency availability is represented inside health status, not by crashing or refusing to start.

## Runtime Loops

### Tip Reconciler

Inputs:

- Hosted Mina daemon `bestChain(maxLength: 290)`
- Mina daemon `newBlock` subscription
- Mina daemon `chainReorganization` subscription

Behavior:

1. Wake on subscription event or every `POLL_INTERVAL_MS`.
2. Query `bestChain(290)`.
3. Normalize blocks oldest-to-newest.
4. Run reorg detection against persisted block window.
5. Publish rollback if old blocks were orphaned and published facts are affected.
6. Process new best-chain blocks:
   - detect settlement commit actions from `OUTER_PK`;
   - detect live bridge events from account updates;
   - store published fact IDs by block hash.
7. Recompute confirmation depth for tracked settlements.
8. Publish finality update if a settlement crosses from `settling` to `finalized`.
9. Persist updated block window.

Do not trust subscription payloads as complete state. Always reconcile through `bestChain`.

### Outer Action Poller

Inputs:

- Archive-Node-API `networkState`
- Archive-Node-API `actions(input)`

Behavior:

1. Read `outer_actions` cursor from SurrealDB.
2. Query archive pending max height.
3. For each chunk `[from, to)`:
   - call `actions(input: { address: OUTER_PK, status: ALL, from, to })`;
   - flatten returned `actionData`;
   - sort by block height, tx sequence number, account update index, action index;
   - decode commit/witness/unknown;
   - publish `zeko.l1.outer-actions`;
   - publish `zeko.l1.settlements` if a commit exists that was missed by live daemon processing;
   - persist published IDs.
4. Advance `outer_actions` cursor only after all messages in the chunk ack.

Keep the cursor height based, not action-state based. Action-state filters are useful for diagnostics, but height ranges are simpler and match the archive API's documented scan cap.

### Bridge Event Backfill Poller

Inputs:

- Archive-Node-API `zkappCommands(input)`.

Behavior:

1. Read `bridge_events` cursor from SurrealDB.
2. Query zkApp commands by block range using Archive-Node-API.
3. For each successful zkApp command:
   - run deposit detector over all signed account updates with actions;
   - run withdrawal finalization detector over outer witness plus event payloads;
   - run cancel detector over helper account state update/precondition pattern;
   - publish detected bridge events with deterministic IDs;
   - store published IDs by block hash.
4. Advance `bridge_events` cursor only after NATS ack.

This poller is what turns the watcher into a rebuildable service. Without the upstream `zkappCommands` query, bridge events are live-only and incomplete for historical data.

### Helper Counter Verifier

Inputs:

- Mina daemon `account(publicKey: HELPER_ACCOUNT_L1_PK)`.

Behavior:

1. Every 10 daemon blocks, read `zkappState[0]`.
2. Compare it with the last counter value explained by published cancel events.
3. If it advanced without a matching event:
   - mark health degraded;
   - rescan recent daemon window and archive range;
   - keep degraded status until the counter delta is reconciled.

This is a consistency check. It is not the primary cancel detector.

### Health Loop

Every `HEARTBEAT_INTERVAL_MS`:

1. Measure daemon connectivity, tip height, and last block time.
2. Measure archive API connectivity and lag.
3. Measure NATS publish state.
4. Measure cursor lag.
5. Upsert `sync_status:l1-watcher:{network}`.
6. Publish `zeko.health`.

## State Model

Use SurrealDB records:

```surql
DEFINE TABLE l1_watcher_cursor SCHEMAFULL;
DEFINE FIELD network ON l1_watcher_cursor TYPE string;
DEFINE FIELD cursor_name ON l1_watcher_cursor TYPE string;
DEFINE FIELD height ON l1_watcher_cursor TYPE int;
DEFINE FIELD action_state ON l1_watcher_cursor TYPE option<string>;
DEFINE FIELD updated_at ON l1_watcher_cursor TYPE datetime;
DEFINE INDEX idx_l1_watcher_cursor_unique ON l1_watcher_cursor FIELDS network, cursor_name UNIQUE;

DEFINE TABLE l1_watcher_block SCHEMAFULL;
DEFINE FIELD network ON l1_watcher_block TYPE string;
DEFINE FIELD height ON l1_watcher_block TYPE int;
DEFINE FIELD state_hash ON l1_watcher_block TYPE string;
DEFINE FIELD parent_hash ON l1_watcher_block TYPE string;
DEFINE FIELD slot ON l1_watcher_block TYPE int;
DEFINE FIELD observed_at ON l1_watcher_block TYPE datetime;
DEFINE INDEX idx_l1_watcher_block_hash ON l1_watcher_block FIELDS network, state_hash UNIQUE;
DEFINE INDEX idx_l1_watcher_block_height ON l1_watcher_block FIELDS network, height;

DEFINE TABLE l1_watcher_published SCHEMAFULL;
DEFINE FIELD network ON l1_watcher_published TYPE string;
DEFINE FIELD event_id ON l1_watcher_published TYPE string;
DEFINE FIELD subject ON l1_watcher_published TYPE string;
DEFINE FIELD block_height ON l1_watcher_published TYPE int;
DEFINE FIELD block_state_hash ON l1_watcher_published TYPE string;
DEFINE FIELD tx_hash ON l1_watcher_published TYPE option<string>;
DEFINE FIELD published_at ON l1_watcher_published TYPE datetime;
DEFINE INDEX idx_l1_watcher_published_event ON l1_watcher_published FIELDS network, event_id UNIQUE;
DEFINE INDEX idx_l1_watcher_published_block ON l1_watcher_published FIELDS network, block_state_hash;
```

## Error Handling

| Dependency | If down | Continue? |
|---|---|---|
| NATS | Mark down. Do not advance cursors. Buffer only bounded in-memory data for very short outages. | Process continues; data progress pauses. |
| SurrealDB | Mark down. Do not publish data because state cannot be persisted. | Process continues; data progress pauses. |
| Mina daemon | Mark degraded. Keep archive pollers running. | Outer action and bridge backfill continue. |
| Archive API | Mark degraded. Keep daemon live loop running. | Historical catch-up stops. |

Use exponential backoff with jitter per dependency. Avoid process exit loops for transient outages before or after boot.

Detailed recovery behavior, including downstream API/UI degradation, is specified in [Fault tolerance and recovery](fault-tolerance.md).

## Testing Requirements

Acceptance coverage is defined as Cucumber scenarios in `../test-scenarios`:

- `settlements-and-outer-actions.feature`
- `bridge-event-detection.feature`
- `dependency-startup.feature`
- `daemon-and-archive-recovery.feature`
- `durable-publication-failures.feature`
- `watcher-restart-and-reorg.feature`
- `downstream-service-downtime.feature`
- `partial-bridge-data-ui.feature`

Use recorded daemon/archive fixtures for L1 facts and controllable service doubles for dependency outage, recovery, acknowledgement timeout, stale-data paths, and partial API/UI rendering.
