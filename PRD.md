# PRD: Zeko Block Explorer & Indexing Substrate

**Author:** Zeko Labs
**Status:** Draft v6 (post design review)
**Last Updated:** April 1, 2026

---

## 1. Executive Summary

Zeko currently relies on Zekoscan (third-party, Blockberry/Staketab), which suffers from reliability issues, stale data, and a complete lack of L2 concepts. Zeko has no control over its roadmap.

This document defines a **general-purpose indexing substrate** for the Zeko network and a **greenfield block explorer** as its first consumer. At the foundation, connector services publish raw blockchain events to NATS JetStream streams. A unified indexer consumes these streams, normalizes data, and writes to SurrealDB. The explorer is exposed via a code-first GraphQL API (Pothos) with SSE subscriptions, a code-mode MCP server for agent interaction, and a Nuxt 3 SPA frontend. A separate Bridge GraphQL API replaces the existing bridge actions services.

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
- No rollback modeling for either L1 settlement reversals or L2 sequencer rollbacks.
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

Each network runs its own sequencer, DA layer, and **full explorer backend stack** (connectors, NATS, indexer, SurrealDB, APIs). Full stack isolation per network — separate NATS and SurrealDB instances. No cross-network namespacing needed; the instance itself identifies the network.

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
│  │ (internal    │  │ (Mina or     │  │                       │  │
│  │  protocol)   │  │  Ethereum)   │  │                       │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
└─────────┼─────────────────┼──────────────────────┼──────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌──────────────────┐ ┌──────────────┐ ┌────────────────────────────┐
│ Sequencer        │ │ L1 Watcher   │ │ DA Monitor                 │
│ Connector        │ │ (TypeScript) │ │ (TypeScript)               │
│ (OCaml module)   │ │              │ │                            │
│                  │ │ Live: tip,   │ │                            │
│ Raw data → NATS  │ │  rollbacks   │ │                            │
│                  │ │ Archive:     │ │                            │
│                  │ │  actions,    │ │                            │
│                  │ │  history     │ │                            │
└────────┬─────────┘ └──────┬───────┘ └──────────┬─────────────────┘
         │                  │                    │
         ▼                  ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                     NATS JetStream                              │
│                 (indexing substrate)                             │
│                                                                 │
│  Streams (raw, unprocessed):                                    │
│  • zeko.l2.transactions    • zeko.l1.settlements                │
│  • zeko.l2.rollbacks       • zeko.l1.rollbacks                  │
│  • zeko.l1.outer-actions   • zeko.l1.bridge-events              │
│  • zeko.da.attestations    • zeko.health                        │
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
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                SurrealDB (single node)                           │
│          (rebuildable read model — NATS is source of truth)     │
│                                                                 │
│  Tables: transaction, account, account_activity, batch,         │
│  zkapp_event, zkapp_action, outer_action, inner_action,         │
│  bridge_operation, sync_status, network_stats                   │
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

#### 5.2.1 Sequencer Connector (OCaml)

OCaml module speaking the sequencer's internal binary protocol. Publishes **raw, unprocessed** data to NATS. No normalization. May be implemented as a module within the sequencer itself rather than a standalone microservice — this simplifies the crash recovery / resume story since the sequencer owns the NATS publishing lifecycle.

**Why OCaml:** The binary protocol is defined in the Mina/Zeko OCaml codebase. The Zeko team already uses OCaml. Both the connector and a hypothetical API approach would require OCaml code — the connector avoids an extra hop (sequencer → GraphQL API → TS adapter → NATS) by publishing directly to NATS.

**Responsibilities:**
- Connect to sequencer via internal protocol, subscribe to blocks/transactions.
- Bootstrap for historical replay.
- Publish raw data to `zeko.l2.transactions`.
- **Detect and publish L2 rollback events** to `zeko.l2.rollbacks` (see Section 7.5).
- Publish heartbeats to `zeko.health`.

**L2 rollback detection (known mechanism):** The connector does not receive explicit rollback events from the sequencer. Instead, rollback detection is based on **ledger hash chain continuity** — the same mechanism used by the archive relay today. The connector fetches the latest state and checks whether there is a contiguous chain of transactions between the last processed ledger hash and the current sequencer state. If the chain is broken (i.e., no path from the last known ledger hash to the current one), a fork has occurred. In that case, the connector fetches transactions between the older (common ancestor) ledger hash and the current sequencer state, determines which transactions were rolled back and which are new, and publishes rollback events to `zeko.l2.rollbacks`. See `spikes/001-sequencer-connector.md` for the full spike on improving this mechanism over the archive relay's implementation.

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

**L1 adapter interface:** Abstract interface supporting both Mina and Ethereum L1s. Mina implementation first (Zeko-M). Ethereum adapter added in Milestone 4. The L1 Watcher emits events at multiple finality levels — consumers decide which level they care about. L1 reorg handling stays within the watcher; consumers receive clean rollback events.

#### 5.2.3 DA Monitor (TypeScript)

Small, isolated service monitoring the DA layer for attestation status. Isolated behind NATS so the rest of the system is unaffected when the DA implementation changes (Ethermint → Celestia). Provides attestation metadata only.

#### 5.2.4 NATS JetStream

Shared indexing substrate and **authoritative source of truth**. Streams carry raw, unprocessed data. Each consumer normalizes independently. Retention is unbounded — the full event history is preserved from the moment JetStream starts ingesting.

SurrealDB is a rebuildable read model. If the database ever needs to be rebuilt, replaying the full NATS history is sufficient. L1/L2 archives are only used for pre-NATS historical data or catastrophic scenarios.

**Durable consumers** with at-least-once delivery. Combined with idempotent writes = exactly-once processing semantics.

**Extensibility:** Any future service creates a durable consumer on existing streams and builds its own materialization.

**NATS is dedicated to the indexing pipeline.** It is not used for UI real-time delivery (SSE fan-out uses SurrealDB live queries at the GraphQL layer).

#### 5.2.5 Zeko Indexer (TypeScript)

A single unified indexer consuming all NATS streams. Normalizes raw data and writes to SurrealDB — both explorer tables (transactions, accounts, batches, zkApp events/actions) and bridge tables (outer actions, inner actions, bridge operations).

**Language: TypeScript.** The indexer is I/O-bound (read from NATS, transform, write to SurrealDB). TypeScript enables shared domain types across the indexer, APIs, and the MCP server, reducing surface area for bugs. Rust remains an option only if profiling reveals a concrete performance bottleneck.

**Consumes:**
- `zeko.l2.transactions` → `transaction`, `account`, `account_activity`, `zkapp_event`, `zkapp_action`.
- `zeko.l2.rollbacks` → revert affected transactions and account states (Section 7.5).
- `zeko.l1.settlements` → create/update `batch`, link to transactions.
- `zeko.l1.rollbacks` → revert batch settlement status (Section 7.5).
- `zeko.da.attestations` → attach status to batch records.
- `zeko.l1.outer-actions` → `outer_action` (Commits, Witnesses). Queryable by state range.
- `zeko.l2.transactions` → extract inner actions → `inner_action`. Queryable by state range.
- `zeko.l1.bridge-events` → `bridge_operation` with graph edges to L1 and L2 transactions.
- Maintains `sync_status`, computes `network_stats`.

**Bridge operation correlation:** L1 and L2 sides of a bridge operation are correlated via the `aux` field (needs verification — see `spikes/002-bridge-correlation.md`). Partial records are created when the first side arrives and completed when the second side shows up. This enables indexed per-user bridge history, replacing the current full archive scan approach.

**Rollback handling:** The indexer subscribes to both `zeko.l2.rollbacks` and `zeko.l1.rollbacks`. On rollback events, it reverts affected explorer data (transactions, accounts, batches) and bridge data (bridge operations, outer/inner actions) in a single cascade.

#### 5.2.6 SurrealDB (Single Node)

Graph relations, record links, full-text search, live queries, schemaful mode. **Rebuildable read model** — NATS JetStream is the source of truth.

Schema migrations managed via [surrealdb-migrations](https://github.com/Odonno/surrealdb-migrations).

**Live query scaling:** The GraphQL APIs fan out from shared live queries. One `LIVE SELECT` per watched subscription type, not per client. API servers manage per-client filtering and SSE fan-out at the GraphQL layer.

**Guideline data model** (the following is indicative of the expected tables and relationships — the actual schema will be refined during implementation):

*Explorer tables:*
- `transaction` — hash, sequence_number, type, status, sender/receiver account links, amount, fee, nonce, memo, timestamp, state_hash, decoded account_updates, batch link, rollback_reason.
- `account` — public_key (indexed, full-text searchable), balance, nonce, delegate link, token_id, zkapp_state.
- `account_activity` — per-account per-transaction changes, including rollback entries.
- `batch` — transaction range, proof/settlement status, L1 settlement details, DA attestation status, timestamps.
- `zkapp_event` / `zkapp_action` — emitting account and transaction links, decoded fields, sequence/state hash.
- `sync_status` — per-source health: last processed item, timestamp, lag, error state.
- `network_stats` — aggregates.

*Bridge tables:*
- `outer_action` — kind (COMMIT/WITNESS), before/after state, block height, fields, timestamp. Commits include inner_action_state, ledger, slot range. Witnesses include aux. Links to batch, bridge_operation.
- `inner_action` — before/after state, aux, block height, fields, timestamp. Links to transaction.
- `bridge_operation` — type (deposit/withdrawal), status lifecycle, amount, source/destination accounts, timestamps. Graph edges: `l1_tx → bridge_op → l2_tx`. **Indexed by user public key** for efficient per-user queries.

**Backup:**
- `surreal export` cron: 6h (devnet/alphanet), 1h (mainnet).
- Object storage (R2 or S3-compatible). Retention: 7d / 30d.
- Full re-index from NATS always available as DR.
- Restore procedure documented and tested.

#### 5.2.7 Explorer GraphQL API (TypeScript, Pothos)

Code-first GraphQL. SSE subscriptions (fan-out from SurrealDB live queries). Hosted on Hetzner, fronted by Cloudflare as a reverse proxy (rate limiting, DDoS protection, CORS, TLS).

Cursor-based pagination (not necessarily full Relay spec — see `spikes/005-relay-pagination.md`).

Queries: transactions, accounts, batches, search, system status, zkApp events/actions. Can read bridge tables for display on transaction/account detail pages.

Every response includes `_meta` with `dataFreshness`, `syncLag`, `status`.

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

### 5.3 Bridge Actions Services Migration

The existing `zeko-ui` bridge actions services (`services/actions/indexer`, `services/actions/api`) provide indexed bridge data to the bridge UI. They:

- Read **outer actions** (Commits, Witnesses) from the **L1 archive** — batch settlements and bridge proofs on the Mina L1 Zeko zkApp contract.
- Read **inner actions** from the **L2 archive** — L2-side bridge actions on the inner account.
- Insert into PostgreSQL, expose via GraphQL with queries: `outerActions(beforeState, afterState)`, `innerActions(beforeState, afterState)`, `commitAsePastSlot(slot)`, witness lookups by aux.

These services are **not replaced by the explorer frontend** — they serve the bridge UI, which is a different product. Instead, the underlying indexing pipeline is unified: the Zeko Indexer (Section 5.2.5) indexes both explorer and bridge data from the same NATS streams into a single SurrealDB instance.

A **Bridge GraphQL API** (TypeScript, Pothos) is a separate endpoint backed by the same database. It serves the bridge UI and replaces `services/actions/api`. Hosted on Hetzner, fronted by Cloudflare. Queries: outerActions, innerActions, witnesses by aux, commitAsePastSlot, bridgeOperations.

**GraphQL federation:** The explorer and bridge APIs are separate services now. In the future, they can be composed into a federated supergraph, providing a single endpoint that delegates to each service.

**Key improvement:** Per-user bridge operation history is indexed by public key, replacing the current full archive scan per wallet.

---

## 6. Project Structure — Monorepo

The monorepo is a pure TypeScript + Nuxt project managed with **pnpm workspaces + moonrepo**. The OCaml sequencer connector lives in the sequencer repository (as a module of the sequencer), not in this monorepo.

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
│   │       ├── domain/
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

NATS durable consumers resume from last ack. Sequencer connector bootstrap for full replay. Idempotent writes.

### 7.3 Graceful Degradation and Recovery

| Failure | Impact | Detection | Recovery |
|---|---|---|---|
| **Sequencer down** | No new L2 transactions indexed. | Connector heartbeat stops → `sync_status` updated → frontend shows degraded. | Connector reconnects when sequencer returns. If rollbacks occurred during downtime, connector detects new state on reconnect (see Section 7.5). NATS durable consumer resumes. Gap backfilled via bootstrap if needed. |
| **L1 live node down** | Cannot track tip or detect L1 rollbacks. Settlement status frozen. | L1 Watcher heartbeat degrades → `sync_status` → "L1 status unknown." | Watcher reconnects, re-scans from last known L1 height. Reconciles settlements and rollbacks that occurred during outage. |
| **L1 archive down** | Outer action indexing paused. Existing data still queryable. | Watcher reports archive unreachable. | Watcher reconnects, backfills missed actions from last indexed state. |
| **DA layer down** | Attestation status "unknown." Everything else unaffected. | DA Monitor reports unreachable. | Reconnect, backfill missed attestations. |
| **SurrealDB down** | All APIs return errors. No data served. | Health checks detect. | Container restart. If corrupted: restore from backup or full re-index from NATS. |
| **NATS down** | All ingestion halted. Existing data still served. | All connectors report publishing failures. | NATS restart. JetStream persistence recovers stream state. Durable consumers resume. |
| **Indexer down** | No new data (explorer or bridge). Stale warning shown. | Heartbeat stops. | Restart. Durable consumer resumes from last ack. |

### 7.4 Idempotent Writes

All database operations use upserts keyed on natural identifiers (transaction hash, sequence number, action state).

### 7.5 Rollback Handling (Zeko-M Specific)

Zeko-M has two categories of rollback scenarios. Zeko-E will define its own rollback model based on Ethereum finality when that deployment is built.

**Rollback events are published to NATS.** When a rollback is detected, a dedicated rollback event is published to the relevant NATS subject (`zeko.l2.rollbacks` or `zeko.l1.rollbacks`). The indexer subscribes to both and handles all revert cascades — explorer data, bridge data, and account state — in a unified pass.

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

**Settlement finality indicator (Zeko-M):** The L1 Watcher emits events at multiple finality levels. Batches settled in L1 blocks <290 confirmations deep display "settling." Batches ≥290 deep display "finalized." Rolled-back batches display "rolled back." **The explorer never reports "finalized" until the L1 block is ≥290 deep.**

#### Scenario 2: Time Precondition Expiry

A transaction with a `valid_until` time precondition is accepted by the sequencer and applied to the L2 ledger. If the sequencer does not commit the batch to L1 before the precondition's slot deadline (e.g., because L1 is congested and doesn't produce a block in time), the transaction becomes invalid. The sequencer reverts it.

**Detection path:** The sequencer reverts the transaction from its L2 state. The Sequencer Connector detects this and publishes to `zeko.l2.rollbacks`.

**Explorer impact:**
- The transaction status changes from "applied" to "reverted" with `rollback_reason: "time_precondition_expired"`.
- Account balances updated to reverse the transaction's effects.
- `account_activity` records the reversal.

#### Rollback Detection Mechanism

**There is no explicit rollback event from the sequencer.** Rollback detection is inferred from ledger hash chain continuity — the same approach the archive relay uses today:

1. The connector tracks the **last processed ledger hash**.
2. On each poll, it fetches the sequencer's current state and checks for a contiguous chain of transactions linking the last known ledger hash to the current one.
3. **If the chain is contiguous:** Normal operation — new transactions are published to `zeko.l2.transactions`.
4. **If the chain is broken (fork detected):** The connector walks back to the common ancestor ledger hash, determines which previously-published transactions are no longer in the canonical chain, and publishes rollback events to `zeko.l2.rollbacks`. It then fetches transactions between the common ancestor and the current sequencer state to publish the new canonical chain.

**Known issues with the archive relay's implementation of this pattern** must be studied and improved upon. See `spikes/001-sequencer-connector.md` for the full investigation scope.

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
- **Fixture diversity:** Normal blocks, empty blocks, zkApp transactions, bridge operations, rollback events. Grow the fixture set as edge cases are encountered.
- Ephemeral instances per test suite. CI gate.

---

## 9. Milestones

### Pre-Milestone: Research Spikes

Before Milestone 1 implementation begins, the following spikes must be completed. Each has a dedicated document in `spikes/`.

1. **Sequencer Connector** (`spikes/001-sequencer-connector.md`) — crash recovery, resume strategy, rollback signaling, module-vs-microservice.
2. **Bridge Operation Correlation** (`spikes/002-bridge-correlation.md`) — verify `aux` as correlation key, design per-user indexed bridge history.
3. **zkApp State Display** (`spikes/003-zkapp-state-display.md`) — investigate how to display zkApp state, events, and actions.
4. **Deployment Topology** (`spikes/004-deployment-topology.md`) — single vs. multi host, Nix vs. Docker Compose for production.
5. **Pagination Schema** (`spikes/005-relay-pagination.md`) — cursor-based pagination schema, Relay spec tradeoffs.

### Milestone 1: MCP Server + GraphQL API + Indexing Substrate (Foundation)

**Goal:** The indexing substrate (connectors, NATS, indexer, SurrealDB) and GraphQL APIs are operational. The code-mode MCP server provides agent access to all indexed data. No frontend yet — agents and API consumers are the first users.

**Components delivered:**
- Sequencer Connector (OCaml, in sequencer repo): internal protocol, raw data → NATS, rollback detection.
- L1 Watcher (TypeScript, Mina adapter with abstract L1 interface): L1 live node + archive connections, settlements, outer actions, rollbacks, bridge events.
- DA Monitor (TypeScript): attestation monitoring.
- NATS JetStream: all streams configured, unbounded retention.
- Zeko Indexer (TypeScript): unified indexing of explorer data (transactions, accounts, batches, zkApp events/actions) and bridge data (outer actions, inner actions, bridge operations). Rollback handling for both.
- SurrealDB: schema + migrations via surrealdb-migrations, backup cron.
- Explorer GraphQL API (Pothos): transactions, accounts, batches, search, system status, events/actions. SSE subscriptions.
- Bridge GraphQL API (Pothos): outerActions, innerActions, witnesses by aux, commitAsePastSlot, bridgeOperations.
- Code-Mode MCP Server: search() + execute() with generated SDK from both API schemas.
- Per-concern packages: `nats-protocol`, `domain`, `db`.
- Nix flake, Docker Compose + wrangler for local dev, CF Worker deployment for MCP, Cloudflare reverse proxy for APIs.

**Why MCP first:** Shipping MCP + APIs is significantly faster than building a frontend — the MCP server is nearly trivial with graphql-codegen. People will use agents to visualize and query explorer data more than the UI. The bridge API immediately replaces `services/actions/api` — the bridge UI can switch to the new endpoint without waiting for the explorer frontend.

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
- Frontend (Nuxt 3 SPA, CF Workers Static Assets): home, transaction detail, account detail, batch pages, bridge operations page, search, system status, network switcher.
- Design pass deliverables (delegated to designer).

**Features:**

*Home:* Live transaction feed (SSE), stats, unified search bar with auto-detection (hash format, `B62` public key prefix, numeric sequence number, free-text memo fallback). *Transaction detail:* All fields, zkApp data display (see spike results), rollback status if reverted. *Account detail:* Balance, nonce, zkApp state, tabs for transactions/events/actions. *Batch overview/detail:* Lifecycle, settlement confidence (settling/finalized/rolled_back). *Bridge operations:* Lifecycle visualization with L1 ↔ L2 links, per-user bridge history. *System health:* Freshness badge on every page, degradation banner, operator `/status` page.

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
| L2 rollback handling | None | Time precondition + L1 fork | 1 (data), 3 (finality) |
| Bridge operations | Separate services | Unified indexer, shared DB | 1 |
| Per-user bridge history | Full archive scan per wallet | Indexed by public key | 1 |
| Outer/inner actions | services/actions/* | NATS consumer, same queries | 1 |
| zkApp events/actions | None | Per-account browsing | 1 (data), 2 (UI) |
| Public API | Archive-Node-API | GraphQL, documented | 4 |
| Ethereum | N/A | L1 adapter | 4 |
| GraphQL federation | N/A | Explorer + Bridge APIs, federatable | Future |

---

## 12. Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Sequencer Connector | OCaml (sequencer module) | Internal binary protocol. Lives in sequencer repo. |
| L1 Watcher | TypeScript | I/O bound, GraphQL client ecosystem. Abstract L1 interface. |
| DA Monitor | TypeScript | Small, isolated, I/O bound. |
| NATS | JetStream (unbounded retention) | Durable, replay, extensible substrate. Source of truth. |
| Zeko Indexer | TypeScript | I/O bound. Shared types with APIs. Rust only if perf bottleneck. |
| Database | SurrealDB (single node) | Graph, record links, FTS, live queries. Rebuildable from NATS. |
| DB Migrations | surrealdb-migrations | Mature migration tooling for SurrealDB. |
| Explorer API | TypeScript, Pothos | Code-first, SSE, cursor-based pagination. |
| Bridge API | TypeScript, Pothos | Separate endpoint, same tech. |
| MCP Server | TypeScript, CF Worker | Code-mode + generated SDK. Service bindings. |
| Frontend | Nuxt 3 SPA, CF Workers Static Assets | No SSR needed. HTML skeleton + hydration. |
| Search | Unified bar, auto-detect | NL queries in future milestone. |
| Testing | Gherkin, Vitest | Living docs + unit/integration. Real NATS/SurrealDB in Docker. |
| Monorepo | pnpm workspaces + moonrepo | TS-only monorepo. Per-concern shared packages. |
| Build | Nix | Reproducible dev environments. |
| Containers | OCI/Docker | Hetzner now, k8s-ready. |
| Edge | Cloudflare Workers + reverse proxy | Static assets, API gateway, MCP. |
