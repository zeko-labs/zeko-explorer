# L1 Watcher Implementation Spec

This file is the implementation handoff for the L1 Watcher package. Milestone 1 implements the Zeko-M / Mina adapter. Milestone 4 implements the Zeko-E / Ethereum adapter behind the same package boundary.

## Package Boundary

Implement the watcher lifecycle, publication, state, and health code once. Put provider-specific source access and decoding behind adapters:

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
      ethereum/
        README.md
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

1. Parse stack-provided config and fail fast only on invalid static configuration, such as missing stack/network context or malformed public keys.
2. Generate `instanceId`.
3. Start `GET /healthz`.
4. Start dependency connection managers for SurrealDB, NATS, and the active adapter's live/archive L1 endpoints.
5. When SurrealDB is reachable, load watcher cursors and rolling block window.
6. When the live L1 endpoint is reachable, query the adapter canonical chain window and reconcile before publishing new live-derived facts.
7. For the Mina adapter, verify whether Archive-Node-API exposes `zkappCommands` before marking historical bridge-event backfill available.
8. Start runtime loops immediately; each loop waits for its required dependency and otherwise reports degraded health.

Readiness means the process is alive and can report health. Dependency availability is represented inside health status, not by crashing or refusing to start.

## Runtime Loops

The shared watcher owns loop scheduling, retry/backoff, durable cursors, NATS publication, and health. The adapter owns live/archive L1 reads and provider-specific decoding.

### Tip Reconciler

Zeko-M / Mina inputs:

- Hosted Mina daemon `bestChain(maxLength: 290)`
- Mina daemon `newBlock` subscription
- Mina daemon `chainReorganization` subscription

Shared behavior:

1. Wake on subscription event or every `POLL_INTERVAL_MS`.
2. Query `bestChain(290)`.
3. Normalize blocks oldest-to-newest.
4. Run reorg detection against persisted block window.
5. Publish rollback if old blocks were orphaned and published facts are affected.
6. Process new best-chain blocks:
   - detect provider-specific settlement facts;
   - detect live bridge events from provider-specific block/log data;
   - store published fact IDs by block hash.
7. Recompute confirmation depth for tracked settlements.
8. Publish finality update if a settlement crosses from `settling` to `finalized`.
9. Persist updated block window.

Use subscription payloads as wake-up signals. Always reconcile through `bestChain`.

### Outer Action Poller

Zeko-M / Mina inputs:

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

Keep the cursor height based. Action-state filters are useful for diagnostics, but height ranges are simpler and match the archive API's documented scan cap.

The Zeko-E / Ethereum adapter implements the equivalent archive scan for settlement logs/transactions in Milestone 4.

### Bridge Event Backfill Poller

Zeko-M / Mina inputs:

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

The Zeko-E / Ethereum adapter implements the equivalent archive log/event scan for bridge contracts in Milestone 4.

### Helper Counter Verifier

Zeko-M / Mina inputs:

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

1. Measure live L1 connectivity, tip height, and last block time.
2. Measure archive L1 connectivity and lag.
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
DEFINE FIELD block_hash ON l1_watcher_block TYPE string;
DEFINE FIELD parent_hash ON l1_watcher_block TYPE string;
DEFINE FIELD slot ON l1_watcher_block TYPE option<int>;
DEFINE FIELD provider ON l1_watcher_block TYPE string;
DEFINE FIELD provider_fields ON l1_watcher_block TYPE option<object>;
DEFINE FIELD observed_at ON l1_watcher_block TYPE datetime;
DEFINE INDEX idx_l1_watcher_block_hash ON l1_watcher_block FIELDS network, block_hash UNIQUE;
DEFINE INDEX idx_l1_watcher_block_height ON l1_watcher_block FIELDS network, height;

DEFINE TABLE l1_watcher_published SCHEMAFULL;
DEFINE FIELD network ON l1_watcher_published TYPE string;
DEFINE FIELD event_id ON l1_watcher_published TYPE string;
DEFINE FIELD subject ON l1_watcher_published TYPE string;
DEFINE FIELD block_height ON l1_watcher_published TYPE int;
DEFINE FIELD block_hash ON l1_watcher_published TYPE string;
DEFINE FIELD tx_hash ON l1_watcher_published TYPE option<string>;
DEFINE FIELD published_at ON l1_watcher_published TYPE datetime;
DEFINE INDEX idx_l1_watcher_published_event ON l1_watcher_published FIELDS network, event_id UNIQUE;
DEFINE INDEX idx_l1_watcher_published_block ON l1_watcher_published FIELDS network, block_hash;
```

## Error Handling

| Dependency | If down | Continue? |
|---|---|---|
| NATS | Mark down. Keep cursors unchanged. Buffer only bounded in-memory data for very short outages. | Process continues; data progress pauses. |
| SurrealDB | Mark down. Pause data publication because state cannot be persisted. | Process continues; data progress pauses. |
| Live L1 endpoint | Mark degraded. Keep archive pollers running. | Historical catch-up continues if archive is reachable. |
| Archive L1 endpoint | Mark degraded. Keep live loop running. | Historical catch-up stops. |

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
