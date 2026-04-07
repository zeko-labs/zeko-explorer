# Spike 001: Sequencer Connector — Crash Recovery, Resume, and Rollback Signaling

**Status:** Complete
**Blocking:** Milestone 1
**Owner:** TBD
**Results:** [results.md](./results.md)

---

## Context

The sequencer connector is the single entry point for all L2 blockchain data into the NATS event log. It speaks the sequencer's internal binary protocol (OCaml) and publishes raw, unprocessed events to NATS JetStream.

Two open design questions must be resolved before implementation:
1. **Module vs. microservice** — should the connector be a standalone process or a module within the sequencer?
2. **Crash recovery and resume** — how does the connector know where to pick up after a restart?
3. **Rollback signaling** — how does the sequencer communicate rollbacks on its internal protocol?

---

## Questions to Answer

### 1. Module vs. Microservice

- If the connector is a **module within the sequencer**, the sequencer owns the NATS publishing lifecycle. Crash recovery is simplified — the sequencer knows its own state and can resume publishing from where it left off.
- If the connector is a **standalone microservice**, it needs its own checkpoint mechanism and must handle sequencer disconnections, reconnections, and state reconciliation.

**Investigate:** What are the tradeoffs for embedding NATS publishing into the sequencer vs. running it as a sidecar? What is the blast radius of adding a NATS dependency to the sequencer process?

### 2. Crash Recovery and Resume

- How does the existing **archive relay** handle this boundary? What are the known issues?
- Does the sequencer support cursor-based consumption ("give me blocks from height N")?
- If the connector crashes mid-publish, can it detect and skip already-published messages (idempotent NATS publishes with deduplication)?
- What checkpointing mechanism is needed? Options: NATS message dedup window, persisted cursor in NATS KV, file-based checkpoint, sequencer-managed offset.

**Investigate:** Study the archive relay source code (`zeko/` repo) to understand:
- How it connects to the sequencer
- How it handles disconnections and reconnections
- What data it receives and in what format
- Known failure modes and bugs

### 3. Rollback Detection

The sequencer does **not** emit explicit rollback events. Rollback detection is inferred from **ledger hash chain continuity** — the same mechanism the archive relay uses today:

1. The connector tracks the last processed ledger hash.
2. On each poll, it checks whether there is a contiguous chain of transactions between the last known ledger hash and the current sequencer state.
3. If the chain is broken, a fork has occurred. The connector walks back to the common ancestor, identifies rolled-back transactions, and fetches the new canonical transactions.

**What is already known:**
- The archive relay implements this pattern today.
- There are known issues with the archive relay's implementation at this boundary.

**Investigate:**
1. Study the archive relay's fork detection code. What are the known failure modes?
2. How does the connector determine the common ancestor ledger hash efficiently?
3. Are there race conditions (e.g., connector polls mid-rollback while the sequencer is still reverting)?
4. What happens if the connector is down during a rollback and reconnects after — can it still detect the fork from the current state?
5. Design the NATS rollback event schema. Proposed: `zeko.l2.rollbacks` with `{from_ledger_hash, to_ledger_hash, rolled_back_tx_hashes[], new_canonical_range, reason}`.

---

## Deliverables

1. **Decision document:** Module vs. microservice, with justification.
2. **Archive relay analysis:** How it works today, known issues, what to improve.
3. **Resume strategy:** Concrete mechanism for crash recovery with implementation sketch.
4. **Rollback event schema:** NATS message format for `zeko.l2.rollbacks`.
5. **Prototype:** Minimal OCaml code demonstrating sequencer → NATS publishing with the chosen approach.

---

## References

- Sequencer source code (`zeko/` directory — block production, recovery logic)
- Archive relay source code
- Mainnet audit scope (recovery section)
- NATS JetStream deduplication: https://docs.nats.io/nats-concepts/jetstream/headers#message-deduplication
