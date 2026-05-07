# Fault Tolerance and Recovery

The L1 Watcher must be designed for unreliable upstreams. Hosted Mina daemon GraphQL and public Archive-Node-API should be treated as intermittently unavailable, laggy, inconsistent near tip, and capable of timing out. These conditions must degrade freshness and completeness, not crash the watcher or block the UI.

## Non-Negotiable Rules

- Runtime dependency failures never cause a hard process crash.
- Only invalid static configuration should fail fast at startup.
- If a dependency is down at startup, the process still starts, exposes `/healthz`, writes degraded health if SurrealDB is reachable, and retries with backoff.
- No cursor advances before both NATS publish ack and durable state write complete.
- A failed loop does not stop other loops.
- The UI must render partial data. Missing bridge facts must show an explicit incomplete/unknown state, not block pages or throw.
- APIs must expose data quality metadata so frontend can distinguish "not found" from "not indexed yet" or "source degraded".

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
| Missing cancel event | Do not hide deposit; keep status from known evidence and show cancellation status as unknown if helper counter cannot be reconciled. |
| L1 daemon down | Keep existing batch/bridge pages visible; mark finality as stale/unknown; do not advance to finalized. |
| Archive API down | Keep existing indexed data visible; show freshness warning; pagination over already-indexed data still works. |
| Unrecoverable bridge-event gap | Show explicit warning in bridge history and operation details; do not spin forever or block the page. |

The bridge API should avoid returning empty lists as if authoritative when the relevant source is degraded. Include `_meta` or field-level `dataQuality` so clients know the result is partial.

## Service Failure Matrix

### Hosted Mina Daemon GraphQL Down

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

### Daemon Subscription Drops but HTTP Polling Works

Impact:

- Increased latency only.

Watcher behavior:

- Keep 15s `bestChain(290)` polling as the correctness path.
- Recreate WebSocket subscription in background.
- Health remains `healthy` unless polling lag crosses threshold.

Recovery:

- Subscription reconnects and resumes as a wake-up signal.
- No cursor changes depend on subscription delivery.

### Archive-Node-API Down

Impact:

- Historical `outer-actions`, settlements, and bridge-event backfill pause.
- Live daemon detection can continue.
- API/indexer data becomes stale for archive-backed streams.

Watcher behavior:

- Archive pollers mark `l1ArchiveApi.connected=false`.
- Do not advance `outer_actions` or `bridge_events` cursors.
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

### Archive-Node-API Lagging or Returning Partial Range Data

Impact:

- Archive cursor may trail daemon tip.
- Some facts are visible live before archive confirms them.

Watcher behavior:

- Track `archiveLagBlocks = daemonTipHeight - archivePendingMaxHeight`.
- Do not treat lag as a fatal error.
- Keep live daemon facts marked as `source: "daemon"` until archive catches up.
- Do not advance archive cursor past returned contiguous data.
- If a chunk returns fewer results than expected, rerun the same chunk after backoff unless the API explicitly proves no data exists.

Recovery:

- Archive catches up naturally.
- Pollers continue from durable height cursor.

UI/API behavior:

- Show live settlement as `settling` with `archiveConfirmed=false` until `outer-actions` confirms it.
- Do not block transaction/account pages.

### Archive-Node-API Missing `zkappCommands`

Impact:

- Bridge-event historical backfill is unavailable.
- Only live daemon bridge events and retained NATS events are available.

Watcher behavior:

- Start in reduced mode.
- Health `degraded`.
- Add limitation `historical_bridge_events_unavailable`.
- Set `bridgeBackfill.available=false`.
- Do not pretend bridge history is complete.

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

- Do not publish new data facts if they cannot be recorded durably.
- Keep dependency probes running.
- Keep `/healthz` serving local in-memory status.
- Health publication to NATS may continue only for service status, not data cursors.

Recovery:

1. Reconnect SurrealDB.
2. Reload durable cursors and block window.
3. Reconcile daemon `bestChain(290)`.
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
4. Query `bestChain(290)` when daemon is reachable.
5. Query archive tip when Archive-Node-API is reachable.
6. Resume archive pollers from durable cursors.
7. Publish rollback if persisted block window diverged from current best chain.

Unrecoverable condition:

- Bridge events missed during downtime are recoverable only if `zkappCommands` exists for the missed block range, NATS retained already-published bridge events, or daemon frontier still contains the missed blocks.

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
- Do not block pages.

### Bridge API or Explorer API Down

Impact:

- UI cannot fetch one API surface.

Watcher behavior:

- No change.

UI behavior:

- Render available page sections.
- Show API-specific unavailable state.
- Do not conflate API downtime with "no bridge operations".

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
| `outer_actions` | all outer-action messages for chunk have NATS ack and published IDs persisted | Archive API, NATS, or SurrealDB unavailable |
| `bridge_events` | all bridge-event messages for chunk have NATS ack and published IDs persisted | Archive API, NATS, SurrealDB, or missing `zkappCommands` |
| `daemon_window` | block window and any detected live facts are persisted | Daemon unavailable, NATS unavailable for new facts, SurrealDB unavailable |

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

- `l1_daemon_unavailable`
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
- Batch pages render known settlement state and stale finality warnings if daemon is down.
- Account pages render indexed transactions/actions and show freshness warnings for degraded sources.
- Search results can return partial records with warnings.

Do not use global loading spinners for degraded L1 sources after the initial page shell loads. Show stale/partial state inline.

## Cucumber Scenarios

The acceptance coverage for this fault-tolerance contract lives in:

- [Dependency startup resilience](../test-scenarios/dependency-startup.feature)
- [Mina daemon and archive recovery](../test-scenarios/daemon-and-archive-recovery.feature)
- [Durable publication failure handling](../test-scenarios/durable-publication-failures.feature)
- [Watcher restart and reorganization recovery](../test-scenarios/watcher-restart-and-reorg.feature)
- [Downstream service downtime](../test-scenarios/downstream-service-downtime.feature)
- [Partial bridge data UI behavior](../test-scenarios/partial-bridge-data-ui.feature)

These scenarios are the implementation target. They should be backed by recorded daemon/archive fixtures plus controllable doubles for NATS, SurrealDB, Archive-Node-API, the hosted Mina daemon, the indexer, the explorer API, and the frontend.
