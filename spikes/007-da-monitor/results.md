# Spike 007: DA Attestation Status Tracking — Results

**Status:** Complete
**Date:** 2026-05-12

---

## 1. Decision

This spike investigated how the explorer should track DA-layer attestation status and concluded with two architectural commitments:

**A standalone DA-side monitoring service is not part of the architecture.** Polling each operator's DA node from a centralised explorer-owned service was evaluated and found to be the wrong shape: it imposes a fixed steady-state request rate on every operator, requires each operator to expose and rate-limit a new ingress HTTP shim, duplicates state the DA node already holds locally, and re-asks a question whose answer the DA node already knows the moment it signs. The architecture instead places attestation publishing on the DA-layer side: **each DA node publishes its own Schnorr signatures directly to NATS** on `zeko.da.signatures` at the moment a signature is persisted to RocksDB. The explorer is a pure NATS consumer that aggregates these self-authenticating messages. This is the same shape as the sequencer→NATS publisher already in production (Spike 001 §5.2).

**Milestone 1 ships no DA-attestation publishing at all.** `batch.da_status` is derived from two NATS subjects the indexer already consumes — `zeko.l1.settlements` (Spike 006) and `zeko.l2.finality` at level `"proved"` (Spike 001 §4). Both signals are by-construction proof of DA quorum (see §4), so the explorer is correct without ever talking to the DA layer. Direct DA-node-to-NATS publishing is deferred to **Milestone 4 or Milestone 5** as a latency-and-detail upgrade: it compresses the DA-attested transition from "up to one commit period" to sub-second, and it adds per-operator signer detail to the batch detail page. It is not a correctness requirement.

This decision rests on two facts established by this spike:

1. **The Zeko rollup proof verifies the DA-layer multisig in-circuit.** `Committer.prove_commit` calls `rule_commit`, which checks the signature set against the helper account's public-key list as a circuit constraint. A valid proof is unsatisfiable without DA quorum. Therefore `batch.da_status = 'attested'` follows automatically from any proved-or-later state.
2. **The sequencer already publishes `zeko.l2.finality` at level `"proved"`** the moment `run_committer` produces a `Txn_snark.serializable` (Spike 001 §4). That event is, by construction, a DA-attestation signal — it is published *because* a proof was successfully assembled, which is *only* possible if the multisig was reached.

The rest of this document specifies the Milestone 1 derivation (§5) and the Milestone 4/5 pipeline (§6–§14).

---

## 2. User-Visible States

The explorer surfaces three distinct user-visible states for every batch and every transaction it contains:

| State | Meaning to the user | Source signal |
|---|---|---|
| **Sequenced** | The L2 sequencer accepted and applied the transaction. Reversible if the DA layer fails to attest. | `zeko.l2.transactions` |
| **DA-attested** | The DA layer has signed off on the data being available. The transaction can no longer be silently dropped — a proof exists or can be assembled. | `zeko.l2.finality` (proved) **or** quorum reached on `zeko.da.signatures` |
| **L1-settled** | The batch has landed on the Mina L1 chain with the configured confirmation depth. Final, modulo a deep L1 fork. | `zeko.l1.settlements` (Spike 006) |

At Milestone 1:

- Batch detail page: "Sequenced" → "DA-attested (proved)" → "L1-settled". The DA-attested transition fires when the proved-level finality event arrives. No per-operator detail; the batch is shown attested as a single boolean fact.
- Transaction detail page: Inherits the parent batch's `da_status` for the user-visible state badge.
- `/status` operator page: Shows aggregate "proved tip lag" derived from `zeko.l2.finality`. The DA layer's health is observed indirectly through that lag.
- Bridge operation page: Reaches `BRIDGE_DA_ATTESTED` when its enclosing batch hits the proved transition.

At Milestone 4/5:

- Batch detail page adds a "DA attestation" section showing each operator's signing public key, the per-signer `signedAt` timestamp from the published Schnorr message, and a list of operators whose signatures have not yet been observed. The DA-attested transition fires sub-second after each signature arrives on NATS (§3).
- `/status` page distinguishes DA-layer health from sequencer/L1 health, driven by per-DA-node heartbeats on `zeko.health`. A future Celestia DA target (§14) is a publisher swap on the DA-layer side.
- Bridge page surfaces "DA-quorum reached" as a distinct, earlier user-visible state separate from "proved", which matters for high-value withdrawals where users want the earliest credible signal of irreversibility.

A row whose `da_status` is `'attested'` at Milestone 1 is genuinely attested — the proved-level signal is by-construction proof of DA quorum (§4). Milestone 4/5 changes latency and detail, not correctness.

---

## 3. Latency of Each Source Signal

Concrete numbers for an operator running the default Zeko configuration (`commitment_period_sec = 60`, three DA operators with quorum 2, Mina L1 with ~290-block confirmation depth):

| Signal | Marks `da_status` attested when… | Typical end-to-end latency from diff publication | Milestone |
|---|---|---|---|
| `zeko.l2.finality` level=`proved` | The sequencer's committer assembles a proof. The proof is unsatisfiable without DA quorum. | **Up to one commit period** — bounded by `commitment_period_sec`. Median ~30s; worst case ~60s on default config. Slow proving runs can extend this. | M1 |
| `zeko.da.signatures` published directly by each DA node | Indexer counts `quorum` distinct authorised DA signing public keys from per-node publishes for the same DA receipt payload (`ledger_hash`, `acc_set`). | **Sub-second.** Bounded by sign-to-NATS-publish latency on each operator plus indexer message handling. | M4/M5 |
| `zeko.l1.settlements` (Spike 006) | The L1 commit transaction reaches `confirmation_depth` blocks. | **Several minutes to hours.** One commit period to assemble plus commit inclusion (~3min Mina block time) plus confirmation depth (~290 blocks × ~3min ≈ 14h for full probabilistic finality, or 30–60min at the operational depth most explorers use). | M1 |

At M1 the explorer marks a batch DA-attested as soon as either of its two NATS signals arrives (whichever is first). At M4/M5 the same two signals remain, and `zeko.da.signatures` is added as a faster third source that also carries per-operator detail.

---

## 4. Architectural Invariant: Proved Implies DA-Attested Implies L1-Settled-Eventually

`Committer.prove_commit` calls `rule_commit`, which checks the multisig signature set against the helper account's public-key list as a **circuit constraint**. The proof is unsatisfiable without quorum signatures. Therefore:

- **Existence of a proof** ⇒ DA quorum was reached.
- **Existence of an L1 settlement** ⇒ a valid proof landed on L1 ⇒ DA quorum was reached.

Both implications are by construction, not by observation. The indexer can mark `batch.da_status = attested` from either signal without consulting the DA layer at all. This collapses the work the explorer needs to do:

- **No bootstrap problem.** Historical batches on a long-running chain are L1-settled by definition; the L1 Watcher (Spike 006) emits `zeko.l1.settlements` for each one and the indexer marks it attested. The sequencer's `sync` flow on first deploy replays diffs through `zeko.l2.transactions`; their corresponding proved transitions are emitted as the sequencer reaches them.
- **No catastrophic-failure problem.** If anything in the DA-attestation reporting path is broken (or simply not built), `zeko.l1.settlements` still fills `da_status` correctly — it just arrives later.

The correctness story is therefore identical at Milestone 1 and at Milestone 4/5; only latency and detail differ.

---

## 5. Milestone 1 Implementation

### 5.1 Terminology

Three actors are involved. Keep them straight when reading this document:

- **The TS indexer** — a single TypeScript process. It is a **NATS JetStream consumer** (subscribes to `zeko.*` subjects) and a **SurrealDB writer** (issues upserts on the `batch`, `transaction`, `pending_da_attestation`, etc. tables). It owns no other state.
- **NATS JetStream** — the message log the indexer reads from. Subjects relevant to DA status: `zeko.l1.settlements` (published by the L1 Watcher, Spike 006) and `zeko.l2.finality` (published by the sequencer, Spike 001 §4).
- **SurrealDB** — the read model the explorer's GraphQL APIs query. The relevant table for this spike is `batch`; relevant column is `batch.da_status`.

When the document says **"the indexer consumes message X from NATS subject Y"**, it means the JetStream consumer side. When it says **"the indexer writes column Z on the batch row in SurrealDB"**, it means the database upsert side. These are distinct actions inside the same process.

### 5.2 Two NATS subjects feed the same SurrealDB column

`batch.da_status` is set by the indexer in response to **either** of two NATS messages. For an existing `batch` row, the first attestation source the indexer processes wins; proved messages that arrive before the `batch` row exists are buffered until settlement creates the row:

- **Path A — `zeko.l1.settlements` arrives.** The settlement event implies the proof landed on L1, which implies DA quorum was reached (§4 invariant). The indexer upserts the SurrealDB `batch` row with `da_status = 'attested'`, `da_source = 'settlement'`, `da_attested_at = settlement.timestamp`. This path never depends on DA-layer connectivity.
- **Path B — `zeko.l2.finality` arrives with `level = 'proved'`.** The proved-finality event implies the sequencer assembled a valid proof, which implies DA quorum was reached. The indexer upserts the matching SurrealDB `batch` row with `da_status = 'attested'`, `da_source = 'proved'`, `da_attested_at = finality.timestamp`.

If the proved-finality NATS message is consumed before the SurrealDB `batch` row exists (the L1 Watcher hasn't seen the settlement yet), the indexer instead inserts a row in the SurrealDB `pending_da_attestation` table keyed on `ledger_hash`. When the corresponding settlement message later arrives and the indexer creates the `batch` row, the settlement upsert writes `da_source = 'settlement'` because the row is being created from the L1 settlement path, then deletes the pending row. Existing proved-source batch rows are not overwritten by later settlement messages; only settlement-related fields are added.

All writes are idempotent upserts; `da_status` never reverts from `'attested'` to anything else.

### 5.3 SurrealDB schema additions for Milestone 1

```surql
-- Columns added to the existing `batch` table.
DEFINE FIELD da_status      ON batch TYPE option<string>
  ASSERT $value IN ['attested'];
DEFINE FIELD da_attested_at ON batch TYPE option<datetime>;
DEFINE FIELD da_source      ON batch TYPE option<string>
  ASSERT $value IN ['settlement', 'proved', 'da-direct'];

DEFINE INDEX idx_batch_da_status ON batch FIELDS da_status;

-- Buffer table for proved-finality events that arrive before the
-- corresponding `batch` row has been created by a settlement event.
DEFINE TABLE pending_da_attestation SCHEMAFULL;
DEFINE FIELD ledger_hash  ON pending_da_attestation TYPE string;
DEFINE FIELD source       ON pending_da_attestation TYPE string
  ASSERT $value IN ['settlement', 'proved', 'da-direct'];
DEFINE FIELD attested_at  ON pending_da_attestation TYPE option<datetime>;
DEFINE FIELD received_at  ON pending_da_attestation TYPE datetime;

DEFINE INDEX idx_pending_da_hash ON pending_da_attestation FIELDS ledger_hash UNIQUE;
```

What was deliberately **not** added:

- **No `da_target_ledger_hash` column on `batch`.** The existing `batch.target_ledger_hash` (already present and indexed for L2 rollback handling, PRD §5.2.6) is the join key. Adding a duplicate would just go stale.
- **No DA-implementation, quorum, or signers columns** at Milestone 1. They are added together with Path C in Milestone 4/5 (§11.1) so the migration ships when the data to fill them ships.
- **No `'missing'` enum value on `da_status`.** Absence of attestation is `null`, not a terminal state (§9.3). Operational visibility for stalled hashes comes from `pending_da_attestation` rows older than one commit period, not from a column value.

The `'da-direct'` enum value is included on `da_source` at M1 so that the M4/M5 migration is purely additive — no `ALTER FIELD ... ASSERT` required when Path C ships. `pending_da_attestation.source` also admits `'settlement'` because L1 rollback handling can temporarily move a settlement-derived attestation fact out of a reverted `batch` row and into the pending buffer until the same `target_ledger_hash` settles again.

### 5.4 Indexer algorithm — Milestone 1

```
# On NATS message from subject `zeko.l1.settlements`:
on settlement(target_ledger_hash, settlement_timestamp, ...):
    existing = SurrealDB batch row matching target_ledger_hash, if any
    upsert SurrealDB batch row matching target_ledger_hash
        set <other settlement-related fields per Spike 006>
        if existing row is absent or existing.da_status is null:
            set da_status      = 'attested'
            set da_source      = 'settlement'
            set da_attested_at = settlement_timestamp
        else:
            leave existing da_status, da_source, and da_attested_at unchanged
    delete from SurrealDB pending_da_attestation where ledger_hash = target_ledger_hash

# On NATS message from subject `zeko.l2.finality`:
on finality(level, ledger_hash, finality_timestamp):
    if level != 'proved':
        # 'committed' is consumed elsewhere for the `committed_at` column;
        # not part of the DA-attestation derivation.
        return
    if SurrealDB batch row exists where target_ledger_hash = ledger_hash:
        if that row's da_status is null:
            update SurrealDB batch row
                set da_status      = 'attested'
                set da_source      = 'proved'
                set da_attested_at = finality_timestamp
        # else: already attested via settlement (more authoritative); drop
    else:
        upsert SurrealDB pending_da_attestation
            set ledger_hash  = ledger_hash
            set source       = 'proved'
            set attested_at  = finality_timestamp
            set received_at  = now()
```

### 5.5 Rollback handling — Milestone 1

L1 rollback events arrive on the NATS subject `zeko.l1.rollbacks` (Spike 006). When the indexer consumes one, it reverts the affected `batch` rows in SurrealDB. Reverting a row does not revert the underlying DA-attestation fact: the diff was attested by the DA layer regardless of what happened on L1. The indexer therefore copies the DA-related fields from the affected `batch` row into `pending_da_attestation` before clearing them, so a subsequent re-settlement of the same `target_ledger_hash` re-binds the attestation.

The indexer's L2 hash-chain rollback handling on `zeko.l2.transactions` (Spike 001 §5) does not touch `da_status` — a hash that was attested remains attested. Only the `batch` row's settlement lifecycle is reverted, not the DA fact.

### 5.6 Pruning stale pending entries

`pending_da_attestation` is a write-buffer, not durable history. Rows older than 30 days that never matched a `batch` row are pruned by a daily indexer maintenance task. This bounds storage in pathological cases (e.g., a chain that publishes proved events for batches that ultimately never settle).

### 5.7 Milestone 1 deliverable

A SurrealDB migration containing the schema in §5.3, plus the indexer NATS-consumer wiring in §5.4 and §5.5. **No new service.** `zeko.l2.finality` is already consumed by the indexer for the `committed_at` column on `batch`; this work adds the proved-level branch to that handler. `zeko.l1.settlements` is already consumed for `batch` row creation; this work adds `da_status`, `da_attested_at`, and `da_source` to the upsert. Acceptance coverage is the Cucumber feature files in §16.1.

---

## 6. Milestone 4/5 Pipeline — Overview

The Milestone 4/5 pipeline is two small pieces of code added to systems that already exist:

1. A NATS publisher inside the OCaml `zeko-da run-node` binary (§8). When the DA node persists a Schnorr signature for a `ledger_hash` to RocksDB, it also publishes a `zeko.da.signatures` message. Fire-and-forget; if NATS is unreachable the publish is dropped — the signature itself remains durable on RocksDB and the explorer's M1 derivation continues to mark the batch attested via the proved or settlement signals.
2. A new NATS subject handler inside the existing TS indexer (§9, §11). It consumes `zeko.da.signatures`, verifies each Schnorr signature against the DA receipt payload, accumulates distinct authorised signing public keys per `ledger_hash` in an in-memory LRU, and flips `batch.da_status = 'attested'` once the count reaches the configured `quorum`.

The same indexer process handles all three DA subjects (`zeko.l1.settlements`, `zeko.l2.finality`, `zeko.da.signatures`). The DA-node side gains one NATS publisher; the indexer side gains one subject handler. Total new infrastructure: zero services.

### 6.1 What M4/M5 adds

- `zeko.da.signatures` NATS subject — one self-authenticating message per `(operator, ledger_hash)` pair, published immediately after the DA node persists the signature.
- Per-operator signer detail on the SurrealDB `batch` row (`da_signers` array): which operator's public key signed, the timestamp, the operator's reported `instanceId`.
- A per-operator heartbeat on `zeko.health` published by each DA node directly. The explorer's `/status` page already aggregates `zeko.health` by service.
- A publisher abstraction on the OCaml DA-node side (§13) so a future Celestia DA target (§14) is a publisher swap, not an explorer rewrite.

### 6.2 What M4/M5 does not change

- The two M1 sources continue to write `batch.da_status`. `zeko.da.signatures` adds **Path C — DA-direct** as an additional, faster source. Path C never overrides Path A (settlement); it upgrades Path B (proved) by attaching signer detail (§11).
- Schema lifecycle: only **additive** changes to the `batch` table (`da_implementation`, `da_quorum_threshold`, `da_signers`) and to `pending_da_attestation` (the same three fields). Existing M1 rows remain valid.

---

## 7. DA Layer Reference

The Zeko DA layer is a multisig signer ring implemented in OCaml. A future Celestia DA target is planned and is addressed in §14.

### 7.1 Components

- **`zeko-da run-node`** — one OCaml process per operator. Receives diffs from the sequencer over `Async.Rpc` (binprot/TCP, default port `8080`), validates by reconstructing the target ledger, signs the DA receipt payload derived from `(target_ledger_hash, acc_set)` with a Mina-native Schnorr signature, and persists `(ledger_hash → diff)` and `(ledger_hash → signature)` mappings to RocksDB.
- **`zeko-signer`** — sidecar holding the operator's signing key.
- **HTTP healthcheck** — the DA node binds an HTTP server on port `8081` for `GET /healthz`.

### 7.2 Native types the publisher serializes

The DA node's internal types live in `src/app/zeko/da_layer/lib/rpc.ml` and the surrounding modules of the `zeko-labs/zeko` repository (`compatible` branch):

| Type | Source | On-wire form (§10.2) |
|---|---|---|
| `Ledger_hash.t` | Mina | Decimal string, identical to `target_ledger_hash` on `zeko.l2.transactions` (Spike 001 §6). |
| `Public_key.Compressed.t` | Mina | Base58check string (e.g. `B62q...`). |
| `Signature.t` | Mina | Hex-encoded `rs`-concatenation. |

These types change with Mina releases and have no stable JSON form maintained outside the OCaml tree, which is why serialisation belongs in the OCaml node — performing it once in the language where the types are native and emitting JSON to NATS keeps the explorer free of Mina internal coupling. The sequencer's `zeko.l2.transactions` publisher follows the same pattern (Spike 001 §6).

---

## 8. DA Node NATS Publisher (Milestone 4/5)

The OCaml `zeko-da run-node` binary gains a NATS publisher built on the same fire-and-forget contract as the sequencer's publisher (Spike 001 §5.2). When the node persists a Schnorr signature for a `ledger_hash` to RocksDB, it publishes a single self-authenticating message on `zeko.da.signatures`.

The publisher has four shape-defining properties:

- **Self-authenticating payloads.** Each message carries the Schnorr signature over the DA receipt payload derived from `ledgerHash` and `accSet`. Any consumer verifies the message using only on-the-wire crypto and the authorised DA signer set; the publisher's NATS account identity is not load-bearing for correctness.
- **Outbound-only network requirement.** The operator needs only outbound NATS connectivity from their network. There is no inbound HTTP shim, no ingress allowlist, no per-source rate limiting to operate.
- **Load proportional to signing rate.** Steady-state publish rate equals the rate at which the sequencer asks the DA node to sign. No fixed cadence, no background traffic.
- **Opt-in per operator.** Operators who do not configure `--nats-url` are unaffected by this change and continue to behave exactly as today. The explorer still marks their batches `da_status = 'attested'` via the M1 sources (§5).

### 8.1 Publish point

Inside `Da_layer.run_node` the flow is:

1. Receive diff via `Async.Rpc` (`enqueue_diff`).
2. Reconstruct target ledger from local RocksDB state plus diff.
3. `Schnorr.sign` the resulting `target_ledger_hash` with the operator's signing key.
4. Persist `(ledger_hash → diff)` and `(ledger_hash → signature)` to RocksDB.
5. Return ack to the sequencer.

The publisher hooks **between step 4 and step 5**: after the signature is durably persisted (so a publish never claims a signature absent from disk), and before the sequencer ack (so a successful ack is correlated with a published signature on the happy path). The publish itself is non-blocking — the ack does not wait for NATS to confirm.

### 8.2 Fire-and-forget semantics

- If `--nats-url` is not set, the publisher is disabled.
- If NATS is unreachable, the publish call returns an error which is logged at `warn` and discarded. There is no buffer, no retry, no on-disk publish journal.
- The signature itself remains in RocksDB. If quorum is reached at the L1 contract's signature check, the explorer's `batch.da_status` is filled by the proved or settlement signal regardless of the missed publish.
- On DA-node restart the publisher does **not** scan RocksDB for unpublished signatures. The two M1 sources cover any gap.

### 8.3 Implementation

- Add `--nats-url` flag (default unset) to `src/app/zeko/da_layer/cli.ml`.
- Add `--nats-stream` flag (default `zeko-da`).
- Add an `Nats_publisher` module — roughly 50 lines of OCaml — that holds the JetStream connection and exposes `publish_signature : ledger_hash:Ledger_hash.t -> signature:Signature.t -> unit Deferred.t`. The connection is established lazily on first publish and reconnects with exponential backoff on disconnect.
- Hook the publish call in `run_node` after the persist step described in §8.1. Use the serialization helpers shared with the sequencer (decimal-encoded `Ledger_hash`, base58check `Public_key.Compressed`).
- Set `Nats-Msg-Id: da-sig-{publicKey}-{ledgerHash}` for JetStream dedup.
- Each DA node publishes a `zeko.health` heartbeat on a timer (default 30s) with its `publicKey`, `instanceId` (UUID generated at process start), `last_signed_hash`, `last_signed_at`.

The whole publisher is roughly 80 lines of OCaml.

### 8.4 Operator authentication to NATS

NATS per-publisher accounts with subject ACLs scope each operator: their account is authorised to publish only to `zeko.da.signatures` with `publicKey = $own_pk` and to `zeko.health` with `service = "da-node-$own_pk"`. Provisioning is one-time per operator per network.

---

## 9. Indexer Aggregation (Milestone 4/5)

The TS indexer gains a third JetStream subscription, `zeko.da.signatures`, alongside the two it already consumes for M1 (`zeko.l1.settlements` and `zeko.l2.finality`).

### 9.1 Subscription

- JetStream pull-subscribe to `zeko.da.signatures` with durable name `indexer-da-{network}`.
- `DeliverPolicy = New` on first deploy. Historical batches are attested via the M1 sources; the indexer does not retroactively aggregate past signatures.
- On subsequent restarts JetStream resumes from the last ack.

### 9.2 Aggregation logic

For each consumed `zeko.da.signatures` message:

1. **Verify the Schnorr signature** of `publicKey` over the DA receipt payload, `RandomOracle(ledgerHash, accSet)`, using the same salt as the OCaml DA layer and `rule_commit`. Drop with a `warn` log on verification failure. The on-the-wire crypto, not the NATS account, is what authenticates the message.
2. **Authorise the signer.** Check `publicKey` against the configured/on-chain DA signer set for the network. Unknown keys are logged, acked, and ignored before they can enter quorum accounting.
3. **Update per-hash signer state.** The indexer maintains an in-memory `LRU<ledger_hash, Set<publicKey>>` cache (default cap 4096 entries) seeded on startup from any `pending_da_attestation` rows with `source = 'da-direct'`. Add `publicKey` to the set.
4. **Persist to SurrealDB.** Upsert the `pending_da_attestation` row for `ledger_hash` with the appended signer entry. If the corresponding `batch` row already exists, upsert it directly with the appended `da_signers` entry instead — same upsert path as §11.2.
5. **Quorum check.** If the authorised signer set's size has just crossed `quorum`, set `batch.da_status = 'attested'` (or copy the buffer onto the freshly-created `batch` row when settlement creates it).
6. **Ack the NATS message.**

`quorum` and the DA signer public-key list are per-network configuration on the indexer, with the L1 contract's helper-account signer set used as the source of truth when it can be read at startup. The configured threshold and key set must match the L1 contract. If startup validation finds a mismatch, the indexer logs a warning and disables Path C `da_status` flips until configuration is corrected; Paths A and B continue to fill `da_status` correctly (failure mode #10, §12).

### 9.3 No terminal "missing" state

Absence of signatures is the signal that quorum has not been reached. The indexer does not write `da_status = 'missing'`. A batch whose signers never reach quorum stays `da_status = null` until one of:

- Path A marks it attested via L1 settlement. (This is impossible if quorum was genuinely never reached, since the proof would be unsatisfiable.)
- It remains null indefinitely and is surfaced on the operator `/status` page from the count of `pending_da_attestation` rows older than one commit period.

### 9.4 LRU eviction

The signer-set LRU bounds memory at 4096 in-flight hashes. If a hash is evicted before quorum is reached, subsequent signatures for it are reseeded from the SurrealDB `pending_da_attestation` row on the next message arrival. Eviction is therefore correct but slightly slower; under sustained high throughput the LRU cap can be raised via configuration.

---

## 10. NATS Schemas (Milestone 4/5)

### 10.1 Stream

`zeko-da` (declared in PRD §5.2.4). Subjects: `zeko.da.>`. Retention: limits, max-age 90d, dedup window 5m.

### 10.2 `zeko.da.signatures` — message body

One message per `(operator, ledger_hash)` pair, published by the operator's DA node directly.

```json
{
  "schemaVersion": 1,
  "implementation": "zeko-multisig-v1",
  "ledgerHash": "<decimal>",
  "accSet": "<decimal>",
  "publicKey": "B62q...",
  "signature": "<Mina Schnorr signature, hex-encoded (rs concat)>",
  "instanceId": "<uuid generated at DA-node process start>",
  "signedAt": "2026-05-07T12:34:57.012Z"
}
```

The message is **self-authenticating**: any consumer can recompute the DA receipt payload as `RandomOracle(ledgerHash, accSet)` using `Zeko_constants.da_layer_check_salt`, then verify `signature` against that payload and `publicKey` using Mina Schnorr verification. Identity of the NATS publisher account is unrelated to the truth of the message; the indexer trusts the cryptography and the configured/on-chain DA signer set, not the connection.

### 10.3 Field semantics

| Field | Notes |
|---|---|
| `schemaVersion` | Integer. Bumped only on incompatible shape changes. |
| `implementation` | `"zeko-multisig-v1"` for the current OCaml multisig; `"celestia-v1"` after migration. Lets consumers route to the right interpreter. |
| `ledgerHash` | Decimal-encoded `Ledger_hash`, identical to `target_ledger_hash` in `zeko.l2.transactions`. Indexer joins on this. |
| `accSet` | Decimal-encoded account-set root used by the DA layer receipt. This is the second field in the signed DA receipt payload and matches the `acc_set` value attached to the corresponding `zeko.l2.transactions` diff. |
| `publicKey` | Base58check-encoded `Public_key.Compressed`. The signing operator's identity. Must be present in the configured/on-chain helper-account public-key list before it counts toward quorum. |
| `signature` | Hex-encoded Mina Schnorr signature over `RandomOracle(ledgerHash, accSet)` with `Zeko_constants.da_layer_check_salt`. Verified by the indexer; messages with invalid signatures are dropped with a `warn` log. |
| `instanceId` | UUID regenerated on each DA-node process start. Lets the indexer record which operator process produced the signature; useful for postmortem of operator-side incidents. |
| `signedAt` | When the DA node persisted the signature to RocksDB. Used as the per-signer `observedAt` on the `batch.da_signers` array. |

### 10.4 Dedup key

`Nats-Msg-Id: da-sig-{publicKey}-{ledgerHash}`

This is exactly idempotent: repeatedly publishing the same signature (e.g., as a result of operator-side replay tooling) produces at most one persisted NATS message within the dedup window. Across operators, two different `publicKey` values for the same `ledgerHash` produce two distinct messages — exactly what the indexer needs for quorum aggregation.

### 10.5 `zeko.health` — per-DA-node heartbeat

Each DA node publishes its own heartbeat directly. The indexer aggregates them on the `/status` page.

```json
{
  "service": "da-node",
  "instanceId": "<uuid>",
  "publicKey": "B62q...",
  "implementation": "zeko-multisig-v1",
  "publishedAt": "2026-05-07T12:35:00.000Z",
  "lastSignedHash": "<decimal>",
  "lastSignedAt": "2026-05-07T12:34:57.012Z",
  "natsConnected": true
}
```

The aggregate "DA layer healthy" condition shown in the explorer's freshness badge (PRD §6.1) is computed by the indexer: count distinct `publicKey` values whose `publishedAt` is within the last `2 × heartbeat_interval`. If that count drops below `quorum`, the badge shows degraded.

---

## 11. Indexer Integration (Milestone 4/5)

`zeko.da.signatures` is **Path C — DA-direct**, the third source the indexer accepts for `batch.da_status`. It is the fastest source (sub-second from sign-time) and the only source that carries per-operator signer detail. Path A (settlement) and Path B (proved) remain in place and continue to fill the column when the Path C pipeline is unavailable. Rows written by Path C carry `da_source = 'da-direct'`.

### 11.1 Additive SurrealDB schema changes

```surql
-- Per-attestation detail accumulated from `zeko.da.signatures`. All optional;
-- absent on rows whose da_source is 'settlement' or 'proved'.
DEFINE FIELD da_implementation   ON batch TYPE option<string>;
DEFINE FIELD da_quorum_threshold ON batch TYPE option<int>;
DEFINE FIELD da_signers          ON batch TYPE option<array<object>>;

-- Same detail mirrored on the buffer table so signatures arriving before the
-- batch row exists are accumulated and transferred to the batch row when it
-- is created.
DEFINE FIELD implementation   ON pending_da_attestation TYPE option<string>;
DEFINE FIELD quorum_threshold ON pending_da_attestation TYPE option<int>;
DEFINE FIELD signers          ON pending_da_attestation TYPE option<array<object>>;
```

What was deliberately **not** added:

- **No `da_quorum_achieved` column.** It would always equal `len(da_signers)` for any row written by Path C, and is undefined for rows written by Paths A or B (which never see signer detail). The GraphQL resolver computes it from `len(da_signers)` if needed.

The `da_source` enum was provisioned in M1 (§5.3) to include `'da-direct'` so no ASSERT change is needed when this milestone ships.

### 11.2 Algorithm extension

The M1 settlement and proved handlers (§5.4) are unchanged. One handler is added:

```
# On NATS message from subject `zeko.da.signatures`:
on signature(ledger_hash, acc_set, public_key, signature, instance_id,
             implementation, signed_at):
    # 1. Verify the Schnorr signature over the same receipt payload that
    # rule_commit verifies in-circuit: RandomOracle(ledger_hash, acc_set).
    payload = da_receipt_payload(ledger_hash, acc_set)
    if not Schnorr.verify(signature, public_key, payload):
        log_warn("invalid DA signature", ledger_hash, public_key)
        return

    # 2. Only the configured/on-chain DA signer set can contribute to quorum.
    if public_key not in authorised_da_public_keys:
        log_warn("unauthorised DA signer", ledger_hash, public_key)
        return

    # 3. Append this signer to the in-memory signer-set LRU.
    signer_entry = { publicKey, instanceId, signedAt: signed_at }
    signer_set  = lru.get_or_init(ledger_hash, source=pending_da_attestation)
    if public_key in signer_set: return            # already counted
    signer_set.add(public_key)

    # 4. Persist the appended signer detail to SurrealDB.
    if SurrealDB batch row exists where target_ledger_hash = ledger_hash:
        if batch.da_source = 'settlement':
            # Settlement is authoritative; record signer detail but do not
            # change da_status or da_source.
            update SurrealDB batch row
                append da_signers     << signer_entry
                set    da_implementation    = implementation if null
                set    da_quorum_threshold  = quorum if null
        else:
            # da_source is null or 'proved' — Path C populates everything.
            update SurrealDB batch row
                append da_signers     << signer_entry
                set    da_implementation    = implementation
                set    da_quorum_threshold  = quorum
                if size(da_signers after append) >= quorum:
                    set da_status      = 'attested'
                    set da_source      = 'da-direct'
                    set da_attested_at = signed_at
    else:
        # Batch row not yet created — buffer in pending_da_attestation.
        upsert SurrealDB pending_da_attestation
            set ledger_hash      = ledger_hash
            set source           = 'da-direct'
            set implementation   = implementation
            set quorum_threshold = quorum
            append signers       << signer_entry
            set received_at      = now()
            if size(signers after append) >= quorum:
                set attested_at  = signed_at

# On settlement (unchanged from §5.4) — additionally transfer detail:
on settlement(...):
    upsert batch as before
    on transfer from pending_da_attestation:
        if pending.source = 'da-direct':
            copy implementation, quorum_threshold, signers,
                 (attested_at if pending reached quorum) → batch
        delete pending row
```

Source precedence on `da_source` is **settlement > da-direct > proved**:

- Settlement is never overwritten. Signer detail from Path C may still be recorded on the row (`da_signers`) as supplementary information, but `da_status`, `da_source`, and `da_attested_at` reflect the settlement.
- `da-direct` overwrites `proved` (same fact, but with signer detail attached).
- `proved` is never written if `da-direct` or `settlement` is already there.

### 11.3 Bootstrap

The indexer opens its NATS consumer for `zeko.da.signatures` with `DeliverPolicy = New` on first deploy. Historical batches on a long-running chain are already marked attested via Paths A and B; the indexer does not retroactively aggregate past signature messages, even if they are present in the stream.

On indexer restart the durable consumer resumes from the last ack. Any signature messages published while the indexer was down are redelivered; the in-memory signer-set LRU is reseeded from `pending_da_attestation` on startup, so signers accumulated across a restart are not double-counted.

---

## 12. Failure Modes (Milestone 4/5)

The Path C failure surface has two parts: publisher misbehaviour (DA-node-side) and consumer misbehaviour (indexer-side). In every case Paths A and B continue to fill `batch.da_status` correctly.

| # | Failure | Detection | Effect | Recovery |
|---|---|---|---|---|
| 1 | Operator runs the DA node without `--nats-url` (publisher disabled) | No `zeko.da.signatures` messages for that `publicKey`; the operator's `zeko.health` heartbeat is also absent | That operator's signatures never reach the indexer. If the remaining publishers ≥ quorum, Path C still flips `da_status = 'attested'` and the non-participating operator simply never appears in `da_signers`. If publishers < quorum, Path C is dormant and the row is attested later via Path B (proved) or Path A (settlement). | Operator action. Paths A and B keep correctness throughout. |
| 2 | Operator's DA node has NATS unreachable | Outbound NATS connect/publish fails inside the OCaml node; logged at `warn` | The publish is silently dropped (§8.2). The Schnorr signature is still on RocksDB and the diff still reaches the L1 contract. Same observable outcome as #1: that operator's signature is missing from `da_signers` for the affected `ledger_hash`. | Automatic when NATS reachability returns. No backfill is attempted — Paths A and B cover the lost detail. |
| 3 | Operator process crashes between persist and NATS publish | No publish for the affected `ledger_hash`; signature still durable on RocksDB | Same as #2: signature is durable on-chain (via the eventual L1 commit) but the per-signer detail for that one hash is lost on Path C. | None required for correctness. Operator restart resumes publishing for new signatures. |
| 4 | Indexer NATS-consumer outage (indexer down) | JetStream consumer lag grows | All three subscriptions (`zeko.l1.settlements`, `zeko.l2.finality`, `zeko.da.signatures`) stop draining. On restart the durable consumers resume from their last acks and the in-memory signer-set LRU is reseeded from `pending_da_attestation` (§11.3). | Automatic on indexer restart. No data loss; latency briefly elevated. |
| 5 | Invalid Schnorr signature received on the wire | `Schnorr.verify` returns false in §11.2 step 1 | Message dropped with a `warn` log; the message is acked so it does not redeliver. The corresponding `publicKey` does not enter the signer set. This is one protection against a compromised NATS publisher account: identity is established by the on-the-wire crypto, not by the connection. | None — invalid messages have no persisted effect. Operator-side bug to investigate via the `instanceId` in the warn log. |
| 6 | Signature from a public key outside the DA signer set | `publicKey` is absent from the configured/on-chain helper-account public-key list | Message dropped with a `warn` log and acked. The signature may be cryptographically valid for that key, but it does not count toward the contract's DA quorum and is not persisted as a signer entry. | Operator/config investigation. If the key set changed intentionally, update the indexer configuration or contract-derived signer-set reader before relying on Path C. |
| 7 | Duplicate-signature replay (operator-side retry tooling republishes a signature) | Same `(publicKey, ledger_hash)` pair publishes more than once | JetStream's dedup window (§10.4) drops the duplicate before it reaches the indexer. If a replay happens outside the dedup window, the indexer's signer-set check (`if public_key in signer_set: return`, §11.2 step 3) suppresses the double-count. | Idempotent by construction. No operator action required. |
| 8 | Signer set never reaches quorum | `pending_da_attestation` row for a `ledger_hash` persists with `len(signers) < quorum` longer than one commit period | `batch.da_status` stays null (Path C dormant). The corresponding diff cannot have a valid L1 proof either (the proof's circuit constraint requires quorum), so Path A and Path B are also dormant — the chain is genuinely stalled on this hash. `/status` surfaces the stalled hash via "pending DA attestations older than commit period". | Operational investigation — typically one or more operators failing to sign. Independent of the explorer. |
| 9 | Two indexer instances running simultaneously (rolling deploy overlap) | Both share the JetStream durable consumer for `zeko.da.signatures` | JetStream delivers each message to exactly one instance. Both instances upsert the same SurrealDB rows; the per-signer entry is idempotent via SurrealDB's primary-key upsert, and the in-memory LRU may briefly disagree across instances but converges on the next message. No persisted duplicate. | Tolerated for short rolling-deploy windows. |
| 10 | Indexer configured `quorum` or signer set doesn't match the L1 contract | Logged on indexer startup against the L1 contract's helper-account key list and threshold (read at startup) | Path C `da_status` flips are disabled for that process so a bad threshold/key set cannot mark a batch attested early. The indexer may still record signer detail for diagnostics, and Paths A/B fill `da_status` at the usual latency. | Operational fix at deploy. The indexer logs the on-chain threshold/key set and configured threshold/key set at startup; mismatch is a startup warning. |
| 11 | `schemaVersion` mismatch on the wire | Unknown `schemaVersion` value | Message dropped with a `warn` log; acked so it does not redeliver. Existing-version messages continue to be processed. | Indexer rollout to support the new schema, then operators upgrade their publishers — or vice versa. The indexer never crashes on an unknown version. |

**Correctness of `batch.da_status` does not depend on the Path C pipeline.** Paths A and B are independent and self-healing, so every row above ends with `da_status` correctly populated — only Path C latency and signer detail are affected.

---

## 13. Abstract DA Adapter (Milestone 4/5)

DA-implementation-specific work lives on two surfaces — a **publisher** inside the DA-layer service that emits `zeko.da.*` messages, and a **consumer dispatch** inside the indexer that routes each message to a handler keyed on its `implementation` field.

### 13.1 Publisher side (OCaml, inside the DA-layer service)

```ocaml
module type Da_publisher = sig
  val implementation : string
  (* Called from inside the DA-layer service at the moment an attestation
     fact becomes durably true on the underlying layer.  For the multisig
     this is "Schnorr signature just persisted to RocksDB" (§8.1); for a
     Celestia-style layer it is "blob inclusion proof just observed". *)
  val publish_attestation
    :  ledger_hash:Ledger_hash.t
    -> attestation:Attestation.t
    -> unit Deferred.t
end
```

`Attestation.t` is the implementation-specific payload — `Schnorr.signature` plus the signed `accSet` receipt field for the multisig, `{ height; namespace; commitment; inclusion_proof }` for Celestia. The publisher serialises its payload into the JSON shape on `zeko.da.signatures`.

`Multisig_publisher` is the implementation that ships with M4/M5: it hooks into `Da_layer.run_node` after the persist step (§8.1), produces one message per `(operator, ledger_hash)` pair, and sets `implementation = "zeko-multisig-v1"`.

### 13.2 Consumer side (TypeScript, inside the indexer)

```typescript
interface DaImplementationHandler {
  readonly implementation: string;

  // Verify the on-the-wire payload — Schnorr verify of
  // RandomOracle(ledgerHash, accSet) for multisig,
  // blob-inclusion-proof verify against a finalized header for Celestia.
  verify(message: DaMessage): boolean;

  // Compute the contribution of this message to the per-hash attestation
  // state. For the multisig, this is "add one authorised publicKey to the
  // signer set".
  // For Celestia, a single message is itself sufficient for attestation.
  apply(state: AttestationState, message: DaMessage): AttestationState;

  // Whether the current state of `state` is sufficient to mark the batch
  // row da_status = 'attested'. For multisig: authorised signers.size >= quorum.
  // For Celestia: any verified inclusion proof.
  isQuorumReached(state: AttestationState): boolean;
}
```

The indexer reads `message.implementation` from each `zeko.da.signatures` message and dispatches to the matching `DaImplementationHandler`. A network running mid-migration — some operators publishing as `zeko-multisig-v1`, the same network's Celestia bridge publishing as `celestia-v1` — is supported by registering both handlers. The L1 contract decides which actually counts toward an on-chain proof.

The abstraction factors only the parts that differ between implementations (verification, "what is a signer", "when is quorum reached"). It imposes no state machine on implementations that have none.

---

## 14. Celestia DA Target

A future Celestia DA target is supported as a publisher swap on the DA-layer side. The explorer's NATS schema and SurrealDB schema are unchanged — `zeko.da.signatures` continues to carry attestation messages; only the `implementation` value and the per-message payload differ.

### 14.1 Where the publisher lives

Celestia has no per-operator multisig. A single bridge process per network — `zeko-da-celestia-bridge` — subscribes to Celestia's header stream and publishes one `zeko.da.signatures` message per finalised Zeko-namespace blob. The bridge implements `Da_publisher` (§13.1) with `implementation = "celestia-v1"`. A celestia-node exposes a single JSON-RPC endpoint (default `:26658`, WebSocket on the same port, bearer-token auth) that the bridge consumes.

### 14.2 Message shape (Celestia variant)

```json
{
  "schemaVersion": 1,
  "implementation": "celestia-v1",
  "ledgerHash": "<decimal>",
  "celestia": {
    "height": 1234567,
    "namespace": "0x...",
    "commitment": "0x...",
    "inclusionProof": "<base64>"
  },
  "publishedAt": "..."
}
```

The `publicKey` / `signature` / `instanceId` fields are absent. The indexer's `DaImplementationHandler` for `"celestia-v1"` (§13.2) verifies the inclusion proof against a finalised header it tracks separately and treats one verified message as quorum.

### 14.3 What carries over unchanged

- `batch.da_status` enum, source-precedence rules, and Paths A/B.
- `pending_da_attestation` as the pre-batch-row buffer. Each pending row carries one entry rather than a quorum-sized signer list.
- The `da_signers` column. A single inclusion-proof entry is appended exactly the way a Schnorr signer entry is appended for the multisig.

### 14.4 Sequencer-side mapping (open)

The mapping from `target_ledger_hash` to `(height, namespace, commitment)` is decided by the sequencer-side Celestia migration, not this spike. Once the sequencer's Celestia client publishes that mapping — likely as additional fields on `zeko.l2.transactions` or on a new `zeko.l2.da-submission` subject — `zeko-da-celestia-bridge` reads it and pairs each finalised blob back to its `ledgerHash`.

---

## 15. CLI

Milestone 4/5 adds two optional flags on the existing `zeko-da run-node` binary in the `zeko-labs/zeko` repository, plus one indexer configuration value. No new binary is introduced.

### 15.1 DA node addition (`zeko-labs/zeko`)

```bash
zeko-da run-node \
  --port 8080 \
  --http-port 8081 \
  --nats-url nats://nats.zeko-m-mainnet.svc:4222 \
  --nats-stream zeko-da \
  [other existing flags]
```

| Flag | Default | Effect |
|---|---|---|
| `--nats-url` | unset | Enables the NATS publisher. When set, the node publishes one `zeko.da.signatures` message per persisted Schnorr signature, plus a periodic `zeko.health` heartbeat. When unset, the publisher is disabled and the DA node behaviour is unchanged. |
| `--nats-stream` | `zeko-da` | JetStream stream name. Matches the stream declared in PRD §5.2.4. |

Heartbeat interval (30s), implementation identifier (`zeko-multisig-v1`, a compile-time constant), and the `instanceId` UUID (generated at process start) are not user-configurable.

### 15.2 Indexer addition (this repository)

The indexer process gains a `da` configuration block in its per-network config file:

```yaml
da:
  quorum: 2  # must match the L1 contract's signature-check threshold
  publicKeys:
    - B62q...
    - B62r...
    - B62s...
```

The indexer reads the L1 contract's actual threshold and helper-account public-key list on-chain at startup when available, logs both the configured values and the on-chain values on the first `zeko.health` heartbeat, and warns at startup on mismatch (failure mode #10, §12). A mismatch disables Path C `da_status` flips for that process; Paths A and B remain active. Path C quorum accounting uses only authorised keys, so a valid Schnorr signature from any other key is ignored.

---

## 16. Test Scenarios

Cucumber feature files live under `spikes/007-da-monitor/test-scenarios/`. Each file groups scenarios for one cohesive area; step definitions are written once and reused across the suite.

### 16.1 Milestone 1

| File | Coverage |
|---|---|
| [`test-scenarios/m1-da-status-derivation.feature`](./test-scenarios/m1-da-status-derivation.feature) | Settlement-derived path, proved-derived path, proved-before-batch buffering, settlement-vs-proved race, settlement does not overwrite proved-source rows, committed-level finality is ignored. |
| [`test-scenarios/m1-da-status-resilience.feature`](./test-scenarios/m1-da-status-resilience.feature) | L1 rollback preserves the attestation fact in `pending_da_attestation`, idempotency under duplicate settlement and proved messages, pruning of stale pending rows. |

### 16.2 Milestone 4/5

| File | Coverage |
|---|---|
| [`test-scenarios/m45-da-signatures-publishing.feature`](./test-scenarios/m45-da-signatures-publishing.feature) | DA node publishes one `zeko.da.signatures` message per persisted Schnorr signature, self-authentication against `(ledgerHash, accSet)` (invalid signatures dropped on the indexer side), `--nats-url` opt-out leaves DA node behaviour unchanged, JetStream dedup on `(publicKey, ledgerHash)`, implementation-id propagation, per-DA-node `zeko.health` heartbeat. |
| [`test-scenarios/m45-indexer-aggregation.feature`](./test-scenarios/m45-indexer-aggregation.feature) | Path C flips `da_status = 'attested'` when distinct authorised signing public keys reach quorum, unauthorised keys are ignored, signer-set LRU reseed from `pending_da_attestation` on indexer restart, no retroactive aggregation on first deploy (`DeliverPolicy = New`), two indexer instances during a rolling deploy share the durable consumer, NATS publish loss does not break correctness (Paths A/B fill in). |
| [`test-scenarios/m45-source-precedence.feature`](./test-scenarios/m45-source-precedence.feature) | Path C upgrades a proved-source batch with signer detail, settlement is never overwritten by Path C, Path C as the first source, signatures arriving before the batch row exists are buffered in `pending_da_attestation`, signer set never reaches quorum leaves `da_status = null`. |
| [`test-scenarios/m45-configuration.feature`](./test-scenarios/m45-configuration.feature) | Indexer configured quorum and DA signer key set are logged at startup and on every heartbeat, mismatch against the L1 contract threshold/key set is a startup warning that disables Path C flips, DA node without `--nats-url` is supported (no publish, no heartbeat), DA node with `--nats-url` publishes the `instanceId` on every message and heartbeat, unknown `schemaVersion` on the wire is dropped with a warn log. |

---

## 17. References

- PRD §5.2.3 (DA-layer architecture), §5.2.4 (NATS streams), §5.2.5 (indexer), §5.2.6 (SurrealDB schema), §6.1 (freshness badge).
- `spikes/001-sequencer-connector/results.md` — `zeko.l2.transactions` and `zeko.l2.finality` schemas, proved-level publish point, fire-and-forget NATS publisher pattern, durable-consumer model, `instanceId` restart-detection pattern.
- `spikes/006-l1-watcher/README.md` — `zeko.l1.settlements` schema providing the `target_ledger_hash` join key for Path A in §5 and §11.
- `zeko-labs/zeko` repository, `compatible` branch:
  - `src/app/zeko/da_layer/lib/rpc.ml` — native types serialised by the DA-node publisher (§7.2).
  - `src/app/zeko/da_layer/lib/client.ml` — `enqueue_diff`, `distribute_diff` (sequencer-side counterparts to the publish point in §8.1).
  - `src/app/zeko/da_layer/cli.ml` — DA node CLI surface; receives `--nats-url` / `--nats-stream` in §15.1.
  - `src/app/zeko/circuits/design/da-layer.md` — DA layer design notes.
  - `src/app/zeko/circuits/rule_commit.ml` — in-circuit multisig verification (the load-bearing fact behind §4).
- Celestia documentation: `docs.celestia.org/build/rpc/node-api/`, `node-rpc-docs.celestia.org` — interface for the bridge in §14.
