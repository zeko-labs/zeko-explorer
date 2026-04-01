# PRD: Zeko Block Explorer & Indexing Substrate

**Author:** Zeko Labs
**Status:** Draft v5
**Last Updated:** March 31, 2026

---

## 1. Executive Summary

Zeko currently relies on Zekoscan (third-party, Blockberry/Staketab) and a separate bridge actions indexer/API (`zeko-ui/services/actions/*`). Zekoscan suffers from reliability issues, stale data, and a lack of L2 concepts. The bridge actions services are a workaround for inadequate archive node data. Zeko has no control over either system's roadmap.

This document defines a **general-purpose indexing substrate** for the Zeko network and a **greenfield block explorer** as its first consumer. At the foundation, connector services publish raw blockchain events to NATS JetStream streams. Multiple independent consumers — the explorer indexer, the bridge indexer, and any future service — subscribe to these streams, normalize data according to their needs, and write to a shared SurrealDB instance with separate namespaces/tables as appropriate.

The system replaces:
- The archive relay adapter + Mina archive node + Archive-Node-API + Zekoscan pipeline.
- The bridge actions indexer and API (`services/actions/indexer`, `services/actions/api`), which are rebuilt as a NATS consumer sharing the same indexing substrate and SurrealDB instance.

The explorer is exposed via a code-first GraphQL API (Pothos) with SSE subscriptions and a code-mode MCP server for agent interaction. The bridge actions are exposed via a separate GraphQL API endpoint. Both APIs are federatable in the future. The frontend is a Nuxt 3 SPA deployed on Cloudflare Workers (static assets).

---

## 2. Problem Statement

### 2.1 Current Architecture

```
Zeko Sequencer → Archive Relay (OCaml) → Mina Archive Node (PostgreSQL)
    → Archive-Node-API (GraphQL) → Zekoscan UI

Zeko Sequencer + L1 Archive + L2 Archive
    → Actions Indexer (PostgreSQL) → Actions API (GraphQL) → Bridge UI
```

### 2.2 Analysis of the Mina Archive Database

The Mina archive schema is designed around L1 consensus:

**Fork handling poorly suited to Zeko.** `chain_status` enum (`canonical`/`orphaned`/`pending`) models L1 block-level forks. Zeko needs batch-level settlement status tracking with two specific rollback scenarios (Section 7.5).

**Hyper-normalized.** Public keys in separate table referenced by ID. zkApp state across 15+ tables. Optimized for L1 storage, not explorer reads.

**No L2 tables.** No batches, bridge operations, DA attestations, sequencer state, proof status.

### 2.3 Analysis of the Existing Bridge Actions Services

The `zeko-ui` services exist to provide indexed bridge data to the bridge UI. They:

- Read **outer actions** (Commits, Witnesses) from the **L1 archive** — batch settlements and bridge proofs on the Mina L1 Zeko zkApp contract.
- Read **inner actions** from the **L2 archive** — L2-side bridge actions on the inner account.
- Insert into PostgreSQL, expose via GraphQL with queries: `outerActions(beforeState, afterState)`, `innerActions(beforeState, afterState)`, `commitAsePastSlot(slot)`, witness lookups by aux.

These services are **not replaced by the explorer frontend** — they serve the bridge UI, which is a different product. Instead, the underlying indexing pipeline is unified: both the explorer and the bridge indexer consume from the same NATS streams, normalize according to their needs, and write to a shared SurrealDB instance. The bridge actions API becomes a separate GraphQL endpoint backed by the same database.

### 2.4 Gaps Summary

- Data staleness with no signal.
- No L2 concepts in the explorer.
- Fragmented indexing infrastructure (separate pipelines for explorer and bridge).
- No rollback modeling for either L1 settlement reversals or L2 sequencer rollbacks.
- No control over explorer roadmap.

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. **General-purpose indexing substrate** — NATS streams as shared event log, multiple consumers.
2. **Greenfield block explorer** replacing Zekoscan.
3. **Unified bridge indexing** replacing `services/actions/*`, sharing SurrealDB with the explorer.
4. **Zeko-native data model** — "1 block = 1 transaction," batches, bridge actions, rollback states.
5. **Extreme reliability** with health monitoring, freshness indicators, self-healing.
6. **Extreme clarity about system status.**
7. **Multi-network**: Zeko-M (devnet, alphanet, mainnet), Zeko-E (testnet-x, mainnet).
8. **Real-time data.**
9. **Agent-first** via code-mode MCP server.
10. **TDD/DDD with Gherkin** acceptance tests.
11. **Future-ready** for public API and GraphQL federation.

### 3.2 Non-Goals

1. Staking/delegation dashboards.
2. Token price feeds / DeFi analytics.
3. Smart contract source verification.
4. Public API in initial milestones.

---

## 4. Network Nomenclature

| Family | Network ID | Settlement Layer | Description |
|---|---|---|---|
| Zeko-M | `zeko-m-devnet` | Mina Devnet | Development |
| Zeko-M | `zeko-m-alphanet` | Mina Devnet/Mainnet | Pre-mainnet staging |
| Zeko-M | `zeko-m-mainnet` | Mina Mainnet | Production |
| Zeko-E | `zeko-e-testnet-1` | Ethereum Testnet | Ethereum testing |
| Zeko-E | `zeko-e-mainnet` | Ethereum Mainnet | Ethereum production |

Each network runs its own sequencer, DA layer, and full explorer backend stack (connectors, NATS, indexers, SurrealDB, APIs).

---

## 5. Architecture

### 5.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Data Sources                                │
│  ┌─────────────┐  ┌────────────────┐  ┌──────────────────────────┐  │
│  │    Zeko      │  │  L1 Live Node  │  │    DA Layer              │  │
│  │  Sequencer   │  │  + L1 Archive  │  │  (Ethermint / Celestia)  │  │
│  │  (internal   │  │  (Mina or ETH) │  │                          │  │
│  │   protocol)  │  │                │  │                          │  │
│  └──────┬───────┘  └───────┬────────┘  └────────────┬─────────────┘  │
└─────────┼──────────────────┼────────────────────────┼────────────────┘
          │                  │                        │
          ▼                  ▼                        ▼
┌─────────────────┐ ┌───────────────┐ ┌──────────────────────────────┐
│ Sequencer       │ │ L1 Watcher    │ │ DA Monitor                   │
│ Connector       │ │ (TypeScript)  │ │ (TypeScript)                 │
│ (OCaml)         │ │               │ │                              │
│                 │ │ L1 live node: │ │                              │
│ Raw data →      │ │  tip, rollback│ │                              │
│ NATS            │ │ L1 archive:   │ │                              │
│                 │ │  actions,     │ │                              │
│                 │ │  history      │ │                              │
└────────┬────────┘ └──────┬────────┘ └─────────────┬────────────────┘
         │                 │                        │
         ▼                 ▼                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       NATS JetStream                                 │
│                   (shared indexing substrate)                         │
│                                                                      │
│  Streams (raw, unprocessed — consumers normalize independently):     │
│  • zeko.l2.transactions     (raw L2 tx from sequencer)               │
│  • zeko.l2.rollbacks        (L2 sequencer rollback events)           │
│  • zeko.l1.settlements      (batch settlement events)                │
│  • zeko.l1.rollbacks        (L1 block orphan events)                 │
│  • zeko.l1.outer-actions    (Commits, Witnesses from L1 archive)     │
│  • zeko.l1.bridge-events    (deposit/withdrawal events)              │
│  • zeko.da.attestations     (DA confirmations)                       │
│  • zeko.health              (service heartbeats)                     │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              ▼                             ▼
┌──────────────────────────┐  ┌────────────────────────────────────────┐
│  Explorer Indexer         │  │  Bridge Indexer                        │
│  (language: TBD)         │  │  (language: TBD)                       │
│                          │  │                                        │
│  Consumes: all streams   │  │  Consumes: outer-actions, l2.txns,    │
│  Writes: transactions,   │  │  bridge-events, l1.rollbacks,         │
│  accounts, batches,      │  │  l2.rollbacks                         │
│  network stats, etc.     │  │  Writes: outer_action, inner_action,  │
│                          │  │  bridge_operation                     │
└────────────┬─────────────┘  └──────────────┬─────────────────────────┘
             │                               │
             ▼                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    SurrealDB (single node, shared)                    │
│                                                                      │
│  Explorer tables:  transaction, account, account_activity, batch,    │
│                    zkapp_event, zkapp_action, sync_status,           │
│                    network_stats                                     │
│                                                                      │
│  Bridge tables:    outer_action, inner_action, bridge_operation      │
│                    (shared with explorer via record links)           │
└────────────────┬──────────────────────────┬──────────────────────────┘
                 │                          │
                 ▼                          ▼
┌────────────────────────────┐ ┌───────────────────────────────────────┐
│  Explorer GraphQL API      │ │  Bridge GraphQL API                   │
│  (TypeScript, Pothos)      │ │  (TypeScript, Pothos)                 │
│  SSE subscriptions         │ │  Replaces services/actions/api        │
│  CF Worker API gateway     │ │  Separate endpoint, federatable later │
└─────────┬──────────────────┘ └───────────────────────────────────────┘
          │
          ├──────────────────────────────┐
          ▼                              ▼
┌─────────────────────────────┐ ┌──────────────────────────────────────┐
│  Explorer Frontend           │ │  Code-Mode MCP Server                │
│  (Nuxt 3 SPA)               │ │  (CF Worker, search + execute        │
│  CF Workers Static Assets    │ │   with generated typed SDK)          │
└──────────────────────────────┘ └──────────────────────────────────────┘
```

### 5.2 Component Details

#### 5.2.1 Sequencer Connector (OCaml)

Minimal OCaml service speaking the sequencer's internal binary protocol. Publishes **raw, unprocessed** data to NATS. No normalization.

**Why OCaml:** The binary protocol is defined in the Mina/Zeko OCaml codebase. Reimplementing it would be error-prone and require continuous sync with protocol evolution.

**Responsibilities:**
- Connect to sequencer via `--zeko-uri`, subscribe to blocks/transactions.
- Bootstrap (`--bootstrap`) for historical replay.
- Publish raw data to `zeko.l2.transactions`.
- **Detect and publish L2 rollback events** to `zeko.l2.rollbacks` (see Section 5.3 and 7.5).
- Publish heartbeats to `zeko.health`.

**L2 rollback signaling — prerequisite investigation:** The exact mechanism by which the sequencer signals rollbacks on its internal protocol must be determined before building the connector. The two rollback scenarios (L1 fork invalidation and time precondition expiry — see Section 7.5) may be signaled as explicit rollback events, chain reorganization signals, or state contradictions. **This investigation is a prerequisite task in Milestone 1.** The team must study the sequencer's OCaml source code (`zeko/` directory, particularly the sequencer's block production and recovery logic, which was part of the mainnet audit scope) to determine:
1. What protocol messages indicate a rollback has occurred.
2. Whether the connector sees the rollback as a new block that overwrites a previous state, or as an explicit "undo" message.
3. How the connector should communicate this to downstream consumers via NATS.

#### 5.2.2 L1 Watcher (TypeScript)

Monitors the L1 settlement chain. Requires **two distinct L1 connections**:

**L1 Live Node** (Mina daemon GraphQL or Ethereum JSON-RPC):
- Tracks the canonical chain tip.
- Detects L1 block orphaning (rollback detection). **Cannot be done from archive alone** — the archive may lag or only report the canonical chain after the fact.
- Detects new batch settlement transactions on the Zeko zkApp contract.

**L1 Archive** (Mina archive node GraphQL or Ethereum archive):
- Queries outer actions on the Zeko zkApp contract: **Commits** (batch settlements) and **Witnesses** (bridge proofs).
- Queries historical action state data.
- **Reliable source for action history.** The live node cannot efficiently answer "give me all actions between state X and state Y."

**Why TypeScript:** I/O bound — GraphQL/JSON-RPC polling. Mature async and client ecosystem.

**Publishes to:**
- `zeko.l1.settlements` — batch settlement detections.
- `zeko.l1.rollbacks` — L1 block orphan events.
- `zeko.l1.outer-actions` — Commits and Witnesses from L1 archive.
- `zeko.l1.bridge-events` — deposit/withdrawal events.
- `zeko.health` — heartbeats.

**L1 adapter interface:** Mina implementation first (Zeko-M). Ethereum adapter added in Milestone 4. Finality model and rollback handling are Zeko-M specific (see Section 7.5); Zeko-E will define its own finality model based on Ethereum's consensus.

#### 5.2.3 DA Monitor (TypeScript)

Small, isolated service monitoring the DA layer for attestation status. Isolated behind NATS so the rest of the system is unaffected when the DA implementation changes (Ethermint → Celestia). Provides attestation metadata only.

#### 5.2.4 NATS JetStream

Shared indexing substrate. Streams carry raw, unprocessed data. Each consumer normalizes independently.

**Durable consumers** with at-least-once delivery. Combined with idempotent writes = exactly-once processing semantics.

**Extensibility:** Any future service creates a durable consumer on existing streams and builds its own materialization.

#### 5.2.5 Explorer Indexer (Language: TBD — Technical Spike Required)

Consumes all NATS streams relevant to the explorer, normalizes raw data, writes to SurrealDB.

**Language: Rust or TypeScript, determined by Milestone 1 spike.** The deciding factor is normalization complexity — deeply nested Account Update trees with preconditions, permissions, authorization kinds, balance changes, state changes, events, actions. **The spike must evaluate this empirically**, not theoretically.

**Spike deliverable:** Implement normalization + SurrealDB write path for sample raw sequencer messages in both languages. Evaluate code complexity, correctness, performance, developer experience.

**Consumes:**
- `zeko.l2.transactions` → `transaction`, `account`, `account_activity`, `zkapp_event`, `zkapp_action`.
- `zeko.l2.rollbacks` → revert affected transactions and account states (Section 7.5).
- `zeko.l1.settlements` → create/update `batch`, link to transactions.
- `zeko.l1.rollbacks` → revert batch settlement status (Section 7.5).
- `zeko.da.attestations` → attach status to batch records.
- Maintains `sync_status`, computes `network_stats`.

#### 5.2.6 Bridge Indexer (Language: TBD — Same Spike as Explorer Indexer)

A separate NATS consumer, sibling to the Explorer Indexer. Writes to the **same SurrealDB instance** — some tables are shared (e.g., `transaction`, `account` are read by both), some are bridge-specific.

**Consumes:**
- `zeko.l1.outer-actions` → `outer_action` (Commits: before/after state, inner_action_state, ledger, synchronized state, slot range. Witnesses: aux). Queryable by state range.
- `zeko.l2.transactions` → extract inner actions → `inner_action` (before/after state, aux, fields). Queryable by state range.
- `zeko.l1.bridge-events` → `bridge_operation` with graph edges to L1 and L2 transactions.
- `zeko.l1.rollbacks` → update bridge operations affected by L1 rollbacks.
- `zeko.l2.rollbacks` → update bridge operations affected by L2 rollbacks (e.g., accepted deposit reverted).

**Shared SurrealDB:** The bridge indexer reads `transaction` and `account` records written by the explorer indexer (via record links). It writes `outer_action`, `inner_action`, and `bridge_operation` tables. The explorer indexer can read these for display on transaction/account detail pages. Both share one database, avoiding data duplication.

#### 5.2.7 SurrealDB (Single Node, Shared)

Graph relations, record links, full-text search, live queries, schemaful mode.

**Live query scaling:** The GraphQL APIs fan out from shared live queries. One `LIVE SELECT` per watched table, not per client. API servers manage per-client filtering.

**Data model:**

*Explorer tables:*
- `transaction` — hash, sequence_number, type, status (applied/failed/reverted), sender → account, receiver → account, amount, fee, nonce, memo, timestamp, state_hash, decoded account_updates, batch → batch, rollback_reason (null unless reverted).
- `account` — public_key (indexed, full-text), balance, nonce, delegate → account, token_id, zkapp_state.
- `account_activity` — per-account per-transaction changes. Includes rollback entries when state is reverted.
- `batch` — id, transaction_range, proof_status, settlement_status (unsettled/submitted/settling/finalized/rolled_back), l1_settlement_tx_hash, l1_chain_id, l1_block_height, da_attestation_status, timestamps.
- `zkapp_event` — emitting account → account, transaction → transaction, decoded fields, sequence.
- `zkapp_action` — emitting account → account, transaction → transaction, decoded fields, action state hash.
- `sync_status` — per-source health: last processed item, timestamp, lag, error state.
- `network_stats` — aggregates.

*Bridge tables (shared SurrealDB, written by Bridge Indexer):*
- `outer_action` — kind (COMMIT/WITNESS), before_state, after_state, block_height, fields[], index, timestamp, txn_hash. Commits: inner_action_state, inner_action_state_length, ledger, synchronized_outer_action_state, synchronized_outer_action_state_length, slot_range_lower, slot_range_upper. Witnesses: aux. Record links to batch, bridge_operation.
- `inner_action` — before_state, after_state, aux, block_height, fields[], index, timestamp, txn_hash. Record links to transaction.
- `bridge_operation` — type (deposit/withdrawal), status (initiated/pending_proof/submitted/confirmed/failed/rolled_back), amount, source/destination accounts, timestamps. Graph edges: `l1_tx → bridge_op → l2_tx`.

**Backup:**
- `surreal export` cron: 6h (devnet/alphanet), 1h (mainnet).
- Object storage (R2 or S3-compatible). Retention: 7d / 30d.
- Full re-index from NATS retention + sequencer bootstrap always available as DR.
- Restore procedure documented and tested.

#### 5.2.8 Explorer GraphQL API (TypeScript, Pothos)

Code-first GraphQL. SSE subscriptions. Cloudflare Worker API gateway in front.

Queries: transactions, accounts, batches, search, system status, zkApp events/actions. Can read bridge tables for display on transaction/account detail pages.

Every response includes `_meta` with `dataFreshness`, `syncLag`, `status`.

#### 5.2.9 Bridge GraphQL API (TypeScript, Pothos)

**Separate endpoint** from the explorer API. Serves the bridge UI. Replaces `services/actions/api`.

```typescript
// Bridge API schema (conceptual)
builder.queryType({
  fields: (t) => ({
    outerActions: t.field({
      type: [OuterAction],
      args: { beforeState: t.arg.string({ required: true }), afterState: t.arg.string() },
    }),
    innerActions: t.field({
      type: [InnerAction],
      args: { beforeState: t.arg.string({ required: true }), afterState: t.arg.string() },
    }),
    outerWitnessesFromAuxes: t.field({
      type: [Witness],
      args: { auxes: t.arg.stringList({ required: true }) },
    }),
    innerWitnessesFromAuxes: t.field({
      type: [InnerAction],
      args: { auxes: t.arg.stringList({ required: true }) },
    }),
    commitAsePastSlot: t.field({
      type: CommitAsePastSlotResult,
      args: { slot: t.arg.int({ required: true }) },
    }),
    bridgeOperations: t.connection({ type: BridgeOperation }),
    bridgeOperation: t.field({ type: BridgeOperation, args: { id: t.arg.string() } }),
  }),
});
```

**GraphQL federation:** The explorer and bridge APIs are separate services now. In the future, they can be composed into a federated supergraph via Apollo Federation or similar, providing a single endpoint that delegates to each service.

#### 5.2.10 Code-Mode MCP Server (Cloudflare Worker)

Two tools: `search()` and `execute()`.

- **`search()`**: Sandbox contains the GraphQL introspection result as a typed object. Agent writes JS to explore types, queries, fields.
- **`execute()`**: Sandbox contains a **typed SDK auto-generated from the Pothos schema** via `graphql-codegen` as a build step, bundled into the Worker. Agent writes code against the SDK.

~1,000 tokens. Full API access.

#### 5.2.11 Explorer Frontend (Nuxt 3, Cloudflare Workers Static Assets)

Nuxt 3 SPA, no SSR. Deployed as static assets on Cloudflare Workers.

**Design work is delegated.** Deliverables needed from a designer: component library, page layouts, responsive breakpoints, status indicator treatment, loading states.

---

## 6. Project Structure — Monorepo

```
/zeko-explorer
├── flake.nix                          # Nix for reproducible builds + dev shells
├── docker-compose.yml                 # Local development stack
│
├── packages/
│   ├── sequencer-connector/           # OCaml
│   ├── l1-watcher/                    # TypeScript
│   │   └── src/
│   │       ├── domain/
│   │       └── adapters/
│   │           ├── mina/              # Mina L1 adapter
│   │           └── ethereum/          # Ethereum L1 adapter (Milestone 4)
│   ├── da-monitor/                    # TypeScript
│   ├── explorer-indexer/              # Rust or TypeScript (TBD)
│   │   └── src/
│   │       ├── domain/
│   │       ├── consumers/             # NATS stream consumers
│   │       ├── normalizers/           # Raw → domain transformations
│   │       └── repositories/          # SurrealDB adapters
│   ├── bridge-indexer/                # Rust or TypeScript (TBD, same as explorer)
│   │   └── src/
│   │       ├── domain/                # OuterAction, InnerAction, BridgeOperation
│   │       ├── consumers/
│   │       ├── normalizers/
│   │       └── repositories/
│   ├── explorer-api/                  # TypeScript, Pothos
│   ├── bridge-api/                    # TypeScript, Pothos
│   ├── mcp-server/                    # TypeScript, CF Worker
│   ├── frontend/                      # Nuxt 3
│   └── shared/                        # Shared across packages
│       ├── nats-subjects.ts           # Stream/subject constants
│       ├── domain-types/              # Cross-cutting domain types
│       └── surreal-schema/            # SurrealDB schema definitions
│
├── tests/
│   ├── acceptance/                    # Gherkin feature files + step definitions
│   └── fixtures/                      # Shared test data
│
└── infra/
    ├── docker/                        # Dockerfiles per service
    ├── cloudflare/                    # Worker configs
    └── nix/                           # Nix derivations per service
```

Each package: DDD internally (domain core, infrastructure boundary, repository interfaces).

---

## 7. Reliability and Rollback Handling

### 7.1 Never Silently Show Stale Data

Indexers write heartbeats to `sync_status`. GraphQL APIs include `_meta` freshness data. Frontend adjusts indicators.

### 7.2 Self-Healing Ingestion

NATS durable consumers resume from last ack. Sequencer connector bootstrap for full replay. Idempotent writes.

### 7.3 Graceful Degradation and Recovery

| Failure | Impact | Detection | Recovery |
|---|---|---|---|
| **Sequencer down** | No new L2 transactions indexed. | Connector heartbeat stops → `sync_status` updated → frontend shows degraded. | Connector reconnects when sequencer returns. If rollbacks occurred during downtime, connector detects new state on reconnect (see Section 7.5). NATS durable consumer resumes. Gap backfilled via bootstrap if needed. |
| **L1 live node down** | Cannot track tip or detect L1 rollbacks. Settlement status frozen. | L1 Watcher heartbeat degrades → `sync_status` → "L1 status unknown." | Watcher reconnects, re-scans from last known L1 height. Reconciles settlements and rollbacks that occurred during outage. |
| **L1 archive down** | Outer action indexing paused. Existing data still queryable. | Watcher reports archive unreachable. | Watcher reconnects, backfills missed actions from last indexed state. |
| **DA layer down** | Attestation status "unknown." Everything else unaffected. | DA Monitor reports unreachable. | Reconnect, backfill missed attestations. |
| **SurrealDB down** | All APIs return errors. No data served. | Health checks detect. | Container restart. If corrupted: restore from backup or full re-index from NATS + bootstrap. |
| **NATS down** | All ingestion halted. Existing data still served. | All connectors report publishing failures. | NATS restart. JetStream persistence recovers stream state. Durable consumers resume. |
| **Explorer Indexer down** | No new explorer data. Stale warning shown. | Heartbeat stops. | Restart. Durable consumer resumes from last ack. |
| **Bridge Indexer down** | Bridge data stale. Explorer unaffected. | Heartbeat stops. | Restart. Durable consumer resumes. |

### 7.4 Idempotent Writes

All database operations use upserts keyed on natural identifiers (transaction hash, sequence number, action state).

### 7.5 Rollback Handling (Zeko-M Specific)

Zeko-M has two categories of rollback scenarios. Zeko-E will define its own rollback model based on Ethereum finality when that deployment is built.

#### Scenario 1: L1 Fork Invalidates a Commit or Deposit

Mina L1 has probabilistic finality (~290 blocks). If a fork occurs and the new canonical chain does not contain:
- A **batch settlement transaction** that the sequencer had committed, or
- A **deposit action** that the sequencer had already accepted and credited on L2

...then the sequencer must revert the affected L2 state.

**Detection path:** The L1 Watcher monitors the canonical tip via the L1 live node. When a previously-seen L1 block is orphaned, it publishes to `zeko.l1.rollbacks` with the affected batch/deposit details. The sequencer independently detects the same fork and reverts its L2 state, which the Sequencer Connector detects and publishes to `zeko.l2.rollbacks`.

**Explorer impact:**
- Batch `settlement_status` reverts from "settling" to "pending" (or "rolled_back" if the batch itself is invalidated).
- If deposits were reverted: the credited L2 transactions are marked "reverted" with `rollback_reason`. Account balances updated. Bridge operation status updated.
- The explorer shows the full history: the original settlement, the rollback, and any re-settlement.

**Settlement finality indicator (Zeko-M):** Batches settled in L1 blocks <290 confirmations deep display "settling." Batches ≥290 deep display "finalized." Rolled-back batches display "rolled back." **The explorer never reports "finalized" until the L1 block is ≥290 deep.**

#### Scenario 2: Time Precondition Expiry

A transaction with a `valid_until` time precondition is accepted by the sequencer and applied to the L2 ledger. If the sequencer does not commit the batch to L1 before the precondition's slot deadline (e.g., because L1 is congested and doesn't produce a block in time), the transaction becomes invalid. The sequencer reverts it.

**Detection path:** The sequencer reverts the transaction from its L2 state. The Sequencer Connector detects this and publishes to `zeko.l2.rollbacks`.

**Explorer impact:**
- The transaction status changes from "applied" to "reverted" with `rollback_reason: "time_precondition_expired"`.
- Account balances updated to reverse the transaction's effects.
- `account_activity` records the reversal.

#### Rollback Signaling — Prerequisite Investigation

**The exact mechanism by which the sequencer signals rollbacks on its internal protocol is not documented publicly.** The mainnet audit scope includes "Recovery" under the sequencer, but the protocol details must be determined by studying the sequencer source code before building the connector.

This investigation must answer:
1. What protocol messages indicate an L2 rollback?
2. Does the connector see rollbacks as explicit events, chain reorganizations, or state contradictions?
3. How should the connector communicate rollbacks to NATS consumers?

**This is a blocking prerequisite for Milestone 1.**

---

## 8. Testing Strategy

### 8.1 Domain-Driven Design

Bounded contexts: Transactions, Accounts, Batches, Bridge (outer/inner actions + operations), ZkApp (events/actions), System Health.

### 8.2 TDD

All domain logic test-first. Unit (mocked repos), integration (real SurrealDB/NATS), E2E (full pipeline).

### 8.3 Gherkin Acceptance Tests

**The scenarios in each milestone are representative examples illustrating expected style and coverage level. A comprehensive suite must be developed covering happy paths, error cases, edge cases, concurrent access, rollback scenarios, degraded states, and recovery flows.**

### 8.4 Test Infrastructure

Fixtures, sequencer mock, ephemeral NATS/SurrealDB per suite, CI gate.

---

## 9. Milestones

### Milestone 1: MCP Server + GraphQL API + Indexing Substrate (Foundation)

**Goal:** The indexing substrate (connectors, NATS, indexers, SurrealDB) and GraphQL APIs are operational. The code-mode MCP server provides agent access to all indexed data. No frontend yet — agents and API consumers are the first users.

**Prerequisite:** Sequencer rollback signaling investigation (Section 7.5).

**Components delivered:**
- Sequencer Connector (OCaml): internal protocol, raw data → NATS, rollback detection.
- L1 Watcher (TypeScript, Mina adapter): L1 live node + archive connections, settlements, outer actions, rollbacks, bridge events.
- DA Monitor (TypeScript): attestation monitoring.
- NATS JetStream: all streams configured.
- Explorer Indexer (language per spike): transaction normalization, account state, batch lifecycle, rollback handling, zkApp events/actions.
- Bridge Indexer (language per spike): outer action indexing, inner action extraction, bridge operation correlation.
- SurrealDB: full schema (all tables), backup cron.
- Explorer GraphQL API (Pothos): transactions, accounts, batches, search, system status, events/actions. SSE subscriptions.
- Bridge GraphQL API (Pothos): outerActions, innerActions, witnesses by aux, commitAsePastSlot, bridgeOperations.
- Code-Mode MCP Server: search() + execute() with generated SDK from both API schemas.
- Nix flake, Docker Compose, CF Worker deployment for APIs + MCP.

**Why MCP first:** The MCP server + APIs provide immediate value to developers and agents. The APIs can be tested, validated, and iterated on before committing to a frontend design. The bridge API immediately replaces `services/actions/api` — the bridge UI can switch to the new endpoint without waiting for the explorer frontend.

**Example Gherkin tests:**

```gherkin
Feature: Transaction Ingestion
  Scenario: A payment transaction is indexed
    Given the sequencer has processed a payment with hash "txn_abc"
    When the connector publishes to NATS and the indexer processes it
    Then the GraphQL API returns the transaction with correct fields
    And account balances are updated

  Scenario: Indexer resumes after restart
    Given the indexer last acknowledged NATS sequence 100
    And 50 new messages are pending
    When the indexer starts
    Then it processes messages 101-150 in order

  Scenario: L2 rollback — time precondition expiry
    Given transaction "txn_xyz" was applied with valid_until slot 500
    When the sequencer reverts it due to time precondition expiry
    And the connector publishes the rollback to NATS
    Then the transaction status becomes "reverted"
    And account balances are reversed

Feature: Bridge Action Indexing
  Scenario: Outer actions queryable by state range
    Given Commit outer actions have been indexed
    When querying outerActions with beforeState and afterState
    Then matching commits are returned with full fields

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
- Frontend (Nuxt 3, CF Workers Static Assets): home, transaction detail, account detail, batch pages, bridge operations page, search, system status, network switcher.
- Design pass deliverables (delegated to designer).

**Features:**

*Home:* Live transaction feed (SSE), stats, search. *Transaction detail:* All fields, decoded zkApp commands, rollback status if reverted. *Account detail:* Balance, nonce, zkApp state, tabs for transactions/events/actions. *Batch overview/detail:* Lifecycle, settlement confidence (settling/finalized/rolled_back). *Bridge operations:* Lifecycle visualization with L1 ↔ L2 links. *Search:* Hash, sequence number, public key, memo full-text. *System health:* Freshness indicator on every page, banner, `/status` page.

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
- L1 Watcher refinements: finality tracking (confirmation depth), robust rollback detection with reconciliation after outages.
- Indexer refinements: settlement confidence computation, L1 rollback → batch reversion → L2 transaction reversion cascade.
- Frontend: settlement confidence indicator, rollback history display, L1 transaction links.

**Note:** Basic batch and settlement indexing is delivered in Milestone 1. This milestone adds the finality model, robust rollback handling, and the L1 outage reconciliation logic.

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
    When it reconnects
    Then it reconciles all settlements and rollbacks from the outage period
```

---

### Milestone 4: Ethereum Support + Public API

**Goal:** Zeko-E network support and public API hardening.

**Components delivered:**
- Ethereum L1 adapter for L1 Watcher: settlement tracking, bridge events, Ethereum-specific finality model.
- DA Monitor update if DA implementation has changed.
- API hardening: rate limiting (CF Worker), API key auth, documentation portal.
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

### 10.1 Current: Nix + Hetzner

- **Nix** for reproducible builds and development environments.
- **OCI containers** for all services.
- **Docker Compose** for local development.
- Deployed on **Hetzner** infrastructure.

### 10.2 Future: Kubernetes

Container design follows 12-factor principles (env-based config, health endpoints, graceful shutdown, stateless services) so migration to Kubernetes is straightforward. No k8s-specific abstractions are introduced until the migration.

### 10.3 Cloudflare Workers

- **Frontend:** Static assets on Cloudflare Workers.
- **API Gateway:** CF Worker in front of both GraphQL APIs. Routes by network and API type (explorer vs bridge). Handles TLS, CORS, future rate limiting.
- **MCP Server:** CF Worker with code-mode sandbox.

---

## 11. Gap Analysis

| Capability | Current | New | Milestone |
|---|---|---|---|
| Transaction browsing | Zekoscan | Real-time, decoded, rollback-aware | 1 (API), 2 (UI) |
| Data freshness | None | Every page | 2 |
| Self-healing | None | NATS durable + idempotent | 1 |
| Custom indexing substrate | None | NATS streams, any consumer | 1 |
| Agent access | None | Code-mode MCP | 1 |
| Batch visibility | None | Full lifecycle | 1 (data), 2 (UI) |
| L1 rollback handling | None | Auto-reversion + display | 3 |
| L2 rollback handling | None | Time precondition + L1 fork | 1 (data), 3 (finality) |
| Bridge operations | Separate services | Unified substrate, shared DB | 1 |
| Outer/inner actions | services/actions/* | NATS consumer, same queries | 1 |
| zkApp events/actions | None | Per-account browsing | 1 (data), 2 (UI) |
| Public API | Archive-Node-API | GraphQL, documented | 4 |
| Ethereum | N/A | L1 adapter | 4 |
| GraphQL federation | N/A | Explorer + Bridge APIs, federatable | Future |

---

## 12. Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Sequencer Connector | OCaml | Internal binary protocol. |
| L1 Watcher | TypeScript | I/O bound, GraphQL client ecosystem. |
| DA Monitor | TypeScript | Small, isolated, I/O bound. |
| NATS | JetStream | Durable, replay, extensible substrate. |
| Explorer Indexer | TBD (Rust or TS) | Milestone 1 spike. |
| Bridge Indexer | TBD (same as explorer) | Same spike, same rationale. |
| Database | SurrealDB (single node, shared) | Graph, record links, FTS, live queries. |
| Explorer API | TypeScript, Pothos | Code-first, SSE, relay pagination. |
| Bridge API | TypeScript, Pothos | Separate endpoint, same tech. |
| MCP Server | TypeScript, CF Worker | Code-mode + generated SDK. |
| Frontend | Nuxt 3, CF Workers Static Assets | SPA, edge. Design delegated. |
| Testing | Gherkin, Vitest | Living docs + unit/integration. |
| Build | Nix | Reproducible. |
| Containers | OCI/Docker | Hetzner now, k8s-ready. |
| Edge | Cloudflare Workers | Static assets, API gateway, MCP. |
