# Spike 006: L1 Watcher — Settlement Detection, Rollback Handling, and Bridge Events

**Status:** Not started
**Blocking:** Milestone 1 (L1 data ingestion)
**Owner:** TBD

---

## Context

The L1 Watcher is the single entry point for all L1 settlement chain data into the NATS event log. It monitors both a **live L1 node** (for tip tracking and rollback detection) and an **L1 archive** (for outer actions and historical data). It publishes to four NATS subjects: `zeko.l1.settlements`, `zeko.l1.rollbacks`, `zeko.l1.outer-actions`, and `zeko.l1.bridge-events`.

The PRD defines the L1 Watcher at a high level (Section 5.2.2), but the following design questions are unresolved and must be investigated before implementation.

---

## Questions to Answer

### 1. Settlement Detection

- How does the L1 Watcher detect batch settlement transactions on the Zeko zkApp contract?
- What L1 GraphQL queries or subscription mechanisms are available on the Mina daemon?
- What data is available in a settlement transaction? Block height, transaction hash, inner ledger hash, slot range?
- How does the watcher determine which L2 transactions belong to a settled batch?
- What is the polling interval vs. subscription tradeoff for the live node?

### 2. L1 Rollback / Fork Detection

- Mina L1 has probabilistic finality (~290 blocks). How does the watcher track confirmation depth?
- How does the Mina daemon expose chain reorganizations? Is there a reorg event, or must the watcher detect orphaned blocks by comparing canonical chain state?
- What happens if the watcher is down during an L1 fork — can it reconcile after reconnecting?
- What data should the `zeko.l1.rollbacks` event contain? Affected batch IDs, orphaned block heights, affected deposit actions?
- How does the watcher distinguish between a minor tip reorg (1-2 blocks) and a deep fork that invalidates settlements?

### 3. Outer Actions and Bridge Events

- How does the watcher query outer actions (Commits, Witnesses) from the L1 archive?
- What is the query mechanism — `actions` GraphQL query with state range? Action state hash pagination?
- How does the existing `zeko-ui/services/actions/indexer` fetch outer actions today? What can be reused?
- What data is available in bridge deposit/withdrawal events on L1?
- How does the watcher detect new deposits that the sequencer should credit on L2?

### 4. Abstract L1 Interface

- The PRD specifies an abstract L1 interface supporting both Mina and Ethereum. What is the minimal interface that covers both?
- Which operations are L1-specific (e.g., Mina actions vs. Ethereum events) and which are generic (tip tracking, confirmation depth)?
- Should the interface be designed now or deferred until Milestone 4 (Ethereum support)?

### 5. NATS Event Schemas

- Define the exact JSON schemas for `zeko.l1.settlements`, `zeko.l1.rollbacks`, `zeko.l1.outer-actions`, and `zeko.l1.bridge-events`.
- What deduplication keys (`Nats-Msg-Id`) should each use?
- How do these schemas interact with the indexer's batch and bridge operation records?

### 6. Failure Modes and Recovery

- What happens when the L1 live node is unreachable? How does the watcher resume?
- What happens when the L1 archive is unreachable? Can the watcher continue with live-only data?
- How does the watcher backfill missed data after an outage?
- What health/heartbeat data should it publish to `zeko.health`?

---

## Deliverables

1. **Mina L1 API analysis:** Available GraphQL queries/subscriptions on the Mina daemon and archive node relevant to settlement and bridge event detection.
2. **NATS event schemas:** JSON schemas for all four `zeko.l1.*` subjects with example payloads.
3. **Settlement detection design:** Concrete mechanism for detecting batch settlements and tracking confirmation depth.
4. **L1 rollback detection design:** Fork detection algorithm, reconciliation after outages, rollback event format.
5. **Outer action ingestion design:** How outer actions are queried, paginated, and published to NATS.
6. **Abstract L1 interface sketch:** Minimal TypeScript interface that the Mina adapter implements.
7. **Failure mode table:** All failure scenarios with detection and recovery strategies.

---

## References

- PRD Section 5.2.2 (L1 Watcher)
- PRD Section 7.5 Scenario 1 (L1 Fork Invalidates a Commit or Deposit)
- `zeko-ui/services/actions/indexer` — current outer action indexer
- `zeko-ui/services/actions/api` — current bridge API
- Mina daemon GraphQL schema
- Mina archive node GraphQL schema
- Spike 002 (Bridge Operation Correlation) — related, focuses on L2 side correlation
