# Spike 007: DA Monitor — Attestation Status Tracking

**Status:** Not started
**Blocking:** Baseline DA attestation data
**Owner:** TBD

---

## Context

The DA Monitor is a small, isolated TypeScript service that monitors the DA layer (currently Ethermint, planned migration to Celestia) for attestation status. It publishes to `zeko.da.attestations`. The PRD defines it at a high level (Section 5.2.3), but the following design questions are unresolved.

The DA Monitor is intentionally isolated behind NATS so the rest of the system is unaffected when the DA implementation changes. This spike should design for that isolation.

---

## Questions to Answer

### 1. DA Layer Attestation Model

- What does "attestation status" mean concretely for Zeko batches? What states can an attestation be in?
- How does the DA layer confirm that a batch's data is available? Is there a specific API, event, or query?
- What is the relationship between a DA attestation and a batch settlement on L1? Are they independent or sequential?
- What data is available from the DA layer per attestation? Hash, timestamp, block height, confirmation count?

### 2. DA Layer API

- What APIs does the current DA layer (Ethermint) expose? REST, GraphQL, RPC?
- Can the DA Monitor query attestation status without using the OCaml binary RPC? (The backfill service already uses `Da_layer.Client` for diff fetching — the DA Monitor should ideally use a TypeScript-accessible API.)
- If the DA layer only exposes OCaml binary RPC, what is the minimal API surface needed to make attestation status queryable from TypeScript?
- How does the planned Celestia migration change the API surface?

### 3. NATS Event Schema

- Define the exact JSON schema for `zeko.da.attestations`.
- What deduplication key (`Nats-Msg-Id`) should be used?
- How does the indexer use this data? What fields does the `batch` record need from the attestation?

### 4. Polling and Latency

- What is the expected polling interval? How quickly do attestations finalize?
- Is there a subscription/event mechanism, or is polling the only option?
- What is acceptable latency for attestation status in the explorer?

### 5. Failure Modes and Recovery

- What happens when the DA layer is unreachable? How does the monitor resume?
- Can the monitor backfill missed attestations after an outage?
- What health/heartbeat data should it publish to `zeko.health`?
- How does the indexer handle "attestation status unknown" for recent batches?

### 6. Ethermint → Celestia Migration

- What changes when the DA layer migrates from Ethermint to Celestia?
- Should the DA Monitor have an abstract DA interface (similar to the L1 Watcher's abstract L1 interface)?
- What is the expected timeline for this migration relative to explorer milestones?

---

## Deliverables

1. **DA layer API analysis:** Available APIs on Ethermint (and Celestia if accessible) for attestation queries.
2. **Attestation lifecycle:** States, transitions, and what triggers each.
3. **NATS event schema:** JSON schema for `zeko.da.attestations` with example payloads.
4. **Polling/subscription design:** Concrete mechanism for tracking attestation status.
5. **Failure mode table:** All failure scenarios with detection and recovery strategies.
6. **Migration considerations:** How the monitor adapts to Celestia.

---

## References

- PRD Section 5.2.3 (DA Monitor)
- Zeko DA layer source: `zeko/src/app/zeko/da_layer/`
- Ethermint documentation
- Celestia documentation (for migration planning)
- Spike 001 results — backfill service already uses `Da_layer.Client` for diff fetching (OCaml binary RPC)
