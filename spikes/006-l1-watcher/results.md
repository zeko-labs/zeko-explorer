# Spike 006: L1 Watcher - Results

**Status:** Complete
**Date:** 2026-05-07

---

## Implementer Summary

Build `packages/l1-watcher` as the TypeScript component that reads L1 settlement-chain data through a provider adapter and publishes normalized L1 facts to NATS. Each network stack runs its own explorer backend stack; within that stack, the L1 Watcher uses the adapter for that network's L1.

The L1 Watcher publishes:

- `zeko.l1.settlements`: Zeko batch settlement commits and finalized updates.
- `zeko.l1.outer-actions`: raw and parsed commit/witness actions from `OUTER_PK`.
- `zeko.l1.bridge-events`: deposit submissions, withdrawal finalizations, and deposit cancellations with user keys and bridge params.
- `zeko.l1.rollbacks`: L1 reorgs that orphan already-published L1 facts.
- `zeko.health`: watcher freshness, lag, and dependency status.

The component has shared responsibilities and provider-specific adapters:

| Area | Owner |
|---|---|
| Process lifecycle, config, health, NATS publication, durable cursor/state writes, retry/backoff | L1 Watcher |
| Mina daemon and Archive-Node-API queries, Mina action/account-update decoding, Zeko-M finality and reorg interpretation | Zeko-M / Mina adapter |
| Ethereum JSON-RPC/archive queries, Ethereum event/log decoding, Zeko-E finality model | Zeko-E / Ethereum adapter |

This spike specifies the L1 Watcher component boundary, fully details the Zeko-M / Mina adapter needed for Milestone 1, and records the Zeko-E / Ethereum adapter shape required by the PRD for Milestone 4.

The implementation spec, message schemas, adapter types, fault-tolerance behavior, and archive-reader requirement are split out:

- [Implementation spec](addendums/implementation-spec.md)
- [NATS event schemas](addendums/nats-event-schemas.md)
- [L1 adapter interfaces](addendums/l1-adapter-interfaces.ts)
- [Fault tolerance and recovery](addendums/fault-tolerance.md)
- [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md)
- [Cucumber test scenarios](test-scenarios)

---

## Final Design

### L1 Watcher Component

The L1 Watcher consumes two L1 data sources through its active adapter:

- **L1 live node:** canonical tip, block orphaning/reorg detection, live settlement and bridge transactions.
- **L1 archive:** historical action/event data and catch-up after downtime.

The watcher normalizes adapter output into the common `zeko.l1.*` subjects, records durable cursor state in SurrealDB, and exposes `/healthz`.

```
packages/l1-watcher
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
        mina-bridge-decoder.ts
        mina-action-decoder.ts
        mina-reorg-detector.ts
      ethereum/
        README.md
    health/
      health-server.ts
      heartbeat.ts
```

The system API reads freshness from `sync_status`.

### Zeko-M / Mina Adapter

Milestone: 1.

Inputs:

1. Hosted Mina daemon GraphQL for live best-chain blocks, recent account updates, and reorg detection.
2. Public Archive-Node-API GraphQL for historical catch-up.

Adapter responsibilities:

- Query `bestChain(290)` and reconcile canonical block windows.
- Use daemon subscriptions as wake-up signals for live processing.
- Read `OUTER_PK` actions through Archive-Node-API `actions`.
- Decode Mina account updates, actions, events, app state, and preconditions.
- Detect Zeko-M settlement commits, outer actions, bridge events, and L1 rollbacks.
- Apply Mina finality semantics: `finalized` at `confirmationDepth >= 290`.
- Verify helper-account cancel counter progress for cancelled deposits.

Current Archive-Node-API supports `OUTER_PK` actions. Historical bridge-event detection also needs full zkApp command account updates by block range, so Milestone 1 needs an upstream Archive-Node-API change. The proposed upstream PR shape is documented in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).

### Zeko-E / Ethereum Adapter

Milestone: 4.

Inputs:

1. Ethereum JSON-RPC live/head access for canonical chain tracking, settlement transactions, bridge events, and reorg/finality signals.
2. Ethereum archive access for historical logs/transactions and catch-up after downtime.

Adapter responsibilities:

- Implement the same L1 Watcher adapter boundary as the Mina adapter.
- Publish the same common `zeko.l1.*` event families where they apply.
- Map Ethereum settlement transactions and bridge events into the shared domain model.
- Define the Zeko-E finality model using Ethereum-specific confirmation/finality semantics.
- Provide rollback/reorg facts in the `zeko.l1.rollbacks` contract consumed by the indexer.

Milestone 4 design inputs: Ethereum contract addresses, event ABI mappings, archive provider choice, and finality thresholds.

### Durable State

Use SurrealDB for watcher state and heartbeat state.

Required state records:

| Record | Purpose |
|---|---|
| `l1_watcher_cursor:outer_actions:{network}` | Last archive height fully published to `zeko.l1.outer-actions`. |
| `l1_watcher_cursor:bridge_events:{network}` | Last archive height fully scanned for bridge events through Archive-Node-API. |
| `l1_watcher_block:{network}:{block_hash}` | Rolling canonical block window used for reorg detection. Mina uses state hash as `block_hash`. |
| `l1_watcher_published:{network}:{event_id}` | Published L1 fact IDs with block hash, type, and NATS subject. |
| `sync_status:l1-watcher:{network}` | Health/freshness row consumed by APIs and status UI. |

Cursor rule: publish to NATS, wait for JetStream ack, then advance cursor. If SurrealDB is unavailable, the watcher must publish degraded health and stop advancing data streams.

### L1 Watcher Runtime Loops

Each network stack runs its own watcher instance. Inside that instance, the loops use independent retry/backoff so one failed dependency degrades only the work that needs it. NATS or SurrealDB outages pause data publication and cursor advancement while health remains available.

| Loop | Interval/source | Responsibility |
|---|---|---|
| Tip reconciler | Adapter wake-ups plus 15s poll | Query the adapter canonical chain window, detect reorgs, process new live blocks/logs, update settlement confirmation depth. |
| Outer action poller | 15s archive poll | Zeko-M: query Archive-Node-API `actions(OUTER_PK)`, parse commit/witness actions, publish `zeko.l1.outer-actions`, backfill missed settlement commits. Zeko-E: implement the equivalent settlement/log archive scan in Milestone 4. |
| Bridge event backfill poller | 15s archive poll | Zeko-M: query Archive-Node-API `zkappCommands`, detect deposits/withdrawals/cancels historically, publish `zeko.l1.bridge-events`. Zeko-E: query archive logs/events for the configured bridge contracts in Milestone 4. |
| Helper counter verifier | Every 10 Mina daemon blocks | Zeko-M only: read `helperAccountL1.zkappState[0]`; if it advanced without a matching cancel event, mark degraded and rescan recent blocks. |
| Health loop | 30s | Write `sync_status` and publish `zeko.health`. |

### Zeko-M Stack Configuration

For Milestone 1, the Zeko-M stack provides Mina endpoints and Zeko-M contract keys:

| Env var | Required | Meaning |
|---|---|---|
| `NATS_URL` | yes | JetStream endpoint. |
| `SURREALDB_URL` | yes | Durable watcher state and `sync_status`. |
| `SURREALDB_NAMESPACE` / `SURREALDB_DATABASE` | yes | Target namespace/database. |
| `MINA_DAEMON_GRAPHQL_URL` | yes | Hosted HTTP GraphQL endpoint for `bestChain`, `account`, etc. |
| `MINA_DAEMON_GRAPHQL_WS_URL` | yes | GraphQL subscription endpoint. |
| `MINA_ARCHIVE_API_URL` | yes | Archive-Node-API endpoint for actions/events/network state. |
| `OUTER_PK` | yes | Zeko outer L1 contract public key. |
| `HELPER_ACCOUNT_L1_PK` | yes | L1 helper account used for cancel counter checks. |
| `FINALITY_DEPTH` | default `290` | Mina finality depth used for `finalized`. |
| `POLL_INTERVAL_MS` | default `15000` | Daemon/archive polling interval. |
| `HEARTBEAT_INTERVAL_MS` | default `30000` | Health heartbeat interval. |
| `ARCHIVE_CHUNK_SIZE` | default `10000` | Must not exceed Archive-Node-API block range cap. |

### Zeko-E Stack Configuration

For Milestone 4, the Zeko-E stack supplies Ethereum live and archive access plus the contract/event configuration for settlement and bridge detection. Exact env var names should be selected when the Ethereum adapter is implemented, but they map to the same categories as Zeko-M: NATS, SurrealDB, live L1 endpoint, archive L1 endpoint, settlement contract config, bridge contract config, finality threshold, poll interval, heartbeat interval, and archive chunk size.

Container readiness:

- Ready after static config is valid and the process can serve `/healthz`. Dependency outages are reported as degraded/down health while the process remains alive.
- Healthy if all dependencies are reachable and both archive cursors are near archive tip.
- Degraded if the live L1 endpoint or archive L1 endpoint is down, archive lag exceeds threshold, helper cancel counter mismatch exists, or bridge backfill cannot run.

---

## Required Implementation Order

1. Create `packages/l1-watcher` with config, NATS publisher, SurrealDB state store, health endpoint, and the shared `L1Adapter` boundary.
2. Implement Mina daemon client:
   - `bestChain(maxLength: 290)`
   - `account(publicKey)`
   - `newBlock` subscription
   - `chainReorganization` subscription
3. Implement reorg detector over persisted canonical block window.
4. Implement settlement detection from daemon account updates on `OUTER_PK`.
5. Implement Archive-Node-API outer action poller for `actions(OUTER_PK)`.
6. Implement Archive-Node-API `zkappCommands` client. This requires the upstream API change described in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).
7. Implement bridge decoders:
   - deposit submission from signed user account update action shape
   - withdrawal finalization from outer witness plus finalize-withdrawal event
   - cancel deposit from helper counter advancement and cancel transaction pattern
8. Implement helper counter verifier.
9. Keep an `adapters/ethereum` package boundary for the Milestone 4 Zeko-E adapter so the shared watcher lifecycle, publication, state, and health code do not embed Mina-specific assumptions.
10. Implement the Cucumber scenarios in [test-scenarios](test-scenarios) using recorded daemon/archive fixtures and fault-injection doubles:
   - [settlements-and-outer-actions.feature](test-scenarios/settlements-and-outer-actions.feature)
   - [bridge-event-detection.feature](test-scenarios/bridge-event-detection.feature)
   - [dependency-startup.feature](test-scenarios/dependency-startup.feature)
   - [daemon-and-archive-recovery.feature](test-scenarios/daemon-and-archive-recovery.feature)
   - [durable-publication-failures.feature](test-scenarios/durable-publication-failures.feature)
   - [watcher-restart-and-reorg.feature](test-scenarios/watcher-restart-and-reorg.feature)
   - [downstream-service-downtime.feature](test-scenarios/downstream-service-downtime.feature)
   - [partial-bridge-data-ui.feature](test-scenarios/partial-bridge-data-ui.feature)

---

## Exact Behavior

### Settlements

A settlement is a commit action on `OUTER_PK`:

| Action index | Meaning |
|---:|---|
| 0 | `"0"` commit discriminant |
| 1 | committed inner ledger hash |
| 2 | inner action state |
| 3 | inner action state length |
| 4 | synchronized outer action state |
| 5 | synchronized outer action state length |
| 6 | slot range lower |
| 7 | slot range upper |

Detection:

- Live path: daemon block -> successful zkApp command -> account update where `body.publicKey === OUTER_PK` -> action with `fields[0] === "0"`.
- Historical path: Archive-Node-API `actions(input: { address: OUTER_PK, status: ALL, from, to })`.

The watcher publishes `zeko.l1.settlements` when a settlement is first seen and when the finality level changes. `finalized` means `confirmationDepth >= 290`. Depths `0..289` remain `settling`.

The watcher publishes the commit's `innerActionState` and `innerActionStateLength`. The indexer walks the indexed L2 inner action chain to associate bridge operations and transactions with the batch.

### Outer Actions

The outer action poller publishes every action emitted by `OUTER_PK`:

- `fields[0] === "0"` -> `commit`
- `fields[0] === "1"` -> `witness`
- anything else -> `unknown`, with degraded health

The poller chunks archive ranges by `ARCHIVE_CHUNK_SIZE`, sorts deterministically, publishes all actions, then advances `outer_actions` cursor only after NATS ack.

### Bridge Events

The watcher publishes bridge facts, not bridge operation lifecycle state. The indexer owns lifecycle transitions and `aux_sequence`.

Deposit submission:

- Source: signed user account update action, not an `OUTER_PK` action.
- Match: action has 8 fields and fields 6-7 reconstruct configured `OUTER_PK`.
- Decode: recipient, amount, timeout, holder account.
- `userPk`: signed account update public key.
- `aux`: `depositAux(holderAccountL1, amount, recipient, timeout)`.

Withdrawal finalization:

- Source: L1 transaction that emits outer witness action on `OUTER_PK` and finalize-withdrawal event fields.
- Decode recipient and amount from finalize event.
- Verify `withdrawalAux(amount, recipient) === witness.action[1]`.
- `userPk`: signed finalizer account update if present, otherwise fee payer with `userPkSource: "fee_payer"`.

Cancel deposit:

- Source: L1 transaction that advances `helperAccountL1.zkappState[0]`.
- There is no outer witness action for cancel.
- Detect helper counter transition and confirm the transaction includes the expected outer-account precondition witness.
- Publish `cancelledDepositIndex`; include `aux` only if params are available from the transaction. The indexer can resolve by FIFO deposit order.

### Rollbacks

The watcher owns L1 rollback detection.

Algorithm:

1. Persist every observed best-chain block in a rolling 290+ block window.
2. On every tip wake-up, query `bestChain(290)`.
3. Find the latest common state hash between old and new windows.
4. Blocks after the common hash in the old window are orphaned.
5. Query `l1_watcher_published` for facts whose `block_hash` is orphaned.
6. Publish one `zeko.l1.rollbacks` message listing affected settlement, outer-action, and bridge-event IDs.
7. Process replacement blocks normally.

If no common ancestor exists in the daemon window, the watcher cannot fully prove bridge-event reconciliation from current Archive-Node-API alone. That is why the upstream `zkappCommands` query is a Milestone 1 requirement.

---

## Historical Bridge Event Gap

The current Archive-Node-API `blocks` query returns zkApp command hashes, fee payer, status, and memo. Historical bridge reconstruction also needs account update actions/events/app state/preconditions, because deposit and cancel detection require those details.

If this is not fixed upstream, the watcher can still run but only with these guarantees:

- `zeko.l1.outer-actions` remains rebuildable from Archive-Node-API `actions(OUTER_PK)`.
- `zeko.l1.settlements` remains rebuildable from those outer commit actions.
- `zeko.l1.bridge-events` becomes live-only from the daemon frontier and NATS retention. It cannot be rebuilt from genesis, from periods before the watcher existed, or from watcher downtime after the missed blocks leave the daemon frontier.
- Any watcher downtime can therefore create an unfillable bridge-event gap unless the missed blocks are still in the hosted daemon frontier or the events had already been published and retained in NATS.
- Per-user deposit history will be incomplete for pre-watcher deposits and for any downtime gap. The bridge API can only show operations that were observed live or were still visible in retained NATS.
- Cancel deposit history is the weakest case: cancels do not emit outer witness actions, so archive action scans cannot recover them.
- A long watcher outage beyond the daemon frontier leaves bridge-event gaps that cannot be repaired from the public APIs.

Decision for Milestone 1:

Use upstream Archive-Node-API with a `zkappCommands(input)` query that returns full account update actions/events/app state/preconditions. The exact required query shape and PR implementation plan are specified in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).

---

## Fault Tolerance Requirements

The watcher and downstream explorer must treat all L1 inputs as unreliable. External service failures must be graceful:

- Hosted Mina daemon down: archive pollers continue, finality becomes stale, health degrades, no crash.
- Archive-Node-API down: live daemon processing continues, archive cursors stop advancing, health degrades, no crash.
- NATS down: data publication and cursor advancement pause; process stays alive.
- SurrealDB down: data publication pauses because cursors cannot be persisted; process stays alive.
- Watcher restart: reload cursors, reconcile daemon best chain, then resume archive catch-up.
- Indexer/API/UI downtime: watcher continues publishing; UI renders stale/partial data instead of blocking.

If bridge-related data is missing, the API must expose data quality metadata and the UI must render partial records with clear warnings. Missing `zeko.l1.bridge-events` must never block account, bridge operation, batch, or transaction pages.

The full failure matrix and UI/API degradation contract are in [Fault tolerance and recovery](addendums/fault-tolerance.md).

---

## Implementation Notes That Matter

- Use `chainReorganization` only as a wake-up signal. The rollback truth comes from comparing `bestChain(290)` state hashes.
- Subscribe broadly enough to observe user account updates, not only `newBlock(publicKey: OUTER_PK)`, because deposit submissions are user account actions whose payload mentions `OUTER_PK`.
- Leave `aux_sequence` assignment to the indexer, which derives it from durable bridge operation ordering.
- Advance cursors only after NATS ack.
- Pause new data facts while SurrealDB state writes fail. Publishing without durable state creates unbounded duplicate or missing publication risk. The process still stays alive and reports degraded/down health.
- Publish raw fields along with parsed fields. This protects the indexer from decoder bugs and supports later reprocessing.
- Treat unknown outer action discriminants and helper counter mismatches as degraded health, not silent skips.

---

## Source Verification

Verified against:

- Mina daemon GraphQL schema: `bestChain`, `block`, `newBlock`, `chainReorganization`, `account`, `ZkappCommand.accountUpdates`, and `AccountUpdateBody.actions/events/appState/preconditions`.
- Archive-Node-API schema: `actions`, `events`, `networkState`, block range cap, action-state filters, and `blocks` output limitations.
- `PRD.md` L1 Watcher, bridge, rollback, finality, and deployment structure sections.
- `spikes/002-bridge-correlation/results.md` for `aux`, user key, cancel observability, and bridge lifecycle constraints.
- `spikes/003-zkapp-state-display/results.md` for Mina action/event/state field behavior.
