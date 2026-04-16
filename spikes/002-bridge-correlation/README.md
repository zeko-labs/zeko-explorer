# Spike 002: Bridge Operation L1 ↔ L2 Correlation

**Status:** Complete
**Blocking:** Milestone 1 (bridge indexer)
**Owner:** TBD
**Results:** [results.md](./results.md)

---

## Context

A bridge operation spans two chains — e.g., a deposit locks funds on L1 and mints on L2, a withdrawal burns on L2 and unlocks on L1. The current bridge indexer in `zeko-ui` has **no indexed per-user bridge operation history**. It performs full archive scans for each wallet that connects to the UI. This is the primary problem to solve.

The new bridge indexer must correlate L1 and L2 events into unified `bridge_operation` records, indexed by user public key for efficient per-user queries.

---

## Questions to Answer

### 1. Correlation Key

- **Hypothesis:** The `aux` field is the correlation key between L1 outer actions (Witnesses) and L2 inner actions.
- **Verify:** Is `aux` unique per bridge operation? Is it present on both sides? Are there edge cases where correlation fails (e.g., failed operations, partial operations)?
- **Investigate:** Trace a complete deposit and withdrawal through both L1 and L2 archives. Document the exact fields available on each side.

### 2. Data Model

- What fields does a `bridge_operation` record need?
- How do graph edges work in SurrealDB for `l1_tx → bridge_op → l2_tx`?
- How is the `bridge_operation` indexed for per-user queries? By sender public key? By both source and destination?

### 3. Partial Records

- When one side of a bridge operation arrives before the other (e.g., L2 mint indexed before L1 lock is seen), the indexer should create a partial record and complete it later.
- What status transitions does a bridge operation go through? `initiated → pending_proof → submitted → confirmed → failed/rolled_back`?
- How does the UI display partial operations ("bridge operation in progress — waiting for L2 confirmation")?

### 4. Existing Code Analysis

- Study the current `zeko-ui/services/actions/indexer` and `zeko-ui/services/actions/api`:
  - How does it currently query outer and inner actions?
  - What queries does the bridge UI make?
  - Where are the performance bottlenecks (full archive scans)?
  - What data is available that isn't currently being used for correlation?

---

## Deliverables

1. **Correlation key verification:** Confirm `aux` (or identify the actual key) with traced examples.
2. **Bridge operation lifecycle:** Complete state machine with transitions and triggers.
3. **SurrealDB schema draft:** `bridge_operation` table with graph edges, indexes, and per-user query support.
4. **Migration path:** How the bridge UI switches from `services/actions/api` to the new bridge GraphQL API without downtime.

---

## References

- [WEB-415](https://linear.app/zeko-labs/issue/WEB-415) — Index L1 deposit submissions so bridge bootstrap no longer scans wallet archive history
- `zeko-ui/services/actions/indexer` — current bridge indexer source
- `zeko-ui/services/actions/api` — current bridge API source
- `zeko/src/app/zeko/circuits/` — OCaml smart contract code (cancel deposit behavior)
- L1 Zeko zkApp contract — outer action structure (Commits, Witnesses)
- L2 inner account — inner action structure
