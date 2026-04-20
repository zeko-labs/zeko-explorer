# Spike 003: zkApp State, Events, and Actions Display

**Status:** Complete
**Blocking:** Milestone 1 (explorer indexer schema + contract registry backend), Milestone 2 (frontend display + verification wizard)
**Owner:** TBD
**Results:** [results.md](./results.md)
**Addendums:**
- [addendum-contract-verification.md](./addendums/addendum-contract-verification.md) — KV-backed contract registry, sandboxed verification service, owner-claim flow
**Test scenarios:** [test-scenarios/](./test-scenarios/) — Gherkin coverage for ingestion, rollback, registry lookup, verification pipeline, owner claims

---

## Context

zkApps on Mina/Zeko have on-chain state (8 field elements), events, and actions that are raw field arrays — no standardized ABI or schema registry like EVM. The explorer needs to display this data meaningfully.

This is **not an EVM problem** — there are no ABIs to decode against. The solution must be Mina/Zeko-native.

---

## Questions to Answer

### 1. Current State of the Art

- **How does Zekoscan currently display zkApp state?** Raw field elements? Any decoding? Any labeling?
- **How does Minascan (L1 explorer) display zkApp state?** Any patterns to borrow?
- **Are there any community conventions** for annotating zkApp state fields (e.g., a metadata file published alongside the contract)?

### 2. Contract Data Patterns

- **How are zkApp events and actions structured in practice?** Are there common patterns across Zeko contracts?
- **Is there a way to associate field labels with a deployed contract?** E.g., a verification key → ABI-like mapping, or a published metadata JSON.
- **For Zeko's own contracts** (bridge contract, etc.), can we hardcode the field labels since we control the source?

### 3. Display Strategy

Options to evaluate:
1. **Raw fields only** — display field elements as hex/decimal with copy buttons. Minimal effort, covers developer needs.
2. **Known contract registry** — hardcode field labels for Zeko's own contracts. Raw for everything else.
3. **User-submitted schemas** — allow contract deployers to submit field labels. Community-driven.
4. **Verification key mapping** — if the verification key uniquely identifies a contract version, use it as a lookup key for field schemas.

### 4. Events and Actions Specifically

- How are zkApp events emitted and stored? What fields are available beyond the raw data?
- How are zkApp actions different from events in terms of structure and use?
- What queries do developers typically run against events/actions? (e.g., "all events from contract X after sequence N")

---

## Deliverables

1. **Survey:** How Zekoscan, Minascan, and any other Mina explorers display zkApp data today.
2. **Recommendation:** Display strategy for Milestone 1 (API + contract registry backend) and Milestone 2 (UI + verification wizard), with justification.
3. **Schema impact:** Any changes needed to the `zkapp_event` / `zkapp_action` / `account` SurrealDB tables based on findings.
4. **Contract registry design:** A cryptographically-grounded registry keyed by verification key hash, populated by a sandboxed verification service, with an owner-claim flow — see `addendums/addendum-contract-verification.md`.

---

## References

- Zekoscan — current explorer (examine zkApp transaction display)
- Minascan — Mina L1 explorer
- Mina zkApp documentation — event/action structure
- Zeko bridge contract source — field layout for hardcoded labels
