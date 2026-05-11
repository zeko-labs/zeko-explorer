# PRD: Zeko Block Explorer & Indexing Substrate

**Author:** Zeko Labs
**Status:** Draft v10 (post spikes 001, 002, 003, 006)
**Last Updated:** May 11, 2026

---

## 1. Executive Summary

Zeko currently relies on Zekoscan (third-party, Blockberry/Staketab), which suffers from reliability issues, stale data, and a complete lack of L2 concepts. Zeko has no control over its roadmap.

This document defines a **general-purpose indexing substrate** for the Zeko network and a **greenfield block explorer** as its first consumer. At the foundation, the sequencer publishes raw L2 events directly to NATS JetStream (with a standalone backfill service for gap filling from the DA layer), while TypeScript services monitor L1 and DA data sources. A unified indexer consumes all streams, normalizes data, and writes to SurrealDB. The explorer is exposed via a code-first GraphQL API (Pothos) with SSE subscriptions, a code-mode MCP server for agent interaction, and a Nuxt 3 SPA frontend. A separate Bridge GraphQL API replaces the existing bridge actions services.

The system replaces:
- The archive relay adapter + Mina archive node + Archive-Node-API + Zekoscan pipeline.
- The bridge actions indexer and API (see Section 5.3).

---

## 2. Problem Statement

### 2.1 Current Architecture

```
Zeko Sequencer → Archive Relay (OCaml) → Mina Archive Node (PostgreSQL)
    → Archive-Node-API (GraphQL) → Zekoscan UI
```

### 2.2 Analysis of the Mina Archive Database

The Mina archive schema is designed around L1 consensus:

**Fork handling poorly suited to Zeko.** `chain_status` enum (`canonical`/`orphaned`/`pending`) models L1 block-level forks. Zeko needs batch-level settlement status tracking with two specific rollback scenarios (Section 7.5).

**Hyper-normalized.** Public keys in separate table referenced by ID. zkApp state across 15+ tables. Optimized for L1 storage, not explorer reads.

**No L2 tables.** No batches, bridge operations, DA attestations, sequencer state, proof status.

### 2.3 Gaps Summary

- Data staleness with no signal.
- No L2 concepts in the explorer.
- Fragmented indexing infrastructure (separate pipelines for explorer and bridge).
- No rollback modeling for L1 settlement reversals or L2 state reverts.
- No control over explorer roadmap.
- No indexed per-user bridge operation history (current system does full archive scans per wallet).

---

## 3. Goals

1. **General-purpose indexing substrate** — NATS streams as shared event log, extensible consumers.
2. **Greenfield block explorer** replacing Zekoscan.
3. **Unified bridge indexing** — bridge data indexed by the same indexer, exposed via a dedicated API (see Section 5.3).
4. **Zeko-native data model** — "1 block = 1 transaction," batches, bridge actions, rollback states.
5. **Extreme reliability** with health monitoring, freshness indicators, self-healing.
6. **Extreme clarity about system status.**
7. **Multi-network**: Zeko-M (devnet, alphanet, mainnet), Zeko-E (testnet-x, mainnet).
8. **Real-time data.**
9. **Agent-first** via code-mode MCP server.
10. **TDD/DDD with Gherkin** acceptance tests.
11. **Future-ready** for public API and GraphQL federation.

---

## 4. Network Nomenclature

| Family | Network ID | Settlement Layer | Description |
|---|---|---|---|
| Zeko-M | `zeko-m-devnet` | Mina Devnet | Development |
| Zeko-M | `zeko-m-alphanet` | Mina Devnet/Mainnet | Pre-mainnet staging |
| Zeko-M | `zeko-m-mainnet` | Mina Mainnet | Production |
| Zeko-E | `zeko-e-testnet-1` | Ethereum Testnet | Ethereum testing |
| Zeko-E | `zeko-e-mainnet` | Ethereum Mainnet | Ethereum production |

Each network runs its own sequencer, DA layer, and **full explorer backend stack** (NATS, backfill service, indexer, SurrealDB, APIs). Full stack isolation per network — separate NATS and SurrealDB instances. No cross-network namespacing needed; the instance itself identifies the network.

---

## 5. Architecture

### 5.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Data Sources                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Zeko         │  │ L1 Live Node │  │ DA Layer              │  │
│  │ Sequencer    │  │ + L1 Archive │  │ (Ethermint/Celestia)  │  │
│  │ (publishes   │  │ (Mina or     │  │                       │  │
│  │  to NATS     │  │  Ethereum)   │  │                       │  │
│  │  directly)   │  │              │  │                       │  │
│  └──────┬───────┘  └──────┬───────┘  └───┬───────────┬───────┘  │
└─────────┼─────────────────┼──────────────┼───────────┼──────────┘
          │                 │              │           │
          │                 │              │           ▼
          │                 │              │  ┌─────────────────┐
          │                 │              │  │ Backfill Service │
          │                 │              │  │ (OCaml, standalone)
          │                 │              │  │ GraphQL API      │
          │                 │              │  │ DA → NATS        │
          │                 │              │  └────────┬────────┘
          │                 │              │           │
          │                 ▼              ▼           │
          │          ┌──────────────┐ ┌────────────┐  │
          │          │ L1 Watcher   │ │ DA Monitor │  │
          │          │ (TypeScript) │ │ (TS)       │  │
          │          └──────┬───────┘ └─────┬──────┘  │
          │                 │               │         │
          ▼                 ▼               ▼         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     NATS JetStream                              │
│                 (indexing substrate)                             │
│                                                                 │
│  Streams (raw, unprocessed):                                    │
│  • zeko.l2.transactions    • zeko.l1.settlements                │
│  • zeko.l2.finality        • zeko.l1.rollbacks                  │
│  • zeko.l1.outer-actions   • zeko.l1.bridge-events              │
│  • zeko.da.attestations    • zeko.health                        │
│                                                                 │
│  Rolling retention (default 90d) + R2 archival                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Zeko Indexer                                 │
│                     (TypeScript)                                 │
│                                                                 │
│  Consumes all streams. Writes:                                  │
│  • Explorer data: transactions, accounts, batches, stats, ...   │
│  • Bridge data: outer_action, inner_action, bridge_operation    │
│  • zkApp data: events, actions                                  │
│  • Consumer-side rollback detection (hash chain continuity)     │
│  • Backfill integration (calls Backfill Service on gap detect)  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                SurrealDB (single node)                           │
│          (rebuildable read model — NATS is source of truth)     │
│                                                                 │
│  Tables: transaction, account, account_activity, batch,         │
│  zkapp_event, zkapp_action, outer_action, inner_action,         │
│  bridge_operation + graph edges (l1/l2_action_link),            │
│  sync_status, network_stats                                     │
└──────────────┬──────────────────────────┬───────────────────────┘
               │                          │
               ▼                          ▼
┌───────────────────────────┐  ┌──────────────────────────────────┐
│ Explorer GraphQL API      │  │ Bridge GraphQL API               │
│ (TypeScript, Pothos)      │  │ (TypeScript, Pothos)             │
│ SSE subscriptions         │  │ Replaces services/actions/api    │
│ Hosted on Hetzner         │  │ Hosted on Hetzner                │
│ Cloudflare reverse proxy  │  │ Cloudflare reverse proxy         │
└─────────┬─────────────────┘  └──────────────────────────────────┘
          │
          ├─────────────────────────────┐
          ▼                             ▼
┌──────────────────────────┐  ┌──────────────────────────────────┐
│ Explorer Frontend        │  │ Code-Mode MCP Server             │
│ (Nuxt 3 SPA)            │  │ (CF Worker, search + execute     │
│ CF Workers Static Assets │  │  with generated typed SDK)       │
│                          │  │ Calls public Cloudflare-proxied  │
│                          │  │  API                             │
└──────────────────────────┘  └──────────────────────────────────┘
```

### 5.2 Component Details

#### 5.2.1 Sequencer → NATS Publishing (OCaml, in sequencer repo)

The sequencer itself publishes diffs directly to NATS JetStream as a configurable option via `--nats-url`. No separate connector process. No DA layer in the read path. Publishing is fire-and-forget — if NATS is down, publishes are silently dropped and the sequencer continues normally. See `spikes/001-sequencer-connector/results.md` for the full spike investigation.

**Why direct publishing (not a standalone connector):** The DA layer communicates via OCaml binary RPC (`Daemon_rpcs`), not HTTP/JSON. A standalone connector would need the same OCaml deps, add 15-30s polling latency, and require its own checkpoint/recovery logic. Direct publishing is zero-latency, simpler, and provides better context (the sequencer already has the diff, target hash, and full transaction at the publish point).

**Three integration points** in `zeko_sequencer.ml`, each immediately after a `Da_layer.Client.enqueue_diff` call:

1. **User command processing** (`apply_user_command`, line 497) — primary transaction path. Publishes the diff + target hash + full command to `zeko.l2.transactions`.
2. **Fee transfer** (`apply_fee_transfer`, line 573) — sequencer fee collection. `command` is `null` in the diff.
3. **Genesis/sync diffs** (`sync`, line 804) — created during startup bootstrap from DA layer. Publishes historical diffs as they are replayed.

**Finality event publishing** at two additional points:

- **Proved:** After `run_committer` gets `Some (stmt, _)` (line 755) — publishes `stmt.target_ledger` as the proved hash to `zeko.l2.finality`.
- **Committed:** After `State.Last_committed_ledger.set` in `Merger.Commit.process` (line 184) — publishes `Sparse_ledger.merkle_root new_inner_ledger` as the committed hash to `zeko.l2.finality`.

**Health heartbeats** published periodically to `zeko.health`.

**Sequencer `t` record modification:** A `nats_client : Nats_client.t option` field is added. When `None` (no `--nats-url` flag), all publish calls are no-ops — fully backwards-compatible.

**Bootstrap:** On first startup with `--nats-url`, the sequencer's existing `sync` function replays all DA layer diffs. Each diff is published to NATS during this replay, populating the full history. No separate bootstrap step needed.

**Deduplication:** Each message includes a `Nats-Msg-Id: <target_ledger_hash>` header. JetStream deduplicates within a 2-minute window, handling sequencer restarts gracefully.

#### 5.2.1b Backfill Service (OCaml, standalone, in sequencer repo)

A lightweight standalone OCaml service that fills gaps in the NATS stream by fetching diffs from the DA layer on demand. Exposes a GraphQL API. Fits in a single file (~200 lines). See `spikes/001-sequencer-connector/results.md` Section 7 for full design.

**When it's needed:** If the sequencer restarts and there's a gap between pre-restart and post-restart messages in NATS, or if NATS was down while the sequencer was processing transactions, the indexer detects the gap via hash chain continuity and calls the backfill service.

**GraphQL API:**

- `mutation backfill(fromHash, toHash) → BackfillJob` — starts fetching diffs from DA layer for the hash range, publishes each to NATS.
- `subscription backfillProgress(id) → BackfillProgress` — SSE stream of progress events (`{status, diffsPublished, error}`).
- `query backfillJob(id) → BackfillJob` — check job status (for SSE reconnection).
- `query health → {ok, instanceId, startedAt}` — the `instanceId` (random UUID generated at startup) lets the indexer detect service restarts and re-submit lost jobs.

**Dependencies (all already in the zeko repo):** `da_layer`, `graphql-async`, `graphql_cohttp_async`, `cohttp-async`, `nats_client`, `async`, `core_kernel`, `yojson`.

**Job storage is in-memory** (`Hashtbl`). Jobs are short-lived. The `instanceId` mechanism handles restart recovery — no persistence needed.

**SSE transport:** Subscriptions use `Content-Type: text/event-stream` via `cohttp-async`. No WebSocket dependency.

**CLI flags:** `--nats-url`, `--da-node` (list), `-p` (HTTP port, default 8090).

**Deployment:** One instance per network. Same isolation as sequencer + NATS.

#### 5.2.2 L1 Watcher (TypeScript)

The L1 Watcher is the TypeScript component that reads the network's L1 settlement chain through a provider adapter and publishes normalized L1 facts into that network stack's NATS instance. Each Zeko network stack runs its own watcher instance alongside its own NATS, SurrealDB, APIs, and L1 endpoint access.

**Shared watcher responsibilities:**
- Process lifecycle, config validation, health endpoint, retry/backoff, and graceful degradation.
- NATS JetStream publication for `zeko.l1.*` subjects and `zeko.health`.
- Durable cursor/state writes in SurrealDB: archive cursors, canonical block window, published-fact IDs, and `sync_status`.
- L1 rollback publication as `zeko.l1.rollbacks` after adapter canonical-chain reconciliation.

**Provider adapter responsibilities:**

| Network family | Adapter | Milestone | Responsibilities |
|---|---|---:|---|
| Zeko-M | Mina adapter | 1 | Hosted Mina daemon GraphQL, public Archive-Node-API, Mina action/account-update/event decoding, `bestChain(290)` reconciliation, Zeko-M finality and rollback interpretation. |
| Zeko-E | Ethereum adapter | 4 | Ethereum JSON-RPC/archive access, Ethereum settlement and bridge log/transaction decoding, Ethereum-specific finality and reorg interpretation. |

**L1 connections per adapter:**
- **Live L1 endpoint:** tracks canonical tip, provides live settlement/bridge observations, and supports reorg detection. For Zeko-M this is the hosted Mina daemon GraphQL API. For Zeko-E this is Ethereum JSON-RPC.
- **Archive L1 endpoint:** provides historical action/event/log data and catch-up after downtime. For Zeko-M this is Archive-Node-API. For Zeko-E this is the Ethereum archive/log source selected in Milestone 4.

**Publishes to:**
- `zeko.l1.settlements` — settlement detections and finality updates.
- `zeko.l1.rollbacks` — L1 block orphan/reorg facts that reference affected published fact IDs.
- `zeko.l1.outer-actions` — Zeko-M Commit/Witness actions from `OUTER_PK`. Zeko-E emits settlement and bridge facts through the shared settlement/bridge subjects unless its adapter defines an equivalent outer-action domain fact.
- `zeko.l1.bridge-events` — bridge operation facts with user keys, amounts, correlation keys, and transaction/block identity.
- `zeko.health` — watcher freshness, lag, dependency status, and machine-readable limitations.

**Zeko-M / Mina bridge detection:**
- **Deposit submissions:** The user's `submitDeposit` creates a signed `AccountUpdate` on the user's own public key. That account update emits actions containing recipient, amount, timeout, holder account, and outer PK. The Mina adapter extracts the signer public key and deposit params, then computes `depositAux()` as the correlation key.
- **Withdrawal finalizations:** `finalizeWithdrawal` emits an outer witness action on `OUTER_PK` and finalize-withdrawal event fields. The Mina adapter verifies the witness `aux` against the decoded withdrawal params and extracts the finalizer user key when available.
- **Deposit cancellations:** Cancellation advances `helperAccountL1.zkappState[0]`. The Mina adapter detects cancel transactions by scanning account updates/preconditions and uses the helper counter as a consistency check.

**Zeko-M historical bridge recovery requirement:** Archive-Node-API currently supports `actions(OUTER_PK)`, which is enough to rebuild outer actions and settlement commits. Complete historical bridge recovery also requires querying successful zkApp commands by block range with full account update actions, events, app state, and preconditions. Milestone 1 requires an upstream Archive-Node-API `zkappCommands(input)` query matching the Spike 006 addendum (`spikes/006-l1-watcher/addendums/index.html#archive`).

If that query is unavailable, `zeko.l1.bridge-events` is live-only except for retained NATS messages and any blocks still visible in the hosted Mina daemon frontier. Watcher or explorer downtime can then create an unrecoverable bridge-event gap once the missed blocks leave the daemon frontier and the relevant NATS messages are unavailable. The UI and APIs must expose this as partial/incomplete data instead of blocking pages or returning authoritative empty results.

**Runtime loops:** The watcher runs independent loops for tip reconciliation, archive settlement/outer-action catch-up, bridge-event backfill, provider-specific consistency checks, and health publication. A failed dependency degrades only the loops that need it. NATS or SurrealDB outages pause data publication/cursor advancement while the health endpoint remains available.

**Why TypeScript:** I/O bound — GraphQL/JSON-RPC polling. Mature async and client ecosystem.

#### 5.2.3 DA Monitor (TypeScript)

Small, isolated service monitoring the DA layer for attestation status. Isolated behind NATS so the rest of the system is unaffected when the DA implementation changes (Ethermint → Celestia). Provides attestation metadata only.

#### 5.2.4 NATS JetStream

Shared indexing substrate and **authoritative source of truth**. Streams carry raw, unprocessed data. Each consumer normalizes independently.

SurrealDB is a rebuildable read model. If the database ever needs to be rebuilt, replaying the NATS history is sufficient. The DA layer and R2 archive serve as backfill sources for data older than the JetStream retention window.

**Durable consumers** with at-least-once delivery. Combined with idempotent writes = exactly-once processing semantics.

**Extensibility:** Any future service creates a durable consumer on existing streams and builds its own materialization.

**NATS is dedicated to the indexing pipeline.** It is not used for UI real-time delivery (SSE fan-out uses SurrealDB live queries at the GraphQL layer).

**JetStream configuration:**

| Stream | Subjects | Retention | Max Age | Notes |
|---|---|---|---|---|
| `zeko-l2` | `zeko.l2.>` | Limits | 90d (configurable 1-6 months) | Transactions + finality events. Dedup window: 2m. |
| `zeko-health` | `zeko.health` | Limits | — | Max 1000 messages. |
| `zeko-l1` | `zeko.l1.>` | Limits | 90d | Settlements, rollbacks, outer actions, bridge events. |
| `zeko-da` | `zeko.da.>` | Limits | 90d | DA attestations. |

**R2 archival:** A cron job exports messages older than `(max_age - 1 week)` to Cloudflare R2 as daily NDJSON files compressed with zstd. Each line includes original NATS headers (sequence, timestamp, `Nats-Msg-Id`) for replayability. JetStream `Max Age` auto-prunes expired messages after archival. R2 bucket per network. See `spikes/001-sequencer-connector/results.md` Section 7 for full archival design.

**Pre-seeded NATS streams:** For fast new deployments, a pre-populated JetStream data directory can be distributed as a snapshot, eliminating the need for DA layer bootstrap entirely.

#### 5.2.5 Zeko Indexer (TypeScript)

A single unified indexer consuming all NATS streams. Normalizes raw data and writes to SurrealDB — both explorer tables (transactions, accounts, batches, zkApp events/actions) and bridge tables (outer actions, inner actions, bridge operations).

**Language: TypeScript.** The indexer is I/O-bound (read from NATS, transform, write to SurrealDB). TypeScript enables shared domain types across the indexer, APIs, and the MCP server, reducing surface area for bugs. Rust remains an option only if profiling reveals a concrete performance bottleneck.

**Consumes:**
- `zeko.l2.transactions` → `transaction`, `account`, `account_activity`, `zkapp_event`, `zkapp_action`. zkApp records store raw fields only — labels are served by a separate Contract Registry API (§5.2.10). Each zkApp record is tagged with `target_ledger_hash` so L2 rollback can drop the affected rows without reindexing.
- `zeko.l2.finality` → update batch proved/committed status.
- `zeko.l1.settlements` → create/update `batch`, link to transactions.
- `zeko.l1.rollbacks` → revert batch settlement status (Section 7.5).
- `zeko.da.attestations` → attach status to batch records.
- `zeko.l1.outer-actions` → `outer_action` (Commits, Witnesses). Queryable by state range.
- `zeko.l2.transactions` → extract inner actions → `inner_action`. Queryable by state range.
- `zeko.l1.bridge-events` → `bridge_operation` with user PK, amount, aux, type. Graph edges (`l1_action_link`, `l2_action_link`) to outer/inner actions.
- Maintains `sync_status`, computes `network_stats`.

**Bridge operation indexing:** The indexer correlates L1 and L2 bridge events into unified `bridge_operation` records indexed by user public key. See Section 5.3 for correlation mechanics, lifecycles, and algorithms. See `spikes/002-bridge-correlation/results.md` for the full spike investigation and `spikes/002-bridge-correlation/test-scenarios/` for acceptance tests.

**Partial L1 bridge data:** The indexer records bridge operations from whichever side arrives first and attaches data-quality metadata to L1-backed fields. Missing `zeko.l1.bridge-events` data can make sender, amount, cancellation, or historical detail unknown, but it does not hide unrelated transactions, batches, account activity, or bridge records inferred from other evidence. APIs expose `syncing`, `degraded`, `unavailable`, and `unrecoverable_gap` states so the frontend can render partial records accurately.

**L2 rollback handling — consumer-side detection:** The sequencer has no runtime rollback mechanism (see `spikes/001-sequencer-connector/addendums/addendum-sequencer-rollbacks.md`). There is no `zeko.l2.rollbacks` stream. Instead, the indexer detects rollbacks by checking **hash chain continuity** on the `zeko.l2.transactions` stream:

- Each message has `source_ledger_hash` and `target_ledger_hash`. Normal operation: `M[n].source == M[n-1].target`.
- **Hash chain break → rollback:** If `M[n].source` matches an earlier `M[k].target`, messages `M[k+1]..M[n-1]` were rolled back. The indexer reverts SurrealDB state for those transactions and continues from `M[n]`.
- **Hash chain break → gap:** If `M[n].source` is unknown, diffs are missing. The indexer pauses, calls the Backfill Service (`backfill(fromHash, toHash)` mutation), subscribes to progress via SSE, and resumes after completion. See Section 5.2.1b.

The indexer maintains a `ledger_hash → NATS sequence number` mapping (in-memory, rebuilt from SurrealDB on restart) for O(1) ancestor lookup. See `spikes/001-sequencer-connector/results.md` Section 5 for the full detection algorithm and `spikes/001-sequencer-connector/test-scenarios/consumer-rollback-detection.feature` for acceptance tests.

**L1 rollback handling:** The indexer subscribes to `zeko.l1.rollbacks`. On L1 rollback events, it reverts affected batch settlements and cascades to bridge data.

#### 5.2.6 SurrealDB (Single Node)

Graph relations, record links, full-text search, live queries, schemaful mode. **Rebuildable read model** — NATS JetStream is the source of truth.

Schema migrations managed via [surrealdb-migrations](https://github.com/Odonno/surrealdb-migrations).

**Live query scaling:** The GraphQL APIs fan out from shared live queries. One `LIVE SELECT` per watched subscription type, not per client. API servers manage per-client filtering and SSE fan-out at the GraphQL layer.

**Guideline data model** (the following is indicative of the expected tables and relationships — the actual schema will be refined during implementation):

*Explorer tables:*
- `transaction` — hash, sequence_number, type, status, sender/receiver account links, amount, fee, nonce, memo, timestamp, state_hash, decoded account_updates, batch link, rollback_reason.
- `account` — public_key (indexed, full-text searchable), balance, nonce, delegate link, token_id, `zkapp_state` (raw 8-field array), `action_state` (raw 5-field vector), `verification_key_hash`, `zkapp_uri`.
- `account_activity` — per-account per-transaction changes, including rollback entries. zkApp state snapshots live here so revert-by-`target_ledger_hash` can restore the prior state without replaying NATS.
- `batch` — transaction range, proof/settlement status, L1 settlement details, DA attestation status, timestamps.
- `zkapp_event` / `zkapp_action` — emitting account and transaction links, **raw field arrays only** (no `decoded_fields`), sequence number, `target_ledger_hash` tag. Actions additionally store `before_action_state` / `action_state` (rolling Poseidon hash chain) with a unique index on `action_state`.
- `sync_status` — per-source health: last processed item, timestamp, lag, error state.
- `network_stats` — aggregates.

*Bridge tables (confirmed schema — see `spikes/002-bridge-correlation/results.md` Section 7):*
- `outer_action` — Record ID: `outer_action:⟨after_state⟩`. Flattened from the existing PostgreSQL `outer_actions` + `commit_actions` + `witness_actions` tables. Kind (commit/witness), before/after state, block height, txn hash, fields, slot range, timestamp. Commit-specific optional fields: `inner_action_state`, `inner_action_state_length`, `ledger`, `synchronized_outer_action_state`. Witness-specific optional field: `aux`. Indexed on `after_state` (unique), `before_state`, `index` (unique), `aux`, `kind`, `block_height`.
- `inner_action` — Record ID: `inner_action:⟨after_state⟩`. Before/after state, `aux`, block height, txn hash, fields, timestamp. Indexed on `after_state` (unique), `before_state`, `index` (unique), `aux`, `block_height`.
- `bridge_operation` — Record ID: `bridge_operation:⟨{aux}_{aux_sequence}⟩`. Type (deposit/withdrawal), status (`submitted`, `l1_witnessed`, `l2_witnessed`, `committed`, `delay_passed`, `completed`, `timed_out`, `cancelled`, `rolled_back`), `aux` + `aux_sequence` (composite unique key for collision handling), `sender`, `recipient`, `amount`, submission details (`submit_tx_hash`, `submit_block_height`, `submit_timestamp`), deposit-specific (`timeout_slot`, `holder_account_l1`), L1 witness fields, L2 action fields, commit reference, cancel reference, timestamps, and `data_quality` metadata for partial or unrecoverable L1 bridge data. **Indexed by sender, recipient, and (sender, type) / (recipient, type) for per-user queries.**
- `l1_action_link` — Graph relation: `outer_action → bridge_operation`. Role: "witness" or "commit". Created when outer actions are correlated to bridge operations.
- `l2_action_link` — Graph relation: `bridge_operation → inner_action`. Role: "mint" or "burn". Created when inner actions are correlated to bridge operations.

**Backup:**
- `surreal export` cron: 6h (devnet/alphanet), 1h (mainnet).
- Object storage (R2 or S3-compatible). Retention: 7d / 30d.
- Full re-index from NATS always available as DR.
- Restore procedure documented and tested.

#### 5.2.7 Explorer GraphQL API (TypeScript, Pothos)

Code-first GraphQL. SSE subscriptions (fan-out from SurrealDB live queries). Hosted on Hetzner, fronted by Cloudflare as a reverse proxy (rate limiting, DDoS protection, CORS, TLS).

Cursor-based pagination (not necessarily full Relay spec — see `spikes/005-relay-pagination.md`).

Queries: transactions, accounts, batches, search, system status, zkApp events/actions. Can read bridge tables for display on transaction/account detail pages. `Account`, `ZkappEvent`, and `ZkappAction` return raw field arrays only — labels live behind a separate Contract Registry API (§5.2.10) and are joined client-side (or by the federated gateway — see spike 4).

Every response includes `_meta` with `dataFreshness`, `syncLag`, `status`, and source limitations such as `l1_live_unavailable`, `l1_archive_unavailable`, `historical_bridge_events_unavailable`, and `bridge_event_gap_unrecoverable` when they affect the returned data.

#### 5.2.8 Code-Mode MCP Server (Cloudflare Worker)

Two tools: `search()` and `execute()`.

- **`search()`**: Sandbox contains the GraphQL introspection result as a typed object. Agent writes JS to explore types, queries, fields.
- **`execute()`**: Sandbox contains a **typed SDK auto-generated from the Pothos schema** via `graphql-codegen` as a build step, bundled into the Worker. Agent writes code against the SDK.

~1,000 tokens. Full API access. Calls the public Cloudflare-proxied GraphQL APIs. Service bindings bypass HTTP-layer protections (rate limiting, etc.) since the MCP server implements its own protections.

**Why MCP first:** Shipping MCP + APIs is significantly faster than building a frontend. With graphql-codegen, the MCP server is nearly trivial. People will use agents to visualize and query explorer data more than the UI.

#### 5.2.9 Explorer Frontend (Nuxt 3, Cloudflare Workers Static Assets)

Nuxt 3 SPA, no SSR. Deployed as static assets on Cloudflare Workers. Ships an HTML skeleton that hydrates on the client — no blank page on initial load.

**Why SPA:** No SEO requirements (account/transaction pages should not be indexed). Social sharing works with SPAs. SSR adds complexity with no concrete benefit for this use case.

**Design work is delegated.** Deliverables needed from a designer: component library, page layouts, responsive breakpoints, status indicator treatment, loading states.

#### 5.2.10 zkApp State, Events, and Actions Display

On-chain zkApp data is opaque: state is a vector of 8 `Field` values, and each event or action is an unlabeled `Field` array whose layout is known only to the deploying contract. The explorer must show this data usefully without forcing a compiler-in-the-browser or coupling the indexer to contract internals.

**Approach:** the indexer stores raw fields only. Human-readable labels come from an **opt-in, community-maintained contract schema** — a small JSON document per contract that names each state slot and describes each event/action variant. When a schema is available for `(network, address)`, the UI renders labels alongside the raw fields; when it isn't, the UI renders raw fields with a call-to-action linking to the submission flow. No indexer change, no node upgrade, no re-index when a schema is added or edited.

The schema source of truth is a separate public repository (`zeko-contract-registry`) where submissions are reviewed via PR and published manually after merge. The published schemas are served by a small standalone **Contract Registry API** that lives in this monorepo (a sibling of the Explorer and Bridge APIs) and reads from Cloudflare KV. It exposes a single `contractSchema(network, address)` query and is composed with the Explorer and Bridge APIs by the federated Hive gateway (see spike 4) so a UI page can fetch raw fields and labels in one round trip. Submissions may be signed by the contract's deploy key; the API exposes that as a verification grade (`owner-signed` / `source-linked` / `community-submitted`) the UI can badge.

See `spikes/003-zkapp-state-display/` for the full design: schema format, submission / verification / publish pipeline, interpreter semantics, and a runnable reference implementation under `addendums/examples/`.

### 5.3 Bridge Indexing

The existing `zeko-ui` bridge actions services (`services/actions/indexer`, `services/actions/api`) provide indexed bridge data to the bridge UI. They read outer actions (Commits, Witnesses) from the L1 archive and inner actions from the L2 archive, insert into PostgreSQL, and expose via GraphQL. Both are replaced: the Zeko Indexer (Section 5.2.5) replaces the existing indexer by consuming NATS streams instead of polling archives directly, and writing to SurrealDB instead of PostgreSQL. The Bridge GraphQL API (Section 5.3.5) replaces `services/actions/api` with new queries backed by SurrealDB.

See `spikes/002-bridge-correlation/results.md` for the full spike investigation and `spikes/002-bridge-correlation/test-scenarios/` for acceptance tests.

#### 5.3.1 Correlation Key

L1 and L2 sides of a bridge operation are correlated via the `aux` field — a Poseidon hash of the bridge parameters. `depositAux()` hashes `(holderAccountL1, amount, recipient, timeout)`. `withdrawalAux()` hashes `(amount, recipient)`. The `aux` field appears as `action[1]` on both outer witness actions (L1, on `OUTER_PK`) and inner actions (L2, on `INNER_PK`).

**`aux` is NOT unique.** Identical bridge operations produce the same `aux`. The indexer disambiguates via `(aux, aux_sequence)` as a composite unique key, mirroring the on-chain FIFO counter semantics (`prevNextDeposit`, `prevNextWithdrawal`, `prevNextCancelledDeposit` stored in helper account zkApp state). When a bridge operation is created, `aux_sequence = count of existing records with the same aux`. When the second side arrives, it matches to the lowest `aux_sequence` record missing that side (FIFO).

#### 5.3.2 User Public Key Extraction

The indexer watches zkApp contract PKs (`OUTER_PK`, `INNER_PK`), not individual user PKs. User PKs come from `zeko.l1.bridge-events` (primary): the L1 Watcher observes user-level transactions where the user signs an `AccountUpdate` on their own PK. For withdrawals, user PKs can also be parsed from inner action fields as a supplementary source.

#### 5.3.3 Bridge Operation Lifecycles

**Deposits:** `SUBMITTED` (L1 Watcher detects user's deposit tx) → `L1_WITNESSED` (outer witness action on `OUTER_PK`) → `COMMITTED` (commit action covers the deposit's inner action) → `COMPLETED` (L2 inner action indexed). Timeout path: `TIMED_OUT` (slot past timeout, no L2 finalization) → `CANCELLED` (cancel tx detected via `zeko.l1.bridge-events`). Rollback: any state → `ROLLED_BACK` (L1 fork or L2 hash chain break invalidates linked actions).

**Withdrawals:** `SUBMITTED` (L2 inner action on `INNER_PK` — submission and witness are the same event) → `COMMITTED` (commit action covers the inner action) → `DELAY_PASSED` (withdrawal delay elapsed: `current_l1_slot > commit.slotRangeUpper + withdrawal_delay`) → `COMPLETED` (outer witness on `OUTER_PK` from `finalizeWithdrawal`). Rollback: any state → `ROLLED_BACK`.

**Cancel deposit detection:** Cancel deposit does NOT emit an outer witness action on `OUTER_PK` — the cancel contract rule includes the outer account update as a precondition witness with no `actions` field. Cancellation is detected solely via `zeko.l1.bridge-events` when the L1 Watcher observes the cancel transaction advancing `prevNextCancelledDeposit`.

#### 5.3.4 Commit Association and Partial Records

**Commit-to-bridge-operation association:** When a commit action is indexed, the indexer walks the inner action state chain backward from the commit's `innerActionState` for `innerActionStateLength` steps, collecting `aux` values. Each `aux` is matched to its `bridge_operation` via `(aux, aux_sequence)` lookup (FIFO). This is O(N) where N = `innerActionStateLength`, executed once per commit.

**First-side-wins partial records:** Events from different NATS streams arrive independently. Whichever message references a bridge operation first creates the record. Subsequent messages update the existing record and recalculate status based on which fields are populated.

#### 5.3.5 Bridge GraphQL API

A **Bridge GraphQL API** (TypeScript, Pothos) is a separate endpoint backed by the same SurrealDB instance. It serves the bridge UI and replaces `services/actions/api` entirely. No backward compatibility with the old 5-query interface is needed. Hosted on Hetzner, fronted by Cloudflare.

**Queries:**
- `bridgeOperations(publicKey, type?, status?, first?, after?)` — primary query replacing `findDeposits`/`findWithdrawals` archive scans. Matches user as sender OR recipient. Cursor-based pagination. Returns `BridgeOperationConnection` with data-quality metadata for partial L1 bridge facts.
- `bridgeOperation(aux, auxSequence)` — single operation detail with graph-traversed linked L1 and L2 actions plus data-quality metadata.
- `outerActions(afterState?, limit?)` — low-level action chain queries for indexer/debugging.
- `innerActions(afterState?, limit?)` — low-level action chain queries.

**Subscription:** `bridgeOperationUpdated(publicKey)` — SSE live updates for a user's bridge operations, backed by SurrealDB live queries. Filtered per-user at the API layer.

Bridge responses distinguish authoritative empty results from incomplete source data. If the L1 Watcher reports `historical_bridge_events_unavailable` or `bridge_event_gap_unrecoverable`, the API returns partial records with field-level warnings instead of treating missing L1 bridge facts as no operation.

**What changes in the bridge SDK/UI/CLI:**

| Current | New |
|---|---|
| `findDeposits(pk)` — scans all actions on user's PK from L1 archive | `bridgeOperations(pk, type: DEPOSIT)` |
| `findWithdrawals(pk)` — scans all actions on user's PK from L1 archive | `bridgeOperations(pk, type: WITHDRAWAL)` |
| `prevNextDeposit` client-side FIFO matching via on-chain counters | Server-side `auxSequence` already resolved |
| Client combines archive + indexer + on-chain state for deposit status | Single `status` field from API |
| Multiple archive calls per wallet on page load | Single paginated API call |
| 20s polling (`POLL_INTERVAL` in `bridgeOperation.ts`) | SSE subscription via `bridgeOperationUpdated` |

**GraphQL federation:** The Explorer, Bridge, and Contract Registry APIs are separate services. They are unified behind a federated Hive gateway that exposes a single endpoint to clients (UI, MCP, third parties). Topology and gateway specifics are designed in spike 4.

**Key improvement:** Per-user bridge operation history is indexed by public key, replacing the current full archive scan per wallet.

---

## 6. Project Structure — Monorepo

The monorepo is a pure TypeScript + Nuxt project managed with **pnpm workspaces + moonrepo**. The OCaml NATS publishing code lives in the sequencer repository (as part of the sequencer), and the backfill service is a standalone OCaml binary in the same repo. Neither lives in this monorepo.

```
/zeko-explorer
├── flake.nix                          # Nix for reproducible builds + dev shells
├── docker-compose.yml                 # Local development stack (NATS, SurrealDB, services)
├── wrangler.toml                      # Cloudflare Worker configs
│
├── packages/
│   ├── nats-protocol/                 # NATS subject constants + event schemas
│   ├── domain/                        # Cross-cutting domain types
│   ├── db/                            # SurrealDB schema definitions + migrations
│   ├── l1-watcher/                    # TypeScript
│   │   └── src/
│   │       ├── config.ts
│   │       ├── service.ts
│   │       ├── state/                 # SurrealDB cursors, block window, published facts
│   │       ├── nats/                  # zeko.l1.* publishers
│   │       ├── health/                # /healthz + zeko.health
│   │       └── adapters/
│   │           ├── mina/              # Mina L1 adapter
│   │           └── ethereum/          # Ethereum L1 adapter (Milestone 4)
│   ├── da-monitor/                    # TypeScript
│   ├── zeko-indexer/                  # TypeScript — unified indexer
│   │   └── src/
│   │       ├── domain/
│   │       ├── consumers/             # NATS stream consumers
│   │       ├── normalizers/           # Raw → domain transformations
│   │       └── repositories/          # SurrealDB adapters
│   ├── explorer-api/                  # TypeScript, Pothos
│   ├── bridge-api/                    # TypeScript, Pothos
│   ├── contract-registry-api/         # TypeScript, Pothos — serves contractSchema from CF KV
│   ├── contract-schema/               # Shared decoder + JSON Schema types (browser + server)
│   ├── mcp-server/                    # TypeScript, CF Worker
│   └── frontend/                      # Nuxt 3
│
├── tests/
│   ├── acceptance/                    # Gherkin feature files + step definitions
│   └── fixtures/                      # Canned NATS messages captured from devnet
│
├── spikes/                            # Research spike documents
│
└── infra/
    ├── docker/                        # Dockerfiles per service
    └── nix/                           # Nix derivations per service
```

Each package: DDD internally (domain core, infrastructure boundary, repository interfaces).

---

## 7. Reliability and Rollback Handling

### 7.1 Never Silently Show Stale Data

Indexers write heartbeats to `sync_status`. GraphQL APIs include `_meta` freshness data. Frontend shows two-tier health:
- **User-facing:** Freshness badge on every page ("data is N seconds old" based on last indexed block timestamp vs. wall clock).
- **Operator-facing:** Structured `/status` endpoint returning per-component health checks — NATS lag, last indexed heights, L1 watcher status, DB responsiveness. Dedicated `/status` page on frontend.

### 7.2 Self-Healing Ingestion

NATS durable consumers resume from last ack. On first startup with `--nats-url`, the sequencer's `sync` function replays all DA layer diffs and publishes each to NATS, populating the full history. Subsequent restarts publish during sync with JetStream deduplication handling overlaps. Gaps detected by the indexer are filled on demand via the Backfill Service. Idempotent writes throughout.

### 7.3 Graceful Degradation and Recovery

| Failure | Impact | Detection | Recovery |
|---|---|---|---|
| **Sequencer down** | No new L2 transactions indexed. | Health heartbeat stops → `sync_status` updated → frontend shows degraded. | Sequencer restarts, `sync` replays DA diffs to NATS (dedup handles overlaps). Indexer detects any gap via hash chain break, triggers backfill service to fill it. |
| **L1 live endpoint down** | Cannot track tip, update finality, or detect new live L1 rollbacks. Archive catch-up can continue if the archive endpoint is reachable. | L1 Watcher heartbeat degrades with `l1_live_unavailable` → `sync_status` → "L1 status unknown." | Watcher reconnects, reconciles the adapter canonical chain window, publishes rollback events for orphaned published facts, then resumes finality updates. |
| **L1 archive endpoint down** | Historical catch-up pauses. Existing data remains queryable. Live processing can continue if the live endpoint is reachable. | Watcher heartbeat degrades with `l1_archive_unavailable`. | Watcher reconnects and resumes from durable archive cursors. For Zeko-M, outer actions/settlements recover via `actions(OUTER_PK)`; bridge events recover only if Archive-Node-API exposes historical `zkappCommands`. |
| **Zeko-M Archive-Node-API missing `zkappCommands`** | Historical bridge-event backfill unavailable. Deposits/cancels/withdrawal details missed during watcher downtime may become unrecoverable. | Watcher health includes `historical_bridge_events_unavailable`; APIs expose partial bridge data quality. | Add the upstream Archive-Node-API query. After deployment, scan from genesis or configured `BRIDGE_HISTORY_START_HEIGHT`; events missed before the query existed remain recoverable only if still in daemon frontier or retained NATS. |
| **DA layer down** | Attestation status "unknown." Everything else unaffected. | DA Monitor reports unreachable. | Reconnect, backfill missed attestations. |
| **SurrealDB down** | APIs cannot serve read models; watcher pauses new data facts because cursors and published-fact IDs cannot be persisted. | Health checks detect. | Container restart. If corrupted: restore from backup or full re-index from NATS. Watcher reloads cursors/block window before resuming. |
| **NATS down** | Data publication halts; cursor advancement pauses. Existing indexed data still served. | Publishers report failures; watcher health degrades/down. | NATS restart. JetStream persistence recovers stream state. Watcher resumes from durable cursors and uses `Nats-Msg-Id` deduplication for retry attempts. |
| **Indexer down** | No new data (explorer or bridge). Stale warning shown. | Heartbeat stops. | Restart. Durable consumer resumes from last ack. |

### 7.4 Idempotent Writes

All database operations use upserts keyed on natural identifiers (transaction hash, sequence number, action state).

### 7.5 Rollback Handling (Zeko-M Specific)

Zeko-M has two categories of rollback scenarios. Zeko-E will define its own rollback model based on Ethereum finality when that deployment is built.

**L2 rollback detection is consumer-side.** The sequencer has no runtime rollback mechanism — adding one is not desirable due to complexity (see `spikes/001-sequencer-connector/addendums/addendum-sequencer-rollbacks.md`). There is no `zeko.l2.rollbacks` stream. The indexer detects L2 rollbacks by checking hash chain continuity on the `zeko.l2.transactions` stream. L1 rollbacks are detected by the L1 Watcher and published to `zeko.l1.rollbacks`.

#### Scenario 1: L1 Fork Invalidates a Commit or Deposit

Mina L1 has probabilistic finality (~290 blocks). If a fork occurs and the new canonical chain does not contain:
- A **batch settlement transaction** that the sequencer had committed, or
- A **deposit action** that the sequencer had already accepted and credited on L2

...then the affected L2 state must be reverted.

**Detection path:** The Mina adapter treats daemon subscriptions as wake-up signals and reconciles through `bestChain(290)`. The watcher compares the current canonical block window with its persisted window, finds orphaned blocks, looks up previously-published L1 facts in `l1_watcher_published`, and publishes one `zeko.l1.rollbacks` event with the affected settlement, outer-action, and bridge-event IDs. The indexer processes this event and reverts batch settlement status and any cascading L2 effects.

If the watcher was down long enough that missed blocks left the daemon frontier, complete bridge-event reconciliation depends on Archive-Node-API historical `zkappCommands`. Without that query, missed bridge events can become an unrecoverable gap and must be surfaced through API/UI data-quality metadata.

If the sequencer also reverts L2 state in response to the L1 fork, the indexer detects this as a hash chain break on `zeko.l2.transactions` (see detection mechanism below) and reverts the affected transactions.

**Explorer impact:**
- Batch `settlement_status` reverts from "settling" to "pending" (or "rolled_back" if the batch itself is invalidated).
- If deposits were reverted: the credited L2 transactions are marked "reverted" with `rollback_reason`. Account balances updated. Bridge operation status updated.
- The explorer shows the full history: the original settlement, the rollback, and any re-settlement.

**Settlement finality indicator (Zeko-M):** The L1 Watcher emits events at multiple finality levels. Batches settled in L1 blocks <290 confirmations deep display "settling." Batches ≥290 deep display "finalized." Rolled-back batches display "rolled back." **The explorer never reports "finalized" until the L1 block is ≥290 deep.**

#### Scenario 2: Time Precondition Expiry

A transaction with a `valid_until` time precondition is accepted by the sequencer and applied to the L2 ledger. If the sequencer does not commit the batch to L1 before the precondition's slot deadline (e.g., because L1 is congested), the transaction becomes invalid. The sequencer reverts it.

**Detection path:** The sequencer reverts the transaction from its L2 state. When it publishes new transactions after the revert, the indexer detects a hash chain break — the new message's `source_ledger_hash` matches an earlier ancestor, not the most recent `target_ledger_hash`. The indexer identifies the rolled-back transactions and reverts them.

**Explorer impact:**
- The transaction status changes from "applied" to "reverted" with `rollback_reason: "time_precondition_expired"`.
- Account balances updated to reverse the transaction's effects.
- `account_activity` records the reversal.

#### L2 Rollback Detection Mechanism (Consumer-Side)

The indexer checks hash chain continuity on every incoming `zeko.l2.transactions` message:

1. For each message `M[n]`: compare `M[n].source_ledger_hash` with `M[n-1].target_ledger_hash`.
2. **If equal:** Normal operation — process the transaction.
3. **If `M[n].source` matches an earlier `M[k].target`:** Fork detected — messages `M[k+1]..M[n-1]` were rolled back. Revert SurrealDB state for those transactions, continue from `M[n]`.
4. **If `M[n].source` is unknown:** Gap — missing diffs. Pause, trigger Backfill Service (Section 5.2.1b), resume after completion.

The indexer maintains a `ledger_hash → NATS sequence number` mapping (in-memory hash map, rebuilt from SurrealDB on restart) for O(1) common ancestor lookup. Each SurrealDB transaction record is tagged with its `target_ledger_hash` for efficient revert by hash.

See `spikes/001-sequencer-connector/results.md` Section 5 for the full algorithm and `spikes/001-sequencer-connector/test-scenarios/consumer-rollback-detection.feature` for acceptance tests.

---

## 8. Testing Strategy

### 8.1 Domain-Driven Design

Bounded contexts: Transactions, Accounts, Batches, Bridge (outer/inner actions + operations), ZkApp (events/actions), System Health.

### 8.2 TDD

All domain logic test-first. Unit (mocked repos), integration (real SurrealDB/NATS), E2E (full pipeline).

### 8.3 Gherkin Acceptance Tests

**The scenarios in each milestone are representative examples illustrating expected style and coverage level. A comprehensive suite must be developed covering happy paths, error cases, edge cases, concurrent access, rollback scenarios, degraded states, and recovery flows.**

### 8.4 Test Infrastructure

- **Docker Compose** spins up real NATS + SurrealDB instances for integration tests (not mocks).
- **Fixtures:** Canned NATS messages captured from a real devnet. Tests the full pipeline from NATS onward without needing a running sequencer.
- **Fixture diversity:** Normal blocks, empty blocks, zkApp transactions, bridge operations, hash chain breaks (rollback simulation), finality events. Grow the fixture set as edge cases are encountered.
- Ephemeral instances per test suite. CI gate.

---

## 9. Milestones

### Pre-Milestone: Research Spikes

Before Milestone 1 implementation begins, the following spikes must be completed. Each has a dedicated document in `spikes/`.

1. **Sequencer Connector** (`spikes/001-sequencer-connector/`) — **Complete.** Resolved: sequencer publishes directly to NATS (no separate connector), consumer-side rollback detection, backfill service design, bootstrap strategy. See `results.md` for full findings.
2. **Bridge Operation Correlation** (`spikes/002-bridge-correlation/`) — **Complete.** Resolved: `aux` confirmed as correlation key (Poseidon hash, NOT unique — disambiguated via FIFO `aux_sequence`), user PK extraction via `zeko.l1.bridge-events`, cancel deposit produces no outer action (detected via L1 Watcher), full deposit/withdrawal lifecycle state machines, SurrealDB schema with graph edges, Bridge GraphQL API design. See `results.md` for full findings.
3. **zkApp State Display** (`spikes/003-zkapp-state-display/`) — **Complete.** Resolved: the indexer stores raw state / event / action fields only; human-readable labels come from an opt-in community schema registry served via a `contractSchema(network, address)` GraphQL query; decoding runs client-side by default. See §5.2.10 for the display approach and the spike directory for the schema format, submission pipeline, and reference implementation.
4. **Deployment Topology + Federated Gateway** (`spikes/004-deployment-topology.md`) — single vs. multi host, Nix vs. Docker Compose for production, and the federated Hive gateway that unifies the Explorer, Bridge, and Contract Registry APIs behind one endpoint.
5. **Pagination Schema** (`spikes/005-relay-pagination.md`) — cursor-based pagination schema, Relay spec tradeoffs.
6. **L1 Watcher** (`spikes/006-l1-watcher/`) — **Complete.** Resolved: shared L1 Watcher component boundary, Zeko-M / Mina adapter design, future Zeko-E / Ethereum adapter boundary, NATS event schemas for all `zeko.l1.*` subjects, fault-tolerant live/archive recovery, and the Archive-Node-API `zkappCommands` requirement for complete Mina historical bridge recovery. See `results.html` and `addendums/index.html` for the primary spike artifacts.
7. **DA Monitor** (`spikes/007-da-monitor/`) — DA attestation model, API analysis (Ethermint/Celestia), NATS event schema for `zeko.da.attestations`, migration considerations.

### Milestone 1: MCP Server + GraphQL API + Indexing Substrate (Foundation)

**Goal:** The indexing substrate (connectors, NATS, indexer, SurrealDB) and GraphQL APIs are operational. The code-mode MCP server provides agent access to all indexed data. No frontend yet — agents and API consumers are the first users.

**Components delivered:**
- Sequencer NATS Publishing (OCaml, in sequencer repo): `--nats-url` flag, three `enqueue_diff` publish points, finality events, health heartbeats, bootstrap during sync.
- Backfill Service (OCaml, standalone, in sequencer repo): GraphQL API, DA layer → NATS gap filling, SSE progress streaming.
- L1 Watcher (TypeScript, shared watcher package + Mina adapter): live/archive L1 connections, settlements, outer actions, rollbacks, bridge events, durable cursors, health, and graceful degradation. Complete Zeko-M historical bridge recovery requires the upstream Archive-Node-API `zkappCommands` query.
- DA Monitor (TypeScript): attestation monitoring.
- NATS JetStream: all streams configured, rolling retention (90d default) + R2 archival.
- Zeko Indexer (TypeScript): unified indexing of explorer data (transactions, accounts, batches, zkApp events/actions) and bridge data (outer actions, inner actions, bridge operations). Consumer-side L2 rollback detection via hash chain continuity. Backfill integration for gap filling. L1 rollback handling.
- SurrealDB: schema + migrations via surrealdb-migrations, backup cron.
- Explorer GraphQL API (Pothos): transactions, accounts, batches, search, system status, events/actions (raw fields only). SSE subscriptions.
- Contract Registry API (Pothos, standalone): single `contractSchema(network, address)` query, reads from Cloudflare KV. Backed by the `zeko-contract-registry` public submission repo. See §5.2.10.
- Bridge GraphQL API (Pothos): `bridgeOperations(publicKey)`, `bridgeOperation(aux, auxSequence)`, `outerActions`, `innerActions`. SSE subscription: `bridgeOperationUpdated(publicKey)`.
- Code-Mode MCP Server: search() + execute() with generated SDK from the federated gateway's schema.
- Per-concern packages: `nats-protocol`, `domain`, `db`.
- Nix flake, Docker Compose + wrangler for local dev, CF Worker deployment for MCP, Cloudflare reverse proxy for APIs.

**Why MCP first:** Shipping MCP + APIs is significantly faster than building a frontend — the MCP server is nearly trivial with graphql-codegen. People will use agents to visualize and query explorer data more than the UI. The bridge API immediately replaces `services/actions/api` — the bridge UI can switch to the new endpoint without waiting for the explorer frontend.

**Example Gherkin tests:**

```gherkin
Feature: Transaction Ingestion
  Scenario: A payment transaction is indexed
    Given the sequencer has processed a payment with hash "txn_abc"
    When the sequencer publishes to NATS and the indexer processes it
    Then the GraphQL API returns the transaction with correct fields
    And account balances are updated

  Scenario: Indexer resumes after restart
    Given the indexer last acknowledged NATS sequence 100
    And 50 new messages are pending
    When the indexer starts
    Then it processes messages 101-150 in order

  Scenario: L2 rollback — hash chain break detection
    Given transaction "txn_xyz" was applied and indexed
    When a new NATS message arrives with source_ledger_hash pointing to an ancestor before "txn_xyz"
    Then the indexer detects a hash chain break (rollback)
    And the transaction status becomes "reverted"
    And account balances are reversed

Feature: Bridge Operation Indexing
  Scenario: Deposit is tracked through full lifecycle
    When the following events arrive in order:
      | event                                              |
      | deposit submission from "B62qUser" with aux abc123 |
      | L1 witness proof for aux abc123                    |
      | batch commit covering aux abc123                   |
      | L2 finalization for aux abc123                     |
    Then the deposit transitions through: submitted -> l1_witnessed -> committed -> completed
    And the deposit is queryable by user "B62qUser"

  Scenario: Per-user bridge history replaces archive scanning
    Given deposits and withdrawals exist for user "B62qUser"
    When querying bridge operations for "B62qUser"
    Then the response contains all operations where user is sender or recipient

  Scenario: Agent discovers and queries via MCP
    When an agent calls search() to find transaction queries
    Then it receives schema information
    When the agent calls execute() with SDK code
    Then it receives correct data
```

---

### Milestone 2: Explorer Frontend

**Goal:** The web UI for the explorer. Consumes the GraphQL API built in Milestone 1.

**Components delivered:**
- Frontend (Nuxt 3 SPA, CF Workers Static Assets): home, transaction detail, account detail, contract detail, batch pages, bridge operations page, search, system status, network switcher.
- Design pass deliverables (delegated to designer).

**Features:**

*Home:* Live transaction feed (SSE), stats, unified search bar with auto-detection (hash format, `B62` public key prefix, numeric sequence number, free-text memo fallback). *Transaction detail:* All fields, zkApp data display (raw fields, labeled when a schema is published for the contract — see §5.2.10), rollback status if reverted. *Account detail:* Balance, nonce, zkApp state, tabs for transactions/events/actions. *Contract detail:* Dedicated page for zkApp accounts with State / Events / Actions / Deployments tabs. When a schema is available, fields render with labels and a verification-grade badge; otherwise the page falls back to raw fields with a CTA linking to the submission flow. *Batch overview/detail:* Lifecycle, settlement confidence (settling/finalized/rolled_back). *Bridge operations:* Lifecycle visualization with L1 ↔ L2 links, per-user bridge history. *System health:* Freshness badge on every page, degradation banner, operator `/status` page.

**Future milestone:** Natural language queries in the search bar.

**Example Gherkin tests:**

```gherkin
Feature: Data Freshness Display
  Scenario: Data is current
    Given the last transaction was indexed 2 seconds ago
    When a user loads any page
    Then the freshness indicator is green

  Scenario: Data is stale
    Given no transactions indexed for 5 minutes
    When a user loads any page
    Then the indicator is yellow with an explanatory banner

  Scenario: Rolled-back transaction display
    Given transaction "txn_xyz" has status "reverted"
    When a user views the transaction detail
    Then it shows "Reverted" with the rollback reason
```

---

### Milestone 3: Batch Settlement, L1 Rollback, and Finality (Zeko-M)

**Goal:** Full batch lifecycle tracking with finality and rollback handling for Zeko-M networks.

**Components delivered:**
- L1 Watcher refinements: finality tracking (multi-level confirmation depth), robust rollback detection with reconciliation after outages.
- Indexer refinements: settlement confidence computation, L1 rollback → batch reversion → L2 transaction reversion cascade.
- Frontend: settlement confidence indicator, rollback history display, L1 transaction links.

**Note:** Basic batch and settlement indexing is delivered in Milestone 1. This milestone adds the finality model, robust rollback handling, and the L1 outage reconciliation logic.

Zeko-M outage reconciliation is complete only when the Mina adapter can rebuild the missed range from Archive-Node-API. Outer actions and settlements recover from `actions(OUTER_PK)`; bridge events require historical `zkappCommands` account-update data.

**Example Gherkin tests:**

```gherkin
Feature: Settlement Finality
  Scenario: Batch reaches finality
    Given a batch settled in L1 block at height 5000
    When L1 height reaches 5290
    Then settlement_status is "finalized"

  Scenario: L1 fork invalidates a settlement
    Given a batch settled in L1 block at height 5000
    When that block is orphaned due to L1 fork
    Then settlement_status reverts to "rolled_back"
    And affected L2 deposit transactions are marked "reverted"
    And account balances are reversed

  Scenario: L1 Watcher recovers after outage
    Given the L1 Watcher was down for 30 minutes
    And Archive-Node-API can return zkApp commands for the missed range
    When it reconnects
    Then it reconciles all settlements and rollbacks from the outage period
    And it backfills bridge events from the last durable bridge cursor
```

---

### Milestone 4: Ethereum Support + Public API

**Goal:** Zeko-E network support and public API hardening.

**Components delivered:**
- Ethereum L1 adapter for L1 Watcher: JSON-RPC/archive access, settlement tracking, bridge events, rollback/reorg facts, Ethereum-specific finality model, contract addresses, ABI mappings, archive provider guarantees.
- DA Monitor update if DA implementation has changed.
- API hardening: rate limiting (CF reverse proxy), API key auth, documentation portal.
- MCP server updated with Ethereum-aware SDK.

**Example Gherkin tests:**

```gherkin
Feature: Ethereum Settlement
  Scenario: Zeko-E batch settled on Ethereum
    Given a Zeko-E batch committed to Ethereum L1
    When the L1 Watcher (Ethereum adapter) detects it
    Then the batch shows ethereum chain_id and tx hash

Feature: Public API
  Scenario: Rate limiting
    Given a client exceeds the rate limit
    Then requests return 429 with retry-after header
```

---

## 10. Deployment and Infrastructure

### 10.1 Local Development

- **Docker Compose + wrangler** for local development.
- **Nix** for reproducible development environments.
- **pnpm workspaces + moonrepo** for TypeScript monorepo management.

### 10.2 Production: Current

- **OCI containers** for all services.
- Deployed on **Hetzner** infrastructure.
- **Cloudflare** as reverse proxy in front of GraphQL APIs (rate limiting, DDoS protection, CORS, TLS).
- Production topology TBD — see `spikes/004-deployment-topology.md` for the investigation of single vs. multi host, Nix vs. Docker Compose for production.

### 10.3 Future: Kubernetes

Container design follows 12-factor principles (env-based config, health endpoints, graceful shutdown, stateless services) so migration to Kubernetes is straightforward. K8s migration is a planned org-level decision with no fixed timeline. Current design ensures a clean migration path via containerization.

### 10.4 Cloudflare Workers

- **Frontend:** Static assets on Cloudflare Workers.
- **Reverse Proxy:** CF in front of both GraphQL APIs on Hetzner. Routes by network and API type (explorer vs bridge). Handles TLS, CORS, rate limiting.
- **MCP Server:** CF Worker with code-mode sandbox. Calls public API; service bindings bypass HTTP-layer protections.

---

## 11. Gap Analysis

| Capability | Current | New | Milestone |
|---|---|---|---|
| Transaction browsing | Zekoscan | Real-time, rollback-aware | 1 (API), 2 (UI) |
| Data freshness | None | Every page (badge + /status) | 2 |
| Self-healing | None | NATS durable + idempotent | 1 |
| Custom indexing substrate | None | NATS streams, any consumer | 1 |
| Agent access | None | Code-mode MCP | 1 |
| Batch visibility | None | Full lifecycle | 1 (data), 2 (UI) |
| L1 rollback handling | None | Auto-reversion + display | 3 |
| L2 rollback handling | None | Consumer-side hash chain detection + revert | 1 (data), 3 (finality) |
| Bridge operations | Separate services | Unified indexer, shared DB | 1 |
| Per-user bridge history | Full archive scan per wallet | Indexed by public key | 1 |
| Outer/inner actions | services/actions/* | NATS consumer, same queries | 1 |
| zkApp events/actions | None | Per-account browsing; raw fields with opt-in labels from a community schema registry | 1 (data + registry API), 2 (UI) |
| Public API | Archive-Node-API | GraphQL, documented | 4 |
| Ethereum | N/A | L1 adapter | 4 |
| GraphQL federation | N/A | Hive gateway unifying Explorer + Bridge + Contract Registry APIs | 1 |

---

## 12. Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Sequencer NATS Publishing | OCaml (sequencer module) | Direct publish at `enqueue_diff` sites. `--nats-url` flag. Lives in sequencer repo. |
| Backfill Service | OCaml (standalone binary) | DA layer → NATS gap filling. GraphQL API + SSE. Lives in sequencer repo. |
| NATS OCaml Client | OCaml library | HPUB with headers, CONNECT, PING/PONG, reconnection, JetStream dedup via Nats-Msg-Id. New dependency. |
| L1 Watcher | TypeScript | I/O bound, GraphQL/JSON-RPC client ecosystem. Shared watcher lifecycle with provider adapters for Zeko-M/Mina and Zeko-E/Ethereum. |
| DA Monitor | TypeScript | Small, isolated, I/O bound. |
| NATS | JetStream (rolling retention + R2 archival) | Durable, replay, extensible substrate. Source of truth. |
| Zeko Indexer | TypeScript | I/O bound. Shared types with APIs. Rust only if perf bottleneck. |
| Database | SurrealDB (single node) | Graph, record links, FTS, live queries. Rebuildable from NATS. |
| DB Migrations | surrealdb-migrations | Mature migration tooling for SurrealDB. |
| Explorer API | TypeScript, Pothos | Code-first, SSE, cursor-based pagination. |
| Bridge API | TypeScript, Pothos | Separate endpoint, same tech. |
| Contract Registry API | TypeScript, Pothos | Standalone service; reads schemas from Cloudflare KV. See §5.2.10. |
| Federated Gateway | Hive gateway | Unifies Explorer + Bridge + Contract Registry APIs behind one endpoint. Designed in spike 4. |
| Contract Submission Repo | Separate public GitHub repo (`zeko-contract-registry`) | PR-based submission with schema validation, golden fixtures, and optional owner signatures. Manual publish to KV. |
| MCP Server | TypeScript, CF Worker | Code-mode + generated SDK. Service bindings. |
| Frontend | Nuxt 3 SPA, CF Workers Static Assets | No SSR needed. HTML skeleton + hydration. |
| Search | Unified bar, auto-detect | NL queries in future milestone. |
| Testing | Gherkin, Vitest | Living docs + unit/integration. Real NATS/SurrealDB in Docker. |
| Monorepo | pnpm workspaces + moonrepo | TS-only monorepo. Per-concern shared packages. |
| Build | Nix | Reproducible dev environments. |
| Containers | OCI/Docker | Hetzner now, k8s-ready. |
| Edge | Cloudflare Workers + reverse proxy | Static assets, API gateway, MCP. |
