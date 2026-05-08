# Spike 006: L1 Watcher — Settlement Detection, Rollback Handling, and Bridge Events

**Status:** Complete
**Blocking:** Milestone 1 (L1 data ingestion)
**Owner:** TBD

---

## Context

The L1 Watcher is the explorer component that reads L1 settlement-chain data through a provider adapter and publishes normalized L1 facts into NATS.

The watcher has shared responsibilities that are independent of the L1 provider: process lifecycle, health, durable cursors, NATS publication, and the `zeko.l1.*` event contract. Provider-specific adapters supply L1 data and decoding.

### Zeko-M / Mina

Milestone 1 implements the Mina adapter. It reads the Mina daemon and Archive-Node-API, decodes Mina actions/account updates/events, applies the Zeko-M finality model, and emits the shared watcher facts.

### Zeko-E / Ethereum

Milestone 4 implements the Ethereum adapter. It reads Ethereum live/archive endpoints, decodes configured settlement and bridge logs/transactions, applies the Zeko-E finality model, and emits the same shared watcher facts.

The watcher publishes to four NATS subjects: `zeko.l1.settlements`, `zeko.l1.rollbacks`, `zeko.l1.outer-actions`, and `zeko.l1.bridge-events`.

The PRD defines the L1 Watcher at a high level (Section 5.2.2), but the following design questions are unresolved and must be investigated before implementation.

Nomenclature used by this spike:

- **L1 Watcher**: the explorer component that publishes normalized L1 facts into NATS.
- **Adapter**: the provider-specific implementation that reads a live L1 source and L1 archive source.
- **Mina adapter**: the Zeko-M provider implementation specified in detail by this spike.
- **Ethereum adapter**: the Zeko-E provider implementation planned for Milestone 4.

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

### 3. Outer Actions Ingestion

- How does the watcher query outer actions (Commits, Witnesses) from the L1 archive?
- What is the query mechanism — `actions` GraphQL query with state range? Action state hash pagination?
- How does the existing `zeko-ui/services/actions/indexer` fetch outer actions today? What can be reused?

### 4. Bridge Event Detection (`zeko.l1.bridge-events`)

Spike 002 established that the indexer requires `zeko.l1.bridge-events` messages to populate `bridge_operation` records with user PKs, amounts, and correlation keys. The L1 Watcher must detect three event types — each with distinct on-chain signatures. See `spikes/002-bridge-correlation/results.md` §3–4 for the full analysis.

#### 4a. Deposit Submission Detection

- The user's `submitDeposit` creates a signed `AccountUpdate` on the **user's own public key** (NOT `OUTER_PK`). This AccountUpdate emits actions containing: `[recipient (2 fields), amount, timeout, holderAccountL1 (2 fields), outerPk (2 fields)]` (`zeko-bridge-sdk/src/index.ts:301-311`).
- The L1 Watcher must observe these user-level transactions, extract the user PK (the signer) and deposit params, and compute `depositAux()` — a Poseidon hash of `(holderAccountL1, amount, recipient, timeout)` (`zeko-bridge-sdk/src/utils.ts:78-86`).
- **This is the canonical deposit submission fact** that eliminates archive scanning (WEB-415). Without this, the indexer cannot populate `bridge_operation.sender` for deposits.
- **Question:** How does the L1 Watcher discover deposit submission transactions? Does it need to scan all L1 blocks for AccountUpdates that interact with the Zeko zkApp contract? Or can it filter by the contract's PK in the transaction's account_updates tree?

#### 4b. Withdrawal Finalization Detection

- The user calls `finalizeWithdrawal` on L1, which triggers `rule_action_witness` (emits a witness action on `OUTER_PK` with `action[1] = aux`) and `rule_bridge_finalize_withdrawal` (emits events containing `(withdrawal_index, withdrawal_params)` at line 256).
- The outer witness is already captured by `zeko.l1.outer-actions`. The bridge event adds the user PK and withdrawal details.
- `withdrawalAux()` computes: `Poseidon.hashWithPrefix("Withdrawal_params - qFB3jXP*)", [Field(0), ...amount.toFields(), ...recipient.toFields()])` (`zeko-bridge-sdk/src/utils.ts:88-94`).

#### 4c. Cancel Deposit Detection

- **Critical finding from spike 002:** Cancel deposit does NOT emit an outer witness action on `OUTER_PK`. The cancel contract rule (`rule_bridge_finalize_cancelled_deposit.ml`) includes `witness_outer` as a precondition witness with **no `actions` field** — only preconditions. See `spikes/002-bridge-correlation/results.md` §4 for the full OCaml contract analysis.
- Cancellation advances the `prevNextCancelledDeposit` counter on `helperAccountL1.zkappState[0]`.
- The L1 Watcher must detect cancel transactions by observing L1 transactions that interact with the Zeko zkApp contract and advance `prevNextCancelledDeposit`.
- **Fallback verification:** The watcher (or indexer) can periodically read `helperAccountL1.zkappState[0]` to verify counter advancement as a consistency check.
- **Question:** What is the most reliable way to detect cancel deposit transactions? Monitoring balance changes on the contract? Observing the `prevNextCancelledDeposit` counter delta? Filtering L1 transactions by involved accounts?

#### 4d. Bridge Event Message Schema

Spike 002 established the minimum required fields. The exact schema must be defined in this spike:

```
{
  userPk: string,           // user's public key (signer)
  type: "deposit" | "withdrawal" | "cancel",
  aux: string,              // Poseidon hash correlation key
  amount: string,           // bridge amount
  recipient: string,        // destination public key
  blockHeight: number,      // L1 block height
  txHash: string,           // L1 transaction hash
  // Deposit-specific:
  timeout?: number,         // timeout slot
  holderAccountL1?: string  // holder account on L1
}
```

**Key design question:** `aux` is NOT unique — identical deposits/withdrawals produce the same `aux` (see `spikes/002-bridge-correlation/results.md` §2). The indexer disambiguates via `(aux, aux_sequence)` using FIFO ordering. Should the L1 Watcher compute `aux_sequence`, or should it publish raw events and let the indexer assign sequence numbers?

### 5. Adapter Boundary

- What is the minimal interface that an L1 adapter must expose to the rest of the L1 Watcher?
- Which operations are provider-specific (Mina actions/account updates, Ethereum logs/events) and which are watcher-owned (publication, health, durable cursor state)?
- Which parts belong in the shared watcher process and which parts belong inside each adapter?
- What does the Zeko-M / Mina adapter implement in Milestone 1, and what remains for the Zeko-E / Ethereum adapter in Milestone 4?

### 6. NATS Event Schemas

- Define the exact JSON schemas for `zeko.l1.settlements`, `zeko.l1.rollbacks`, `zeko.l1.outer-actions`, and `zeko.l1.bridge-events`.
- What deduplication keys (`Nats-Msg-Id`) should each use?
- How do these schemas interact with the indexer's batch and bridge operation records?

### 7. Failure Modes and Recovery

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
6. **Bridge event detection design:** Concrete mechanisms for detecting deposit submissions (user-level AccountUpdates), withdrawal finalizations, and cancel deposits (no outer action — counter-based detection). Includes Poseidon hash computation approach for `aux`. See Section 4 for spike-002-derived requirements.
7. **L1 adapter boundary sketch:** Minimal TypeScript interface implemented by the Mina adapter first and by the Ethereum adapter later.
8. **Failure mode table:** All failure scenarios with detection and recovery strategies.

---

## References

- PRD Section 5.2.2 (L1 Watcher)
- PRD Section 7.5 Scenario 1 (L1 Fork Invalidates a Commit or Deposit)
- `zeko-ui/services/actions/indexer` — current outer action indexer
- `zeko-ui/services/actions/api` — current bridge API
- Mina daemon GraphQL schema
- Mina archive node GraphQL schema
- Spike 002 results (`spikes/002-bridge-correlation/results.md`) — §2 aux collision handling, §3 user PK extraction, §4 cancel deposit observability, §5 bridge operation lifecycle
- `zeko-bridge-sdk/src/utils.ts` — `depositAux()` / `withdrawalAux()` Poseidon hash computation
- `zeko-bridge-sdk/src/index.ts` — `submitDeposit` / `submitWithdrawal` / `finalizeWithdrawal` user-level transactions
- `zeko/src/app/zeko/circuits/rule_bridge_finalize_cancelled_deposit.ml` — cancel deposit contract (no outer action emitted)
- `zeko/src/app/zeko/circuits/rule_action_witness.ml` — witness action emission
