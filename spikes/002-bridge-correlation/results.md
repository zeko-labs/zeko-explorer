# Spike 002: Bridge Operation L1 ↔ L2 Correlation — Results

**Status:** Complete
**Date:** 2026-04-08

---

## 1. Existing Bridge Architecture Analysis

The current bridge actions services in `zeko-ui/services/actions/` provide indexed bridge data to the bridge UI. They consist of two components:

### Indexer (`services/actions/indexer/`)

Polls L1 and L2 archives in parallel on a 15-second loop. Indexes two types of actions:

- **Outer actions (L1):** Actions on the Zeko zkApp contract (`OUTER_PK`). Two kinds:
  - `commit` (`action[0] === "0"`) — batch settlements. Fields: ledger, innerActionState, innerActionStateLength, synchronizedOuterActionState, synchronizedOuterActionStateLength, slotRange.
  - `witness` (`action[0] === "1"`) — bridge proofs. Fields: **aux** (`action[1]`), slotRange.
- **Inner actions (L2):** Actions on the inner account (`INNER_PK`). All are witness-type. Fields: **aux** (`action[1]`).

Fork detection uses state chain validation — `beforeActionState` of action N must equal `afterActionState` of action N-1. On fork, actions from the divergence point onward are deleted and re-inserted.

### API (`services/actions/api/`)

Cloudflare Worker with Pothos GraphQL. Five queries:

| Query | Purpose | Source |
|-------|---------|--------|
| `outerWitnessesFromAuxes(auxes)` | L1 witnesses matching given aux values | `api/src/schema/outer.ts:40-58` |
| `innerWitnessesFromAuxes(auxes)` | L2 inner actions matching given aux values | `api/src/schema/inner.ts:22-35` |
| `outerActions(beforeState, afterState?)` | Outer action chain traversal by state range | `api/src/schema/outer.ts:61-130` |
| `innerActions(beforeState, afterState?)` | Inner action chain traversal by state range | `api/src/schema/inner.ts:38-88` |
| `commitAsePastSlot(slot)` | Last commit before slot + subsequent actions | `api/src/schema/outer.ts:132-202` |

### Database (PostgreSQL via Drizzle ORM)

**Source:** `api/drizzle/schema.ts`

Four tables:

| Table | Primary Key | Key Fields |
|-------|------------|------------|
| `outer_actions` | `after_state` | kind, index, block_height, timestamp, txn_hash, fields, slot_range, marked_as_canonical_at |
| `commit_actions` | `after_state` (FK → outer_actions) | ledger, inner_action_state, inner_action_state_length, synchronized_outer_action_state |
| `witness_actions` | `after_state` (FK → outer_actions) | **aux** (indexed) |
| `inner_actions` | `after_state` | index, block_height, timestamp, txn_hash, fields, **aux** (indexed) |

### Known Issues

| Issue | Detail |
|-------|--------|
| **No per-user indexing** | Everything indexed by action state/index/aux. No "bridge ops for wallet X" query. |
| **Full archive scans** | Bridge SDK calls `findDeposits(pk)` / `findWithdrawals(pk)` which fetch all user actions from the archive. |
| **Client-side correlation** | The bridge SDK (not the API) correlates L1/L2 via aux. Correlation logic lives in the browser. |
| **No bridge_operation concept** | Only raw actions exist. No unified record representing a complete bridge operation. |

### Key Files

| File | Purpose |
|------|---------|
| `zeko-ui/services/actions/indexer/src/modules/outer.ts` | L1 action extraction, aux at `action[1]` for witnesses |
| `zeko-ui/services/actions/indexer/src/modules/inner.ts` | L2 action extraction, aux at `action[1]` |
| `zeko-ui/services/actions/api/drizzle/schema.ts` | PostgreSQL schema definition |
| `zeko-ui/services/actions/api/src/schema/outer.ts` | Outer actions GraphQL queries |
| `zeko-ui/services/actions/api/src/schema/inner.ts` | Inner actions GraphQL queries |
| `zeko-bridge-sdk/src/utils.ts` | `depositAux()` / `withdrawalAux()` Poseidon hash computation |
| `zeko-bridge-sdk/src/index.ts` | `findDeposits()`, `finalizeDeposit()`, `prevNextDeposit` ordering |
| `zeko-ui/apps/bridge-ui/machines/bridgeOperation.ts` | UI XState state machine |

---

## 2. Correlation Key: `aux` Confirmed

The `aux` field IS the correlation key between L1 and L2 bridge actions. Verified through complete code tracing across both TypeScript and OCaml codebases.

### How `aux` flows through a deposit

1. User submits deposit on L1. The user creates a signed `AccountUpdate` on their OWN public key with actions: `[recipient1, recipient2, amount, timeout, holderAccount1, holderAccount2, outerPk1, outerPk2]` (`zeko-bridge-sdk/src/index.ts:301-311`). This is emitted on the **user's PK**, not the zkApp contract PK.
2. `depositAux()` computes a Poseidon hash: `Poseidon.hashWithPrefix("Deposit_params - qFB3jXP*)", [Field(0), ...holderAccountL1.toFields(), ...amount.toFields(), ...recipient.toFields(), ...timeout.toFields()])` (`zeko-bridge-sdk/src/utils.ts:78-86`).
3. The sequencer processes the deposit and creates an L1 outer witness action via `rule_action_witness` (`zeko/src/app/zeko/circuits/rule_action_witness.ml:22,32`). This rule emits actions on the **Zeko zkApp contract** (`OUTER_PK`) with `action[1] = aux`.
4. Indexer extracts `aux: item.action[1].toString()` for witness-kind actions (`indexer/src/modules/outer.ts:72`). Stored in `witness_actions.aux`.
5. On L2, inner action carries `action[1]` as the same aux value (`indexer/src/modules/inner.ts:52`). Stored in `inner_actions.aux`.
6. API correlates via `queryOuterWitnessesFromAuxes()` and `queryInnerWitnessesFromAuxes()` — given the same aux, these return the L1 and L2 sides of the same bridge operation.

### How `aux` flows through a withdrawal

1. User submits withdrawal on L2. Action fields: `[recipient1, recipient2, amount]` (`zeko-bridge-sdk/src/index.ts:560-563`).
2. `withdrawalAux()` computes: `Poseidon.hashWithPrefix("Withdrawal_params - qFB3jXP*)", [Field(0), ...amount.toFields(), ...recipient.toFields()])` (`zeko-bridge-sdk/src/utils.ts:88-94`).
3. L2 inner action carries `action[1] = aux`. On finalization, the sequencer emits an L1 outer witness via `rule_action_witness` with matching aux on `OUTER_PK`.

### `aux` is NOT unique — collision handling

**Deposit aux** is deterministic from `(holderAccountL1, amount, recipient, timeout)`. Two identical deposits from the same holder produce the same aux.

**Withdrawal aux** is deterministic from `(amount, recipient)`. Even fewer inputs — repeated withdrawals of the same amount to the same recipient always collide.

The on-chain protocol disambiguates via sequential counters stored in the helper account's zkApp state:

- **`prevNextDeposit`** — `helperAccount.zkappState[0]` on L2, tracks consumed deposit index (`zeko-bridge-sdk/src/index.ts:421-445`).
- **`prevNextWithdrawal`** — `helperAccount.zkappState[1]` on L2, tracks consumed withdrawal index (`zeko-bridge-sdk/src/index.ts:618-641`).
- **`prevNextCancelledDeposit`** — `helperAccountL1.zkappState[0]` on L1, tracks cancelled deposit index (`zeko-bridge-sdk/src/utils.ts:417-420`).

Matching is done in FIFO order: the counters establish which operations have been consumed, and the next matching aux in sequence is the correct one.

**Implication for the new indexer:** Use `(aux, aux_sequence)` as the composite unique key for `bridge_operation`. When creating a bridge operation, assign `aux_sequence = count of existing records with the same aux`. When the second side arrives, match to the lowest `aux_sequence` record missing that side (FIFO). This mirrors the on-chain counter semantics.

---

## 3. User Public Key Extraction

The indexer watches zkApp contract PKs (`OUTER_PK`, `INNER_PK`), not individual user PKs. But `bridge_operation` records need `sender`/`recipient` for per-user queries. There are two data sources:

### Source 1: `zeko.l1.bridge-events` NATS subject (primary)

The L1 Watcher publishes deposit/withdrawal events to `zeko.l1.bridge-events` (PRD Section 5.2.2). The L1 Watcher has access to both the L1 live node and L1 archive, and can observe user-level transactions.

For deposits, the user's `submitDeposit` creates a signed `AccountUpdate` on the **user's own public key** that emits actions with all deposit parameters (`zeko-bridge-sdk/src/index.ts:301-311`):

```typescript
const transferrer = AccountUpdate.createSigned(recipient);
transferrer.balance.subInPlace(amount);
transferrer.body.actions = Actions.pushAction(transferrer.body.actions, [
  ...recipient.toFields(),     // user PK (2 fields)
  ...amount.toFields(),        // deposit amount
  ...timeout.toFields(),       // timeout slot
  ...holderAccountL1.toFields(), // holder account (2 fields)
  ...this.outerPk.toFields(),  // zkApp contract PK (2 fields)
]);
```

The L1 Watcher can observe these user-level actions and extract: the user's PK (the signer), the amount, timeout, holder account, and the target Zeko zkApp. It can then compute `depositAux()` from these fields, establishing the correlation key.

For withdrawals, the user's `submitWithdrawal` emits actions on the user's own PK with `[recipient1, recipient2, amount]` (`zeko-bridge-sdk/src/index.ts:560-563`). The L1 Watcher can observe the finalization transaction on L1 which includes withdrawal params and the user's PK.

The exact schema for `zeko.l1.bridge-events` messages is undefined — it depends on spike 006 (L1 Watcher). But the available data is deterministic: the L1 Watcher can extract user PKs, amounts, and compute aux from on-chain data. The bridge event message should include at minimum: `{ userPk, type ("deposit"|"withdrawal"), aux, amount, recipient, blockHeight, txHash }`.

### Source 2: Inner action fields (supplementary)

Inner actions on L2 carry fields that encode bridge parameters. For deposits: `inner_actions.fields` contains the deposit params from which `recipient` can be parsed. For withdrawals: fields contain `[recipient1, recipient2, amount]`. This provides a backup path if `zeko.l1.bridge-events` data is delayed.

### Data flow

```
User submits deposit on L1 (action on user's PK)
    │
    ├─► L1 Watcher observes user tx → publishes to zeko.l1.bridge-events
    │     { userPk, type: "deposit", aux, amount, recipient, timeout, blockHeight, txHash }
    │
    └─► L1 archive records outer witness action on OUTER_PK
          L1 Watcher observes → publishes to zeko.l1.outer-actions
            { kind: "witness", aux, slotRange, afterState, ... }

Zeko Indexer:
  1. Receives zeko.l1.bridge-events → creates bridge_operation with sender/recipient
  2. Receives zeko.l1.outer-actions (witness) → links outer_action to bridge_operation via aux
  3. Receives zeko.l2.transactions (inner action) → links inner_action to bridge_operation via aux
```

---

## 4. Cancel Deposit Observability

### OCaml contract analysis

Examined `rule_bridge_finalize_cancelled_deposit.ml` in the Zeko OCaml contracts (`zeko/src/app/zeko/circuits/`). Key finding:

**Cancel deposit does NOT emit an outer witness action on `OUTER_PK`.**

The cancel flow creates a `witness_outer` account update (lines 314-339), but this account update has **no `actions` field** — only preconditions. It verifies the outer action state but does not emit new actions. The account update tree at line 355-356 shows `(witness_outer, [])` — included as a precondition witness, not an action emitter.

For comparison, `rule_action_witness.ml` (the rule that produces normal deposit/withdrawal witness actions) DOES set `actions` on the account update at line 32. The cancel rule explicitly does not.

### What cancel deposit DOES on-chain

1. **L2 mutation:** User calls `cancelDepositMutation` on the L2 sequencer (`zeko-ui/packages/graphql/src/zeko.ts:85-91`), which returns a proof forest.
2. **L1 transaction:** User submits the proof forest as an L1 transaction. The contract:
   - Verifies the deposit was accepted and is now being rejected.
   - Advances `prevNextCancelledDeposit` (helper account zkApp state[0]) — `rule_bridge_finalize_cancelled_deposit.ml:289-302`.
   - Returns the deposit amount to the user (balance_change negate at line 348-349).
   - Checks (via precondition) that the outer action state matches — but emits NO new actions.
3. **Events:** The cancel rule emits NO events. Compare with `rule_bridge_finalize_withdrawal.ml` which DOES emit events (line 256) containing `(withdrawal_index, withdrawal_params)`.

### How the indexer detects cancellation

Since cancel produces no outer action on `OUTER_PK`, the indexer cannot detect it from outer action streams alone. Two detection mechanisms:

1. **`zeko.l1.bridge-events`:** The L1 Watcher can observe cancel deposit L1 transactions. The cancel transaction interacts with the Zeko zkApp contract (it includes `witness_outer` as a child account update with the contract's PK). The L1 Watcher sees this transaction and can publish a cancel event to `zeko.l1.bridge-events`. The event includes the user's PK and the advanced `prevNextCancelledDeposit` counter value.

2. **`prevNextCancelledDeposit` counter polling:** The indexer (or L1 Watcher) can periodically read `helperAccountL1.zkappState[0]`. When this counter advances, a deposit was cancelled. The cancelled deposit is identified by its FIFO position: `getMinResolvedDepositIndex = max(prevNextDeposit, prevNextCancelledDeposit)` (`zeko-ui/packages/bridge-sdk/src/index.ts:610-613`).

The L1 Watcher approach is preferred because it provides real-time detection and the user's PK. The counter polling approach is a fallback for consistency verification.

---

## 5. Bridge Operation Lifecycle

The indexer observes on-chain events **after the fact**, not user intent. This is fundamentally different from the UI state machine (`bridgeOperation.ts`), which tracks user interactions.

### What the indexer observes per NATS stream

| NATS Subject | What the indexer receives | What it writes |
|---|---|---|
| `zeko.l1.bridge-events` | Deposit submissions, withdrawal finalizations, cancel events — with user PK and full params | `bridge_operation` creation with `sender`/`recipient`/`aux`. This is the canonical deposit submission fact (WEB-415). |
| `zeko.l1.outer-actions` | Commit and witness actions from `OUTER_PK` | `outer_action` records. Witnesses carry `aux`. |
| `zeko.l2.transactions` | L2 transactions (containing inner actions on `INNER_PK`) | `inner_action` records with `aux`. |
| `zeko.l1.rollbacks` | L1 fork events | Revert affected outer_actions, cascade to bridge_operations. |
| `zeko.l2.transactions` (hash chain break) | Consumer-side L2 rollback detection | Revert affected inner_actions, cascade to bridge_operations. |

### The core problem this solves (WEB-415)

The current bridge rebuilds deposit history by scanning wallet-specific L1 archive actions on page load (`findDeposits(pk)` in `zeko-bridge-sdk/src/index.ts:328-396`). This makes bootstrap expensive and causes unnecessary requests across archive, sequencer, and actions services. The actions indexer already provides most of the data needed for withdrawals, commits, and witnesses — but it does **not** index the original L1 deposit submission itself. Because that canonical deposit fact is missing, the bridge cannot answer "show deposits for wallet X" from indexed data alone.

The solution: the L1 Watcher detects deposit submissions on L1 and publishes them to `zeko.l1.bridge-events`. The Zeko Indexer consumes these events and creates `bridge_operation` records indexed by user PK. The bridge UI/SDK/CLI query the Bridge GraphQL API for `bridgeOperations(publicKey)` instead of scanning the archive.

### Deposit lifecycle — how each state transition works

```
                                       ┌─────────────┐
                                       │  ROLLED_BACK │
                                       └──────▲───────┘
                                              │ (L1 fork or L2 hash chain break)
                                              │
┌───────────┐    ┌──────────────┐    ┌────────┴──┐    ┌───────────┐
│ SUBMITTED ├───►│ L1_WITNESSED ├───►│ COMMITTED ├───►│ COMPLETED │
└───────────┘    └──────────────┘    └─────┬─────┘    └───────────┘
                                           │
                                           ▼
                                    ┌──────────┐    ┌───────────┐
                                    │ TIMED_OUT├───►│ CANCELLED │
                                    └──────────┘    └───────────┘
```

**`SUBMITTED`** — The L1 Watcher detects the user's deposit submission transaction on L1 and publishes to `zeko.l1.bridge-events`. The user's `submitDeposit` creates a signed `AccountUpdate` on the user's own PK that emits actions with all deposit params (`zeko-bridge-sdk/src/index.ts:301-311`). The L1 Watcher observes this transaction, extracts the user PK (the signer), amount, timeout, holder account, and computes `depositAux()` from the fields. The indexer creates the `bridge_operation` record with `sender`, `recipient`, `amount`, `aux`, `timeout_slot`, `holder_account_l1`, and the submission tx hash/block height. **This is the canonical deposit submission fact** — the record the bridge UI queries to show "your deposits" without archive scanning.

**`L1_WITNESSED`** — An outer witness action with this deposit's `aux` appears on `OUTER_PK` via `zeko.l1.outer-actions`. The indexer matches the witness to the existing `bridge_operation` by `(aux, aux_sequence)` and links the `outer_action` via an `l1_action_link` graph edge. This proves the deposit was accepted by the sequencer and a bridge proof was submitted.

**`COMMITTED`** — A commit action is indexed from `zeko.l1.outer-actions`. The indexer determines which deposits this commit covers by walking the inner action state chain (see "Commit-to-bridge-operation association" below). All covered deposits transition to `COMMITTED`.

**`COMPLETED`** — An inner action with matching `aux` is indexed from `zeko.l2.transactions`. The indexer creates an `inner_action` record and links it to the `bridge_operation`. The deposit is now finalized on L2 — the user has received their funds.

**`TIMED_OUT`** — Any deposit in `SUBMITTED`, `L1_WITNESSED`, or `COMMITTED` status where `timeout_slot < current_l1_slot` and no L2 finalization exists transitions to `TIMED_OUT`. The current L1 slot is available from the L1 Watcher's settlement events and outer actions (which carry slot information). This check runs on every new `zeko.l1.outer-actions` or `zeko.l1.settlements` message, not on a separate polling timer.

**`CANCELLED`** — Detected via `zeko.l1.bridge-events` when the L1 Watcher observes a cancel deposit L1 transaction (see Section 4). The `prevNextCancelledDeposit` counter advancement identifies which deposit was cancelled by FIFO position.

**`ROLLED_BACK`** — Two paths:
- **L1 fork:** `zeko.l1.rollbacks` event invalidates the outer witness or commit action. The indexer removes the affected `outer_action` records and recalculates bridge_operation status based on remaining data.
- **L2 hash chain break:** Consumer-side detection on `zeko.l2.transactions` (PRD Section 7.5). If the inner action that completed a deposit is in the rolled-back range, the `inner_action` is removed and the bridge_operation reverts to its previous status.

### Withdrawal lifecycle — how each state transition works

```
┌───────────┐    ┌──────────────┐    ┌───────────┐    ┌──────────────┐    ┌───────────┐
│ SUBMITTED ├───►│ L2_WITNESSED ├───►│ COMMITTED ├───►│ DELAY_PASSED ├───►│ COMPLETED │
└───────────┘    └──────────────┘    └─────┬─────┘    └──────────────┘    └───────────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │ ROLLED_BACK │
                                    └─────────────┘
```

**`SUBMITTED`** — The user submits a withdrawal on L2. The L2 transaction is indexed from `zeko.l2.transactions`, and the inner action on `INNER_PK` with `aux` is extracted. At this point the indexer creates the `bridge_operation` with `sender`/`recipient` parsed from the inner action fields (`[recipient1, recipient2, amount]`), computes `withdrawalAux()`, and records the L2 tx hash. For withdrawals, `SUBMITTED` and `L2_WITNESSED` happen in the same message since the user's L2 submission IS the inner action.

**`L2_WITNESSED`** — Same event as `SUBMITTED` for withdrawals. The inner action with this withdrawal's `aux` on `INNER_PK` is the canonical evidence. Separate from `SUBMITTED` conceptually because for deposits, the submission (user's L1 tx) and the witness (outer action on OUTER_PK) are distinct events.

**`COMMITTED`** — An L1 commit action's `innerActionState` covers this withdrawal's inner action (see association algorithm below). The withdrawal is now part of a settled batch.

**`DELAY_PASSED`** — The on-chain withdrawal delay has elapsed: `current_l1_slot > commit.slotRangeUpper + withdrawal_delay`. Detected when processing new slot information from `zeko.l1.outer-actions` or `zeko.l1.settlements`. The finalize withdrawal contract enforces this via a `valid_while` precondition with `lower = slot + withdrawal_delay` (`rule_bridge_finalize_withdrawal.ml:197-200`). The withdrawal delay value is a known constant.

**`COMPLETED`** — An outer witness with matching `aux` appears on `OUTER_PK` via `zeko.l1.outer-actions`. This means the user has finalized the withdrawal on L1 (called `finalizeWithdrawal`, which triggers `rule_action_witness` to emit the witness action). The `rule_bridge_finalize_withdrawal.ml` also emits events `(withdrawal_index, withdrawal_params)` on the main account update (line 256), providing additional verification data.

**`ROLLED_BACK`** — Same two paths as deposits: L1 fork via `zeko.l1.rollbacks`, or L2 hash chain break for inner actions.

### Commit-to-bridge-operation association algorithm

When a commit action is indexed from `zeko.l1.outer-actions`, the indexer must determine which bridge operations it covers:

1. Read the commit's `innerActionState` and `innerActionStateLength` from its fields (`outer.ts:54-62`).
2. Query `inner_action` records: walk backward from `innerActionState` through the `before_state`/`after_state` chain for `innerActionStateLength` steps. This yields the set of inner actions included in this commit.
3. Collect all `aux` values from these inner actions.
4. Match each `aux` to its `bridge_operation` via `(aux, aux_sequence)` lookup (FIFO order).
5. Update matched bridge_operations: set `commit_action_state`, transition status to `COMMITTED`.
6. Create the `l1_action_link` graph edge from the `outer_action` (commit) to each affected `bridge_operation`.

This is O(N) where N = `innerActionStateLength`, executed once per commit. The inner action state chain is already indexed in SurrealDB, so the walk is a series of indexed lookups.

### UI-to-Indexer state mapping

| UI State | Indexer State | Notes |
|----------|--------------|-------|
| `SUBMIT_DEPOSIT` | `SUBMITTED` | L1 Watcher detects user's deposit tx → `zeko.l1.bridge-events` |
| `PENDING_DEPOSIT` | `L1_WITNESSED` | Outer witness on OUTER_PK confirms sequencer accepted deposit |
| `TO_FINALIZE` (deposit) | `COMMITTED` | Commit covers this deposit, user can finalize on L2 |
| `FINALIZE_DEPOSIT` | `COMPLETED` | L2 inner action indexed |
| `CAN_CANCEL` | `TIMED_OUT` | Slot past timeout, no finalization |
| `CANCEL_DEPOSIT` | `CANCELLED` | Detected via `zeko.l1.bridge-events` (cancel tx on L1) |
| `SUBMIT_WITHDRAWAL` | `SUBMITTED` | L2 inner action indexed from `zeko.l2.transactions` |
| `PENDING_WITHDRAWAL` | `L2_WITNESSED` → `COMMITTED` | Inner action exists, waiting for commit |
| `TO_FINALIZE` (withdrawal) | `DELAY_PASSED` | Commit + delay elapsed |
| `FINALIZE_WITHDRAWAL` | `COMPLETED` | L1 outer witness indexed |

---

## 6. System Integration — Data Flow

### How bridge indexing fits in the overall system

The bridge indexing pipeline is a subset of the unified Zeko Indexer (PRD Section 5.2.5). It does not run as a separate service. The same TypeScript indexer process that handles explorer data (transactions, accounts, batches) also handles bridge data.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          NATS JetStream                              │
│                                                                      │
│  zeko.l1.outer-actions ──┐                                           │
│  zeko.l1.bridge-events ──┼── zeko-l1 stream (subjects: zeko.l1.>)   │
│  zeko.l1.rollbacks ──────┤                                           │
│  zeko.l1.settlements ────┘                                           │
│                                                                      │
│  zeko.l2.transactions ───── zeko-l2 stream (subjects: zeko.l2.>)    │
│  zeko.l2.finality ───────┘                                           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Zeko Indexer (TypeScript)                        │
│                                                                      │
│  Durable consumers (one per stream, at-least-once delivery):         │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │ Bridge consumers:                                            │     │
│  │                                                              │     │
│  │ zeko.l1.outer-actions → parse commit/witness → write         │     │
│  │   outer_action to SurrealDB. If witness: match aux →         │     │
│  │   link to bridge_operation. If commit: walk inner action     │     │
│  │   state chain → update covered bridge_operations.            │     │
│  │                                                              │     │
│  │ zeko.l1.bridge-events → parse user deposit/withdrawal/cancel │     │
│  │   → create/update bridge_operation with sender/recipient.    │     │
│  │   Compute aux from event params. Assign aux_sequence (FIFO). │     │
│  │                                                              │     │
│  │ zeko.l2.transactions → extract inner actions on INNER_PK →   │     │
│  │   write inner_action. Match aux → link to bridge_operation.  │     │
│  │   Hash chain continuity check for L2 rollback detection.     │     │
│  │                                                              │     │
│  │ zeko.l1.rollbacks → revert affected outer_actions →          │     │
│  │   cascade: recalculate bridge_operation status.              │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  Idempotent writes (NATS Msg-Id dedup + SurrealDB upsert by ID)    │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SurrealDB (single node)                            │
│                                                                      │
│  Bridge tables:                                                      │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────────┐          │
│  │outer_action │   │inner_action │   │bridge_operation  │          │
│  │             │   │             │   │  (indexed by PK) │          │
│  └──────┬──────┘   └──────┬──────┘   └────────┬─────────┘          │
│         │                 │                    │                     │
│         └────l1_action_link────────────────────┘                    │
│                           └────l2_action_link──┘                    │
│                                                                      │
│  Live queries for real-time subscriptions                            │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Bridge GraphQL API                                  │
│                   (TypeScript, Pothos)                                │
│                                                                      │
│  Replaces services/actions/api. Serves bridge UI.                    │
│  Backed by same SurrealDB instance.                                  │
│  SSE subscriptions via SurrealDB live queries.                       │
│                                                                      │
│  Queries:                                                            │
│  - bridgeOperations(publicKey, type?, status?)                       │
│  - bridgeOperation(aux, auxSequence)                                 │
│  - outerActions, innerActions (for low-level action chain queries)   │
└─────────────────────────────────────────────────────────────────────┘
```

### Message ordering and partial records

NATS JetStream delivers messages in order within a stream. But events from different streams arrive independently — the L1 outer witness may arrive before or after the L2 inner action.

The indexer handles this with a **first-side-wins** strategy:

1. Whichever NATS message references a bridge operation first creates the `bridge_operation` record.
2. Subsequent messages for the same operation (matched by aux + FIFO sequence) update the existing record.
3. Status is recalculated after every update based on which fields are populated.

For example: a deposit might be created by `zeko.l1.bridge-events` (with user PK and amount), then updated by `zeko.l1.outer-actions` (adding L1 witness data), then updated by `zeko.l2.transactions` (adding L2 completion data).

### Rollback handling in the new system

**L1 fork (via `zeko.l1.rollbacks`):**

The L1 Watcher detects block orphaning and publishes to `zeko.l1.rollbacks` with affected block details. The indexer:
1. Identifies `outer_action` records at the affected block heights.
2. Deletes those `outer_action` records and their `l1_action_link` edges.
3. Recalculates status of linked `bridge_operation` records — e.g., a deposit that was `COMMITTED` reverts to `L1_WITNESSED` if only the commit was in the rolled-back block, or to an earlier state if the witness was also rolled back.

**L2 rollback (consumer-side hash chain break on `zeko.l2.transactions`):**

The indexer checks hash chain continuity on every incoming L2 transaction message (PRD Section 7.5):
- `M[n].source_ledger_hash` must equal `M[n-1].target_ledger_hash`.
- If `M[n].source` matches an earlier `M[k].target`, messages `M[k+1]..M[n-1]` were rolled back. The indexer reverts `inner_action` records from those transactions, removes their `l2_action_link` edges, and recalculates affected `bridge_operation` status.
- If `M[n].source` is unknown, it's a gap — the indexer pauses and calls the Backfill Service.

There is **no `zeko.l2.rollbacks` NATS stream**. L2 rollback detection is entirely consumer-side.

---

## 7. SurrealDB Schema

### Tables

Three tables plus two graph relation tables:

**`outer_action`** — flattened from PostgreSQL's `outer_actions` + `commit_actions` + `witness_actions`. Commit-specific and witness-specific fields are optional columns. Record ID: `outer_action:⟨after_state⟩`.

```surql
DEFINE TABLE outer_action SCHEMAFULL;

DEFINE FIELD after_state       ON outer_action TYPE string;
DEFINE FIELD before_state      ON outer_action TYPE option<string>;
DEFINE FIELD kind              ON outer_action TYPE string
  ASSERT $value IN ["commit", "witness"];
DEFINE FIELD index             ON outer_action TYPE int;
DEFINE FIELD block_height      ON outer_action TYPE int;
DEFINE FIELD timestamp         ON outer_action TYPE datetime;
DEFINE FIELD txn_hash          ON outer_action TYPE string;
DEFINE FIELD fields            ON outer_action TYPE array<string>;
DEFINE FIELD slot_range_lower  ON outer_action TYPE int;
DEFINE FIELD slot_range_upper  ON outer_action TYPE int;
DEFINE FIELD created_at        ON outer_action TYPE datetime DEFAULT time::now();
DEFINE FIELD marked_as_canonical_at ON outer_action TYPE option<datetime>;

-- Commit-specific (NULL for witnesses)
DEFINE FIELD ledger                              ON outer_action TYPE option<string>;
DEFINE FIELD inner_action_state                  ON outer_action TYPE option<string>;
DEFINE FIELD inner_action_state_length           ON outer_action TYPE option<int>;
DEFINE FIELD synchronized_outer_action_state     ON outer_action TYPE option<string>;
DEFINE FIELD synchronized_outer_action_state_length ON outer_action TYPE option<int>;

-- Witness-specific (NULL for commits)
DEFINE FIELD aux ON outer_action TYPE option<string>;

DEFINE INDEX idx_oa_after_state   ON outer_action FIELDS after_state   UNIQUE;
DEFINE INDEX idx_oa_before_state  ON outer_action FIELDS before_state;
DEFINE INDEX idx_oa_index         ON outer_action FIELDS index         UNIQUE;
DEFINE INDEX idx_oa_aux           ON outer_action FIELDS aux;
DEFINE INDEX idx_oa_canonical     ON outer_action FIELDS marked_as_canonical_at;
DEFINE INDEX idx_oa_kind          ON outer_action FIELDS kind;
DEFINE INDEX idx_oa_block_height  ON outer_action FIELDS block_height;
```

**`inner_action`** — from PostgreSQL's `inner_actions`. Record ID: `inner_action:⟨after_state⟩`.

```surql
DEFINE TABLE inner_action SCHEMAFULL;

DEFINE FIELD after_state       ON inner_action TYPE string;
DEFINE FIELD before_state      ON inner_action TYPE option<string>;
DEFINE FIELD index             ON inner_action TYPE int;
DEFINE FIELD block_height      ON inner_action TYPE int;
DEFINE FIELD timestamp         ON inner_action TYPE datetime;
DEFINE FIELD txn_hash          ON inner_action TYPE string;
DEFINE FIELD fields            ON inner_action TYPE array<string>;
DEFINE FIELD created_at        ON inner_action TYPE datetime DEFAULT time::now();
DEFINE FIELD marked_as_canonical_at ON inner_action TYPE option<datetime>;
DEFINE FIELD aux               ON inner_action TYPE string;

DEFINE INDEX idx_ia_after_state   ON inner_action FIELDS after_state   UNIQUE;
DEFINE INDEX idx_ia_before_state  ON inner_action FIELDS before_state;
DEFINE INDEX idx_ia_index         ON inner_action FIELDS index         UNIQUE;
DEFINE INDEX idx_ia_aux           ON inner_action FIELDS aux;
DEFINE INDEX idx_ia_canonical     ON inner_action FIELDS marked_as_canonical_at;
DEFINE INDEX idx_ia_block_height  ON inner_action FIELDS block_height;
```

**`bridge_operation`** — new. Record ID: `bridge_operation:⟨{aux}_{aux_sequence}⟩`.

```surql
DEFINE TABLE bridge_operation SCHEMAFULL;

-- Identity
DEFINE FIELD type              ON bridge_operation TYPE string
  ASSERT $value IN ["deposit", "withdrawal"];
DEFINE FIELD status            ON bridge_operation TYPE string
  ASSERT $value IN [
    "submitted", "l1_witnessed", "l2_witnessed", "committed",
    "delay_passed", "completed", "timed_out", "cancelled", "rolled_back"
  ];

-- Correlation key
DEFINE FIELD aux               ON bridge_operation TYPE string;
DEFINE FIELD aux_sequence      ON bridge_operation TYPE int DEFAULT 0;

-- User-facing fields
DEFINE FIELD sender            ON bridge_operation TYPE string;
DEFINE FIELD recipient         ON bridge_operation TYPE string;
DEFINE FIELD amount            ON bridge_operation TYPE string;

-- Submission (the canonical fact — WEB-415)
DEFINE FIELD submit_tx_hash    ON bridge_operation TYPE string;
DEFINE FIELD submit_block_height ON bridge_operation TYPE int;
DEFINE FIELD submit_timestamp  ON bridge_operation TYPE datetime;

-- Deposit-specific
DEFINE FIELD timeout_slot      ON bridge_operation TYPE option<int>;
DEFINE FIELD holder_account_l1 ON bridge_operation TYPE option<string>;

-- L1 witness side
DEFINE FIELD l1_witness_action_state ON bridge_operation TYPE option<string>;
DEFINE FIELD l1_witness_tx_hash ON bridge_operation TYPE option<string>;
DEFINE FIELD l1_witness_block_height ON bridge_operation TYPE option<int>;
DEFINE FIELD l1_witness_timestamp ON bridge_operation TYPE option<datetime>;
DEFINE FIELD l1_slot_range_lower ON bridge_operation TYPE option<int>;
DEFINE FIELD l1_slot_range_upper ON bridge_operation TYPE option<int>;

-- L2 side
DEFINE FIELD l2_action_state   ON bridge_operation TYPE option<string>;
DEFINE FIELD l2_tx_hash        ON bridge_operation TYPE option<string>;
DEFINE FIELD l2_block_height   ON bridge_operation TYPE option<int>;
DEFINE FIELD l2_timestamp      ON bridge_operation TYPE option<datetime>;

-- Commit reference
DEFINE FIELD commit_action_state ON bridge_operation TYPE option<string>;

-- Cancel reference
DEFINE FIELD cancel_tx_hash    ON bridge_operation TYPE option<string>;

-- Metadata
DEFINE FIELD created_at        ON bridge_operation TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at        ON bridge_operation TYPE datetime DEFAULT time::now();

-- Per-user indexes (the key improvement)
DEFINE INDEX idx_bo_sender     ON bridge_operation FIELDS sender;
DEFINE INDEX idx_bo_recipient  ON bridge_operation FIELDS recipient;
DEFINE INDEX idx_bo_aux        ON bridge_operation FIELDS aux;
DEFINE INDEX idx_bo_aux_unique ON bridge_operation FIELDS aux, aux_sequence UNIQUE;
DEFINE INDEX idx_bo_status     ON bridge_operation FIELDS status;
DEFINE INDEX idx_bo_type_status ON bridge_operation FIELDS type, status;
DEFINE INDEX idx_bo_sender_type ON bridge_operation FIELDS sender, type;
DEFINE INDEX idx_bo_recipient_type ON bridge_operation FIELDS recipient, type;
DEFINE INDEX idx_bo_submit_tx  ON bridge_operation FIELDS submit_tx_hash;
DEFINE INDEX idx_bo_l1_witness ON bridge_operation FIELDS l1_witness_action_state;
DEFINE INDEX idx_bo_l2_action  ON bridge_operation FIELDS l2_action_state;
DEFINE INDEX idx_bo_commit     ON bridge_operation FIELDS commit_action_state;
DEFINE INDEX idx_bo_created    ON bridge_operation FIELDS created_at;
```

### Graph edges

```surql
DEFINE TABLE l1_action_link TYPE RELATION IN outer_action OUT bridge_operation SCHEMAFULL;
DEFINE FIELD role ON l1_action_link TYPE string ASSERT $value IN ["witness", "commit"];
DEFINE FIELD created_at ON l1_action_link TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_l1_link_in  ON l1_action_link FIELDS in;
DEFINE INDEX idx_l1_link_out ON l1_action_link FIELDS out;

DEFINE TABLE l2_action_link TYPE RELATION IN bridge_operation OUT inner_action SCHEMAFULL;
DEFINE FIELD role ON l2_action_link TYPE string ASSERT $value IN ["mint", "burn"];
DEFINE FIELD created_at ON l2_action_link TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_l2_link_in  ON l2_action_link FIELDS in;
DEFINE INDEX idx_l2_link_out ON l2_action_link FIELDS out;
```

### Key queries

```surql
-- Per-user bridge history (replaces findDeposits/findWithdrawals archive scan)
SELECT * FROM bridge_operation
WHERE sender = $pk OR recipient = $pk
ORDER BY created_at DESC LIMIT 20;

-- Full bridge op with linked actions (graph traversal)
SELECT *,
  <-l1_action_link<-outer_action AS l1_actions,
  ->l2_action_link->inner_action AS l2_actions
FROM bridge_operation WHERE aux = $aux AND aux_sequence = $seq;

-- Timed-out deposits (for timeout detection)
SELECT * FROM bridge_operation
WHERE type = "deposit"
  AND status IN ["submitted", "l1_witnessed", "committed"]
  AND timeout_slot IS NOT NONE
  AND timeout_slot < $current_slot;

-- Live query: subscribe to status changes for a user
LIVE SELECT * FROM bridge_operation WHERE sender = $pk OR recipient = $pk;

-- Action chain queries (for low-level indexer needs)
SELECT * FROM outer_action WHERE kind = "commit" ORDER BY index;
SELECT * FROM inner_action WHERE aux = $aux ORDER BY index;
```

---

## 8. Bridge GraphQL API

The Bridge GraphQL API replaces `services/actions/api` entirely. The bridge SDK, UI, and CLI will be updated to use the new API. No backward compatibility with the old 5-query interface is needed.

### GraphQL types

```graphql
enum BridgeType { DEPOSIT, WITHDRAWAL }
enum BridgeStatus {
  SUBMITTED, L1_WITNESSED, L2_WITNESSED, COMMITTED, DELAY_PASSED,
  COMPLETED, TIMED_OUT, CANCELLED, ROLLED_BACK
}

type BridgeOperation {
  id: ID!
  type: BridgeType!
  status: BridgeStatus!
  aux: String!
  auxSequence: Int!
  sender: String!
  recipient: String!
  amount: String!

  # Submission (the canonical fact — WEB-415)
  submitTxHash: String!
  submitBlockHeight: Int!
  submitTimestamp: String!

  # Deposit-specific
  timeoutSlot: Int
  holderAccountL1: String

  # Witness/commit/completion
  l1WitnessTxHash: String
  l1WitnessBlockHeight: Int
  l1WitnessTimestamp: String
  l2TxHash: String
  l2BlockHeight: Int
  l2Timestamp: String
  cancelTxHash: String

  # Graph-traversed linked actions
  l1Actions: [OuterAction!]!
  l2Actions: [InnerAction!]!

  createdAt: String!
  updatedAt: String!
}

type BridgeOperationConnection {
  edges: [BridgeOperationEdge!]!
  pageInfo: PageInfo!
}
```

### Queries

```graphql
type Query {
  # Primary query — replaces findDeposits/findWithdrawals archive scan
  bridgeOperations(
    publicKey: String!
    type: BridgeType
    status: BridgeStatus
    first: Int
    after: String
  ): BridgeOperationConnection!

  # Single operation detail with linked actions
  bridgeOperation(aux: String!, auxSequence: Int!): BridgeOperation

  # Low-level action chain queries (for indexer/debugging)
  outerActions(afterState: String, limit: Int): [OuterAction!]!
  innerActions(afterState: String, limit: Int): [InnerAction!]!
}

type Subscription {
  # Live updates for a user's bridge operations
  bridgeOperationUpdated(publicKey: String!): BridgeOperation!
}
```

### What changes in the bridge SDK/UI/CLI

| Component | Current behavior | New behavior |
|---|---|---|
| `findDeposits(pk)` | Scans all actions on user's PK from L1 archive | `bridgeOperations(pk, type: DEPOSIT)` |
| `findWithdrawals(pk)` | Scans all actions on user's PK from L1 archive | `bridgeOperations(pk, type: WITHDRAWAL)` |
| `prevNextDeposit` ordering | Client-side FIFO matching via on-chain counters | Server-side `aux_sequence` already resolved |
| Deposit state derivation | Client combines archive data + indexer data + on-chain state | Single `status` field from API |
| Bridge bootstrap on page load | Multiple archive calls per wallet | Single paginated API call |
| Real-time updates | 20s polling (`POLL_INTERVAL` in `bridgeOperation.ts`) | SSE subscription via `bridgeOperationUpdated` |

---

## 9. Dependencies on Other Spikes

| Dependency | What this spike needs | Status |
|---|---|---|
| **Spike 006 — L1 Watcher** | Exact schema for `zeko.l1.bridge-events` and `zeko.l1.outer-actions` NATS messages. How the L1 Watcher detects user deposit/withdrawal/cancel transactions. How it extracts user PKs and computes aux. | Not started |
| **Spike 001 — Sequencer Connector** | NATS message format for `zeko.l2.transactions` (contains inner actions). Hash chain continuity model for L2 rollback detection. | Complete |

The `zeko.l1.bridge-events` schema is the most significant dependency. This spike has established WHAT data must be in those messages (user PK, operation type, aux, amount, recipient, timeout for deposits, block height, tx hash) and WHY (to populate bridge_operation sender/recipient without archive scans). Spike 006 must design HOW the L1 Watcher extracts this data from L1 chain observation.
