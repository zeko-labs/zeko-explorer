# Spike 006: L1 Watcher - Results

**Status:** Complete
**Date:** 2026-05-07

---

## Implementer Summary

Build `packages/l1-watcher` as the TypeScript component that runs inside one network's explorer stack and publishes normalized L1 facts to that stack's NATS instance. The watcher does not encode a single settlement-chain implementation. It delegates provider-specific L1 reads and decoding to the adapter selected for that network.

The shared L1 Watcher owns:

- process lifecycle, config loading, health, retry/backoff, and graceful degradation;
- NATS publication and JetStream acknowledgement handling;
- SurrealDB durable state for cursors, canonical block windows, published fact IDs, and `sync_status`;
- common `zeko.l1.*` event contracts;
- rollback fact publication after an adapter reports canonical-chain divergence.

The provider adapters own:

| Network family | Adapter | Milestone | Adapter owns |
|---|---|---:|---|
| Zeko-M | Mina adapter | 1 | Mina daemon and Archive-Node-API reads, Mina action/account-update/event decoding, Zeko-M finality and rollback interpretation. |
| Zeko-E | Ethereum adapter | 4 | Ethereum JSON-RPC/archive reads, Ethereum log/transaction decoding, Zeko-E finality and reorg interpretation. |

Common output subjects:

- `zeko.l1.settlements`: settlement detections and finality updates.
- `zeko.l1.rollbacks`: L1 reorg facts that reference affected published L1 facts.
- `zeko.l1.bridge-events`: bridge operation facts with user keys, params, and L1 identity.
- `zeko.health`: watcher freshness, lag, dependency status, and source limitations.

Provider-specific output subjects:

- `zeko.l1.outer-actions`: Zeko-M / Mina Commit and Witness actions from `OUTER_PK`. The Ethereum adapter should only emit this subject if Milestone 4 defines an equivalent outer-action domain fact.

This spike fully specifies the Zeko-M / Mina adapter needed for Milestone 1. It defines only the shared adapter boundary and required design inputs for the future Zeko-E / Ethereum adapter in Milestone 4.

Supporting artifacts:

- [Implementation spec](addendums/implementation-spec.md)
- [NATS event schemas](addendums/nats-event-schemas.md)
- [L1 adapter interfaces](addendums/l1-adapter-interfaces.ts)
- [Fault tolerance and recovery](addendums/fault-tolerance.md)
- [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md)
- [Cucumber test scenarios](test-scenarios)

---

## L1 Watcher Component

The L1 Watcher consumes provider facts through the active adapter and publishes normalized events. It should not contain Mina-specific or Ethereum-specific chain logic outside the adapter boundary.

Shared package shape:

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

### Shared Runtime Contract

Each network stack runs its own watcher instance. The active adapter supplies:

- a live L1 endpoint for canonical-chain hints and near-tip observations;
- an archive L1 endpoint for historical catch-up;
- provider-specific decoders for settlements, bridge events, and rollback inputs;
- provider-specific finality semantics.

The shared watcher code handles:

- one `/healthz` endpoint;
- periodic `zeko.health` publication;
- JetStream publish acknowledgement handling;
- durable cursor advancement only after publish acknowledgement and state write;
- independent retry/backoff per dependency and loop;
- bounded in-memory buffering only for short publish interruptions;
- process survival during transient dependency outages.

### Shared Durable State

Use SurrealDB for watcher state and heartbeat state.

Required state records:

| Record | Purpose |
|---|---|
| `l1_watcher_cursor:{network}:{cursor_name}` | Adapter-owned archive/live progress cursors. Zeko-M uses at least `outer_actions` and `bridge_events`. |
| `l1_watcher_block:{network}:{block_hash}` | Rolling canonical block window used for reorg detection. Mina stores the Mina state hash as `block_hash`; Ethereum stores the Ethereum block hash. |
| `l1_watcher_published:{network}:{event_id}` | Published L1 fact IDs with subject, provider, block hash, tx hash, and publish timestamp. |
| `sync_status:l1-watcher:{network}` | Health/freshness row consumed by APIs and status UI. |

Shared cursor rule: publish to NATS, wait for JetStream ack, persist published IDs/cursor state, then advance the cursor. If SurrealDB is unavailable, data publication pauses and health degrades while the process remains alive.

### Shared Runtime Loops

The shared watcher schedules loops, but adapter-specific work stays in the adapter.

| Loop | Shared responsibility | Adapter responsibility |
|---|---|---|
| Tip reconciler | Wake on adapter hint or poll, call adapter canonical-chain read, compare persisted block window, publish rollback facts for orphaned published IDs. | Read canonical chain window, provide provider block hashes, interpret provider finality/reorg data. |
| Archive catch-up | Resume from durable cursor, publish facts in deterministic order, advance cursor after ack/state write. | Read historical provider data and decode provider facts. |
| Bridge event backfill | Resume from durable bridge cursor, publish bridge facts in deterministic order. | Provide enough historical bridge data for that provider. |
| Provider consistency checks | Record adapter health and limitations. | Run provider-specific checks such as Mina helper counter verification. |
| Health loop | Write `sync_status` and publish `zeko.health`. | Report live/archive source health, lag, and provider limitations. |

### Shared Fault Tolerance Requirements

All L1 inputs are unreliable. The watcher and downstream explorer must handle failures without hard process crashes and without blocking unrelated UI.

Required behavior:

- Live L1 endpoint down: live finality/reorg processing pauses; archive catch-up continues if archive is reachable.
- Archive L1 endpoint down: historical catch-up pauses; live processing continues if the live endpoint is reachable.
- NATS down: data publication and cursor advancement pause.
- SurrealDB down: data publication pauses because durable state cannot be updated.
- Watcher restart: reload cursors and canonical block window before resuming.
- Indexer/API/UI downtime: watcher continues publishing when NATS/SurrealDB are available; UI renders stale or partial data instead of blocking.
- Missing bridge-related data must surface through API data-quality metadata and inline UI warnings.

The full failure matrix and UI/API degradation contract are in [Fault tolerance and recovery](addendums/fault-tolerance.md).

---

## Zeko-M / Mina Adapter

Milestone: 1.

This section is the implementer handoff for the Milestone 1 adapter. Statements in this section are specific to Zeko-M / Mina unless explicitly called out as shared watcher behavior.

### Inputs

1. Hosted Mina daemon GraphQL for live best-chain blocks, recent account updates, account state, and reorg wake-up signals.
2. Public Archive-Node-API GraphQL for historical catch-up.

### Responsibilities

- Query `bestChain(290)` and reconcile canonical block windows.
- Use Mina daemon subscriptions as wake-up signals for live processing.
- Read `OUTER_PK` actions through Archive-Node-API `actions`.
- Decode Mina account updates, actions, events, app state, and preconditions.
- Detect Zeko-M settlement commits, outer actions, bridge events, and L1 rollbacks.
- Apply Mina finality semantics: `finalized` at `confirmationDepth >= 290`.
- Verify helper-account cancel counter progress for cancelled deposits.

Current Archive-Node-API supports `OUTER_PK` actions. Historical Zeko-M bridge-event detection also needs full zkApp command account updates by block range, so Milestone 1 needs an upstream Archive-Node-API change. The proposed upstream PR shape is documented in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).

### Runtime Loops

| Loop | Interval/source | Zeko-M / Mina behavior |
|---|---|---|
| Tip reconciler | `newBlock` / `chainReorganization` wake-ups plus 15s poll | Query `bestChain(290)`, detect reorgs, process new daemon blocks, update settlement confirmation depth. |
| Outer action poller | 15s Archive-Node-API poll | Query `actions(OUTER_PK)`, parse commit/witness actions, publish `zeko.l1.outer-actions`, backfill missed settlement commits. |
| Bridge event backfill poller | 15s Archive-Node-API poll | Query `zkappCommands`, detect deposits/withdrawals/cancels historically, publish `zeko.l1.bridge-events`. |
| Helper counter verifier | Every 10 Mina daemon blocks | Read `helperAccountL1.zkappState[0]`; if it advanced without a matching cancel event, mark degraded and rescan recent blocks. |

### Stack Configuration

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

Container readiness:

- Ready after static config is valid and the process can serve `/healthz`.
- Healthy if all required dependencies are reachable and archive cursors are near archive tip.
- Degraded if the Mina daemon or Archive-Node-API is down, archive lag exceeds threshold, helper cancel counter mismatch exists, or bridge backfill cannot run.

### Implementation Order

1. Create `packages/l1-watcher` with config, NATS publisher, SurrealDB state store, health endpoint, and shared `L1Adapter` boundary.
2. Implement Mina daemon client:
   - `bestChain(maxLength: 290)`
   - `account(publicKey)`
   - `newBlock` subscription
   - `chainReorganization` subscription
3. Implement Mina reorg detector over the persisted canonical block window.
4. Implement settlement detection from Mina daemon account updates on `OUTER_PK`.
5. Implement Archive-Node-API outer action poller for `actions(OUTER_PK)`.
6. Implement Archive-Node-API `zkappCommands` client. This requires the upstream API change described in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).
7. Implement Mina bridge decoders:
   - deposit submission from signed user account update action shape;
   - withdrawal finalization from outer witness plus finalize-withdrawal event;
   - cancel deposit from helper counter advancement and cancel transaction pattern.
8. Implement helper counter verifier.
9. Keep an `adapters/ethereum` package boundary for the Milestone 4 Zeko-E adapter so the shared watcher lifecycle, publication, state, and health code does not embed Mina-specific assumptions.
10. Implement the Cucumber scenarios in [test-scenarios](test-scenarios) using recorded Mina daemon/archive fixtures and fault-injection doubles:
    - [settlements-and-outer-actions.feature](test-scenarios/settlements-and-outer-actions.feature)
    - [bridge-event-detection.feature](test-scenarios/bridge-event-detection.feature)
    - [dependency-startup.feature](test-scenarios/dependency-startup.feature)
    - [daemon-and-archive-recovery.feature](test-scenarios/daemon-and-archive-recovery.feature)
    - [durable-publication-failures.feature](test-scenarios/durable-publication-failures.feature)
    - [watcher-restart-and-reorg.feature](test-scenarios/watcher-restart-and-reorg.feature)
    - [downstream-service-downtime.feature](test-scenarios/downstream-service-downtime.feature)
    - [partial-bridge-data-ui.feature](test-scenarios/partial-bridge-data-ui.feature)

### Settlement Detection

A Zeko-M settlement is a commit action on `OUTER_PK`:

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

- Live path: Mina daemon block -> successful zkApp command -> account update where `body.publicKey === OUTER_PK` -> action with `fields[0] === "0"`.
- Historical path: Archive-Node-API `actions(input: { address: OUTER_PK, status: ALL, from, to })`.

The Mina adapter publishes `zeko.l1.settlements` when a settlement is first seen and when the finality level changes. `finalized` means `confirmationDepth >= 290`. Depths `0..289` remain `settling`.

The adapter publishes the commit's `innerActionState` and `innerActionStateLength`. The indexer walks the indexed L2 inner action chain to associate bridge operations and transactions with the batch.

### Outer Actions

The Zeko-M outer action poller publishes every action emitted by `OUTER_PK`:

- `fields[0] === "0"` -> `commit`
- `fields[0] === "1"` -> `witness`
- anything else -> `unknown`, with degraded health

The poller chunks archive ranges by `ARCHIVE_CHUNK_SIZE`, sorts deterministically, publishes all actions, then advances the `outer_actions` cursor only after NATS ack and durable state write.

### Bridge Events

The Mina adapter publishes bridge facts, not bridge operation lifecycle state. The indexer owns lifecycle transitions and `aux_sequence`.

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

The Mina adapter supplies rollback inputs from Mina canonical-chain reconciliation.

Algorithm:

1. Persist every observed Mina best-chain block in a rolling 290+ block window.
2. On every tip wake-up, query `bestChain(290)`.
3. Find the latest common state hash between old and new windows.
4. Blocks after the common hash in the old window are orphaned.
5. Query `l1_watcher_published` for facts whose `block_hash` is orphaned.
6. Publish one `zeko.l1.rollbacks` message listing affected settlement, outer-action, and bridge-event IDs.
7. Process replacement blocks normally.

If no common ancestor exists in the daemon window, the Mina adapter cannot fully prove bridge-event reconciliation from current Archive-Node-API alone. That is why the upstream `zkappCommands` query is a Milestone 1 requirement.

### Historical Bridge Event Gap

The current Archive-Node-API `blocks` query returns zkApp command hashes, fee payer, status, and memo. Historical Zeko-M bridge reconstruction also needs account update actions/events/app state/preconditions, because deposit and cancel detection require those details.

If this is not fixed upstream, the Zeko-M / Mina adapter can still run but only with these guarantees:

- `zeko.l1.outer-actions` remains rebuildable from Archive-Node-API `actions(OUTER_PK)`.
- `zeko.l1.settlements` remains rebuildable from those outer commit actions.
- Zeko-M `zeko.l1.bridge-events` becomes live-only from the daemon frontier and NATS retention. It cannot be rebuilt from genesis, from periods before the watcher existed, or from watcher downtime after the missed blocks leave the daemon frontier.
- Any Zeko-M watcher downtime can therefore create an unfillable bridge-event gap unless the missed blocks are still in the hosted daemon frontier or the events had already been published and retained in NATS.
- Per-user deposit history will be incomplete for pre-watcher deposits and for any downtime gap. The bridge API can only show operations that were observed live or were still visible in retained NATS.
- Cancel deposit history is the weakest case: cancels do not emit outer witness actions, so archive action scans cannot recover them.
- A long Zeko-M watcher outage beyond the daemon frontier leaves bridge-event gaps that cannot be repaired from current public APIs.

Decision for Milestone 1:

Use upstream Archive-Node-API with a `zkappCommands(input)` query that returns full account update actions/events/app state/preconditions. The exact required query shape and PR implementation plan are specified in [Archive-Node-API zkApp command query requirement](addendums/archive-account-update-reader.md).

### Zeko-M Fault Findings

- Hosted Mina daemon down: Archive-Node-API pollers continue, finality becomes stale, health degrades, process stays alive.
- Archive-Node-API down: live daemon processing continues, archive cursors stop advancing, health degrades, process stays alive.
- Watcher restart: reload cursors, reconcile Mina `bestChain(290)`, then resume archive catch-up.
- Missing Zeko-M bridge-related data must not block account, bridge operation, batch, or transaction pages.

### Zeko-M Implementation Notes That Matter

- Use `chainReorganization` only as a wake-up signal. The rollback truth comes from comparing `bestChain(290)` state hashes.
- Subscribe broadly enough to observe user account updates, not only `newBlock(publicKey: OUTER_PK)`, because deposit submissions are user account actions whose payload mentions `OUTER_PK`.
- Leave `aux_sequence` assignment to the indexer, which derives it from durable bridge operation ordering.
- Advance cursors only after NATS ack and durable state write.
- Publish raw fields along with parsed fields. This protects the indexer from decoder bugs and supports later reprocessing.
- Treat unknown outer action discriminants and helper counter mismatches as degraded health, not silent skips.

---

## Zeko-E / Ethereum Adapter

Milestone: 4.

This spike does not specify Ethereum contract details or Ethereum decoding rules. It only preserves the shared watcher boundary so the Milestone 1 implementation does not make Mina assumptions in shared code.

### Inputs

1. Ethereum JSON-RPC live/head access for canonical chain tracking, settlement transactions, bridge events, and reorg/finality signals.
2. Ethereum archive/log access for historical logs/transactions and catch-up after downtime.

### Responsibilities

- Implement the shared `L1Adapter` boundary without relying on Mina daemon or Archive-Node-API behavior.
- Publish shared `zeko.l1.*` event families where the Ethereum domain model applies.
- Map Ethereum settlement transactions into `zeko.l1.settlements`.
- Map Ethereum bridge contract logs/transactions into `zeko.l1.bridge-events`.
- Provide rollback/reorg facts through `zeko.l1.rollbacks`.
- Report Ethereum live/archive health and limitations through `zeko.health`.
- Define whether `zeko.l1.outer-actions` has an Ethereum equivalent; otherwise leave that subject Mina-only.

### Required Milestone 4 Design Inputs

- Ethereum settlement contract addresses.
- Ethereum bridge contract addresses.
- Event ABI mappings.
- Archive provider choice and historical query guarantees.
- Finality threshold.
- Reorg depth policy.
- Ethereum-specific payload fields needed by APIs and indexers.

### Zeko-E Fault Requirements

The Ethereum adapter must follow the shared fault contract:

- live JSON-RPC outage pauses live head tracking, finality updates, and near-tip reorg detection;
- archive/log-source outage pauses historical catch-up;
- reconnection starts with canonical-chain reconciliation before publishing new facts;
- missed Ethereum bridge facts are recoverable only if the selected archive source can query the required historical logs/transactions for the missed range, or if the facts were already published and retained in NATS.

---

## Source Verification

Verified against:

- Mina daemon GraphQL schema: `bestChain`, `block`, `newBlock`, `chainReorganization`, `account`, `ZkappCommand.accountUpdates`, and `AccountUpdateBody.actions/events/appState/preconditions`.
- Archive-Node-API schema: `actions`, `events`, `networkState`, block range cap, action-state filters, and `blocks` output limitations.
- `PRD.md` L1 Watcher, bridge, rollback, finality, and deployment structure sections.
- `spikes/002-bridge-correlation/results.md` for `aux`, user key, cancel observability, and bridge lifecycle constraints.
- `spikes/003-zkapp-state-display/results.md` for Mina action/event/state field behavior.
