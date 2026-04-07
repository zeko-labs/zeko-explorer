# Addendum: Adding Rollback Events to the Sequencer

This addendum explores the theoretical improvement of adding rollback event publishing to the sequencer. After analysis, this is **not recommended** — the complexity is high and the current consumer-side detection design (see results.md Section 5) is sufficient.

## Why Adding Sequencer Rollback Events Is Not Desirable

### No Runtime Rollback Mechanism Exists

The sequencer has no code path that reverts previously applied L2 state during operation:
- Slot range validation is pre-emptive (reject before apply)
- L1 forks are not detected at runtime
- Expired commit slots cause a fatal crash

Adding rollback events requires first **building the rollback mechanism itself** — it's not just about publishing an event.

### Complexity Is High for All Paths

| Feature | Effort | Risk | What it requires |
|---|---|---|---|
| **Startup divergence detection** | ~50 LOC | Low | Compare pre/post-sync hashes. But only catches restarts, not runtime issues. Limited value. |
| **L1 fork detection** | ~500+ LOC | High | New L1 monitoring subsystem, L1-to-L2 dependency tracking, L2 state revert capability. Major architectural change. |
| **Graceful commit expiry** | ~200 LOC | Medium | Batch state tracking and ledger revert capability. The sequencer doesn't currently support reverting applied transactions. |

### Consumer-Side Detection Already Works

The indexer's hash-chain-continuity checking (results.md Section 5) handles all rollback scenarios without any sequencer changes. The only downside is slightly more complex indexer logic and no "reason" field — but the indexer can infer context from the gap pattern.

## Proposed Rollback Event Schema (For Reference Only)

If this were ever implemented:

```json
{
  "common_ancestor_ledger_hash": "<hash>",
  "rolled_back_from_ledger_hash": "<hash>",
  "new_tip_ledger_hash": "<hash>",
  "rolled_back_count": 3,
  "detected_at": "<ISO 8601>",
  "reason": "restart_resync | l1_fork | commit_slot_expired | manual"
}
```
