# Fault Tolerance and Recovery

The L1 Watcher must be designed for unreliable upstreams. Each adapter has a live L1 endpoint and an archive L1 endpoint, and either endpoint can be intermittently unavailable, laggy, inconsistent near tip, or timing out. These conditions degrade freshness and completeness while the watcher process and UI remain usable.

For Zeko-M, the live endpoint is the hosted Mina daemon GraphQL API and the archive endpoint is Archive-Node-API. For Zeko-E, the live endpoint is Ethereum JSON-RPC and the archive endpoint is the Ethereum archive/log source selected in Milestone 4.

## Non-Negotiable Rules

- Runtime dependency failures never cause a hard process crash.
- Only invalid static configuration should fail fast at startup.
- If a dependency is down at startup, the process still starts, exposes `/healthz`, writes degraded health if SurrealDB is reachable, and retries with backoff.
- No cursor advances before both NATS publish ack and durable state write complete.
- Failed loops are isolated from the other loops.
- The UI renders partial data. Missing bridge facts show an explicit incomplete/unknown state while the rest of the page stays usable.
- APIs expose data quality metadata so frontend can distinguish empty results, pending indexing, and source degradation.

## Data Quality Model

The indexer/API should attach source completeness to L1-backed records.

```ts
type SourceStatus = "complete" | "syncing" | "degraded" | "unavailable" | "unrecoverable_gap";

type BridgeOperationDataQuality = {
  l1BridgeEvents: SourceStatus;
  l1OuterActions: SourceStatus;
  l1Settlements: SourceStatus;
  l2Transactions: SourceStatus;
  missingFields: string[];
  warnings: string[];
  lastUpdatedAt: string;
};
```

Recommended UI behavior:

| Missing/degraded data | UI behavior |
|---|---|
| Missing `zeko.l1.bridge-events` deposit fact | Still show operation if inner/outer action exists; user PK/amount may be unknown; show "Details syncing" or "Historical bridge details unavailable." |
| Missing cancel event | Keep the deposit visible from known evidence and show cancellation status as unknown if helper counter cannot be reconciled. |
| Live L1 endpoint down | Keep existing batch/bridge pages visible; mark finality as stale/unknown; finality remains at the last proven level. |
| Archive L1 endpoint down | Keep existing indexed data visible; show freshness warning; pagination over already-indexed data still works. |
| Unrecoverable bridge-event gap | Show explicit warning in bridge history and operation details; render the available data immediately. |

The bridge API should avoid returning empty lists as if authoritative when the relevant source is degraded. Include `_meta` or field-level `dataQuality` so clients know the result is partial.

## Service Failure Matrix

### Zeko-M / Mina Live Endpoint Down

Impact:

- No live tip updates.
- No live bridge-event detection from new blocks.
- No reorg detection while down.
- Settlement finality depth becomes stale.

Watcher behavior:

- Tip reconciler marks `l1LiveNode.connected=false`.
- Archive pollers continue.
- Existing tracked settlements remain in their last known state with stale timestamp.
- Health becomes `degraded`.
- Retry daemon HTTP and WebSocket independently with exponential backoff and jitter.

Recovery:

1. Reconnect.
2. Query `bestChain(290)` before processing subscription events.
3. Compare best-chain window against persisted block window.
4. Publish rollback if orphaned previously-published facts are found.
5. Process replacement/new blocks.
6. Resume finality updates.

Unrecoverable condition:

- If downtime exceeds the daemon frontier and Archive-Node-API does not have `zkappCommands`, any bridge events missed live may be unfillable.
- Settlements and outer actions can still catch up from `actions(OUTER_PK)`.

### Zeko-M / Mina Subscription Drops but HTTP Polling Works

Impact:

- Increased latency only.

Watcher behavior:

- Keep 15s `bestChain(290)` polling as the correctness path.
- Recreate WebSocket subscription in background.
- Health remains `healthy` unless polling lag crosses threshold.

Recovery:

- Subscription reconnects and resumes as a wake-up signal.
- No cursor changes depend on subscription delivery.

### Zeko-M / Mina Archive Endpoint Down

Impact:

- Historical `outer-actions`, settlements, and bridge-event backfill pause.
- Live daemon detection can continue.
- API/indexer data becomes stale for archive-backed streams.

Watcher behavior:

- Archive pollers mark `l1ArchiveApi.connected=false`.
- Keep `outer_actions` and `bridge_events` cursors at the last durable height.
- Tip reconciler continues.
- Health becomes `degraded`.
- Retry with backoff and jitter.

Recovery:

1. Query `networkState`.
2. Resume from last durable cursor.
3. Backfill chunks `[lastCursor + 1, archiveTip]`.
4. Publish in deterministic order.
5. Advance cursor chunk by chunk only after ack/state write.

Unrecoverable condition:

- None for outer actions/settlements if `actions(OUTER_PK)` remains available after recovery.
- Bridge events are recoverable only if upstream `zkappCommands` exists for the missed range.

### Zeko-M / Mina Archive Endpoint Lagging or Returning Partial Range Data

Impact:

- Archive cursor may trail daemon tip.
- Some facts are visible live before archive confirms them.

Watcher behavior:

- Track `archiveLagBlocks = daemonTipHeight - archivePendingMaxHeight`.
- Treat lag as a degraded freshness condition.
- Keep live daemon facts marked as `source: "daemon"` until archive catches up.
- Advance the archive cursor only through returned contiguous data.
- If a chunk returns fewer results than expected, rerun the same chunk after backoff unless the API explicitly proves no data exists.

Recovery:

- Archive catches up naturally.
- Pollers continue from durable height cursor.

UI/API behavior:

- Show live settlement as `settling` with `archiveConfirmed=false` until `outer-actions` confirms it.
- Transaction/account pages render with freshness metadata.

### Zeko-M / Mina Archive Endpoint Missing `zkappCommands`

Impact:

- Bridge-event historical backfill is unavailable.
- Only live daemon bridge events and retained NATS events are available.

Watcher behavior:

- Start in reduced mode.
- Health `degraded`.
- Add limitation `historical_bridge_events_unavailable`.
- Set `bridgeBackfill.available=false`.
- Report bridge history as incomplete through health limitations and API metadata.

Recovery:

- Once API supports `zkappCommands`, enable bridge backfill and scan from configured `BRIDGE_HISTORY_START_HEIGHT` or genesis.

Unrecoverable condition:

- Any bridge event missed before the API upgrade is unfillable unless it is still in daemon frontier or retained NATS.

### NATS Down

Impact:

- No data can be safely published.

Watcher behavior:

- Keep fetching health/dependency status, but pause data cursor advancement.
- Use a bounded in-memory publish queue only for very short outages.
- If queue is full, stop ingest loops at their current cursors rather than dropping data.
- Health `down` or `degraded` depending on whether SurrealDB health writes still work.

Recovery:

1. Reconnect JetStream.
2. Replay buffered messages in order.
3. Resume loops from durable cursors.
4. JetStream deduplication handles duplicate publish attempts via `Nats-Msg-Id`.

No hard crash:

- NATS reconnect failures are logged and retried.
- The process stays alive.

### SurrealDB Down

Impact:

- Durable cursors and published-fact index cannot be updated.
- Health writes may fail.

Watcher behavior:

- Publish new data facts only when they can be recorded durably.
- Keep dependency probes running.
- Keep `/healthz` serving local in-memory status.
- Health publication to NATS may continue only for service status, not data cursors.

Recovery:

1. Reconnect SurrealDB.
2. Reload durable cursors and block window.
3. Reconcile the adapter canonical chain window.
4. Resume archive backfill from last persisted cursor.

Rationale:

- Publishing without durable state risks unbounded duplicates and missed rollback mapping.

### Watcher Process Restart

Impact:

- No live processing while process is down.

Startup recovery:

1. Start process even if dependencies are currently down.
2. Wait for SurrealDB and NATS before data publication.
3. Load cursors and block window.
4. Query the adapter canonical chain window when the live L1 endpoint is reachable.
5. Query archive tip when the archive L1 endpoint is reachable.
6. Resume archive pollers from durable cursors.
7. Publish rollback if persisted block window diverged from current best chain.

Unrecoverable condition:

- Bridge events missed during downtime are recoverable only if `zkappCommands` exists for the missed block range, NATS retained already-published bridge events, or daemon frontier still contains the missed blocks.

### Zeko-E / Ethereum Endpoint Failures

The Ethereum adapter follows the same recovery contract:

- Live JSON-RPC outage pauses live head tracking, reorg detection, and finality updates; archive log catch-up continues when the archive endpoint is reachable.
- Archive/log-source outage pauses historical settlement and bridge-event catch-up; live head processing continues when JSON-RPC is reachable.
- Reconnection always starts with canonical chain reconciliation before new facts are published.
- Missed Ethereum bridge facts are recoverable only if the selected archive source can query the required historical logs/transactions for the missed range, or if the facts were already published and retained in NATS.

Milestone 4 must define the Ethereum-specific finality threshold, reorg depth policy, contract addresses, ABI/event mappings, and archive provider guarantees before the Zeko-E adapter can claim historical completeness.

### Indexer Down

Impact:

- NATS streams continue accumulating L1 facts.
- API/UI data becomes stale because SurrealDB read model is not updated.

Watcher behavior:

- Continue publishing normally.

Indexer recovery:

1. Resume JetStream consumers from durable consumer sequence.
2. Replay missed `zeko.l1.*` messages.
3. Apply idempotent upserts by event IDs.
4. Process rollback events in order.

UI/API behavior:

- Show stale freshness metadata.
- Continue serving existing records.
- Keep pages usable with partial data.

### Bridge API or Explorer API Down

Impact:

- UI cannot fetch one API surface.

Watcher behavior:

- No change.

UI behavior:

- Render available page sections.
- Show API-specific unavailable state.
- Represent API downtime separately from an authoritative empty bridge-operation result.

### Frontend Down or Client Offline

Impact:

- No backend data loss.

Recovery:

- Client refetches from APIs.
- APIs return current freshness/data quality metadata.

## Cursor and Replay Rules

Each stream has its own cursor:

| Cursor | Advances after | Pauses when |
|---|---|---|
| `outer_actions` | all outer-action messages for chunk have NATS ack and published IDs persisted | Archive L1 endpoint, NATS, or SurrealDB unavailable |
| `bridge_events` | all bridge-event messages for chunk have NATS ack and published IDs persisted | Archive L1 endpoint, NATS, SurrealDB, or provider-specific historical bridge source unavailable |
| `canonical_window` | block window and any detected live facts are persisted | Live L1 endpoint unavailable, NATS unavailable for new facts, SurrealDB unavailable |

Replay is always idempotent:

- Event IDs are deterministic.
- NATS uses `Nats-Msg-Id`.
- Indexer upserts by event ID.
- Rollbacks refer to event IDs, not inferred ranges.

## Health Status Semantics

| Status | Meaning |
|---|---|
| `healthy` | All configured sources reachable; cursors within lag threshold; no unreconciled helper counter mismatch. |
| `degraded` | At least one source is down/lagging, `zkappCommands` missing, helper counter mismatch exists, or data quality is partial. Service stays up. |
| `down` | Watcher cannot publish or persist data because NATS or SurrealDB is unavailable. Process still stays up. |

Use `limitations` to make degraded behavior machine-readable:

- `l1_live_unavailable`
- `l1_archive_unavailable`
- `historical_bridge_events_unavailable`
- `bridge_event_gap_unrecoverable`
- `helper_cancel_counter_unreconciled`
- `nats_unavailable`
- `surrealdb_unavailable`

## UI Contract

The UI must never block on missing bridge-related L1 data.

Required behavior:

- Bridge operation list renders known operations even if some L1 fields are missing.
- Operation detail page renders known links/actions and marks missing sections as unavailable/syncing.
- Batch pages render known settlement state and stale finality warnings if the live L1 endpoint is down.
- Account pages render indexed transactions/actions and show freshness warnings for degraded sources.
- Search results can return partial records with warnings.

After the initial page shell loads, degraded L1 sources render as inline stale/partial states instead of global loading spinners.

## Cucumber Scenarios

The acceptance coverage for this fault-tolerance contract lives in:

- [Dependency startup resilience](../test-scenarios/dependency-startup.feature)
- [Mina daemon and archive recovery](../test-scenarios/daemon-and-archive-recovery.feature)
- [Durable publication failure handling](../test-scenarios/durable-publication-failures.feature)
- [Watcher restart and reorganization recovery](../test-scenarios/watcher-restart-and-reorg.feature)
- [Downstream service downtime](../test-scenarios/downstream-service-downtime.feature)
- [Partial bridge data UI behavior](../test-scenarios/partial-bridge-data-ui.feature)

These scenarios are the implementation target. They should be backed by recorded daemon/archive fixtures plus controllable doubles for NATS, SurrealDB, Archive-Node-API, the hosted Mina daemon, the indexer, the explorer API, and the frontend.
