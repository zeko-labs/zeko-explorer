# Spike 001: Sequencer Connector — Results

**Status:** Complete
**Date:** 2026-04-02

---

## 1. Archive Relay Analysis

The existing archive relay at `src/app/zeko/sequencer/archive_relay/archive_relay.ml` (476 lines) provides context for how L2 data is currently consumed. The new NATS integration replaces its role for the explorer pipeline.

### Three Connections

1. **Sequencer GraphQL** — polls `stateHashes { unprovedLedgerHash }` every 15s (configurable via `--sync-period`, default 30s). This is how the relay discovers new state.
2. **DA Layer binary RPC** — streams `Da_layer.Diff.V3` diffs via `Da_layer.Client.iter_diffs`. This is the actual data transport — diffs are fetched between the relay's current ledger hash and the target hash from step 1.
3. **Mina Archive Node RPC** — dispatches `Archive_lib.Diff.Transition_frontier` breadcrumbs to a Mina archive node (PostgreSQL) via `Archive_client.dispatch`.

### Data Flow

```
Sequencer GraphQL ──poll──> unprovedLedgerHash
                                   │
DA Layer RPC ──iter_diffs──> Da_layer.Diff.V3 stream
                                   │
                            Apply to local ledger
                            Build Transition_frontier breadcrumb
                                   │
Archive Node RPC ──dispatch──> PostgreSQL
```

### Crash Recovery

- Checkpoints local ledger DB every N transactions (configurable via `--checkpoint-periodicity`, default 100)
- On **any** error: resets to last checkpoint (`reset_ledger`), retries the full sync from that point
- Source hash mismatch at line 286-291 triggers `failwithf` → exception → caught by `run` loop → `reset_ledger` → retry

### Known Issues

| Issue | Detail |
|---|---|
| **No fork detection** | Source hash mismatch = crash → reset → retry from last checkpoint. No graceful handling of forks or rollbacks. |
| **15-30s polling latency** | Relay polls sequencer GraphQL at `sync_period` intervals. New transactions are invisible until the next poll. |
| **No idempotency** | If the relay crashes between applying a diff to its local ledger and dispatching to the archive node, it may re-dispatch on recovery. |
| **No health reporting** | No heartbeat, no progress metrics, no alerting. |
| **Checkpoint-based recovery** | Progress is lost back to last checkpoint on crash (potentially 100 transactions). |
| **Full ledger maintenance** | Maintains a complete local ledger copy, which is expensive and only needed for building Mina archive breadcrumbs. |

### Key Files

| File | Purpose |
|---|---|
| `src/app/zeko/sequencer/archive_relay/archive_relay.ml` | Main relay logic (sync, checkpoint, dispatch) |
| `src/app/zeko/sequencer/archive_relay/cli.ml` | CLI args: `--zeko-uri`, `--da-node`, `--archive-host`, `--archive-port`, `--sync-period`, `--checkpoint-periodicity` |
| `src/app/zeko/da_layer/lib/client.ml` | DA layer client (`enqueue_diff`, `iter_diffs`, `start_posting_diffs_from`) |
| `src/app/zeko/da_layer/lib/diff.ml` | `Da_layer.Diff.Stable.V3.t` type definition with `[@@deriving yojson]` |
| `src/app/zeko/sequencer/lib/zeko_sequencer.ml` | Main sequencer logic (where diffs are created) |

---

## 2. Decision: Sequencer Publishes Directly to NATS

The sequencer itself gains the ability to publish diffs to NATS JetStream as a configurable option. No separate connector process, no DA layer in the read path.

### Rationale

| Factor | Direct publish | Standalone connector |
|---|---|---|
| **Latency** | Zero — publish at the moment the diff is created | 15-30s polling delay minimum |
| **Complexity** | ~200 lines added to sequencer + NATS client library | Separate process with checkpoint management, health monitoring, error recovery |
| **Data access** | Sequencer already has the diff, target hash, and full context | Must reconstruct context from GraphQL + DA layer binary RPC |
| **Language** | OCaml (sequencer is OCaml) | OCaml required regardless — DA layer uses OCaml binary RPC |
| **Failure mode** | NATS down = skip publish, sequencer continues, DA posting unaffected | Connector down = silent data gap, no one notices without monitoring |
| **Fork knowledge** | Sequencer has first-hand knowledge of rollbacks | Must infer forks from hash chain breaks (archive relay pattern) |

### Why Not a Standalone Connector

The DA layer communicates via OCaml binary RPC (`Daemon_rpcs`), not HTTP/JSON. A TypeScript connector cannot call `Da_layer.Client.iter_diffs` without either:
1. Writing an OCaml binary RPC client in TypeScript (impractical), or
2. Adding a JSON API to the DA layer (requires OCaml changes in the zeko repo anyway)

Publishing directly from the sequencer is simpler, faster, and provides better rollback information.

---

## 3. NATS Publishing Integration Points

Three locations in `zeko_sequencer.ml` where `Da_layer.Client.enqueue_diff` is called. A NATS publish call should be added immediately after each one.

### 3.1 User Command Processing (Primary Transaction Path)

**Function:** `apply_user_command` (line 332)
**`enqueue_diff` call:** line 497
**Context available:**
- `diff` — the `Da_layer.Diff` containing `source_ledger_hash`, `changed_accounts`, `command_with_action_step_flags`, `timestamp`
- `L.Db.merkle_root t.ledger` — the target ledger hash (line 503)
- `command` — the full `User_command.t` (signed command or zkapp command)
- `changed_accounts` — list of `(index, Account.t)` pairs
- `source_ledger` — sparse ledger before the transaction

**Publish to:** `zeko.l2.transactions`

### 3.2 Fee Transfer (Sequencer Fee Collection)

**Function:** `apply_fee_transfer` (line 517)
**`enqueue_diff` call:** line 573
**Context available:**
- `diff` — contains `source_ledger_hash`, `changed_accounts` (sequencer's account only), `command_with_action_step_flags: None`
- `L.Db.merkle_root t.ledger` — the target ledger hash (line 579)
- No user command — this is an internal fee transfer

**Publish to:** `zeko.l2.transactions`

**Note:** Fee transfers have `command_with_action_step_flags: None` in the diff. The indexer should handle this case (no command, just account balance changes).

### 3.3 Genesis Diff Creation (Sync/Startup)

**Function:** `sync` (line 766)
**`enqueue_diff` call:** line 804
**Context available:**
- `diff` — genesis diffs created by `Da_layer.Client.create_genesis_diffs`
- `target_ledger_hash` — provided by the function
- `genesis` flag — `true` for the first diff

**Publish to:** `zeko.l2.transactions`

**Note:** Genesis diffs are created during initial sync when the sequencer starts with an existing L1 committed state. These establish the initial ledger state. The first diff has `genesis: true`.

### Sequencer `t` Record Modification

A `nats_client` field should be added to the sequencer's `t` record (line 226):

```
type t =
  { ledger : L.Db.t
  ; imt : Indexed_merkle_tree.Db.t
  ; ...
  ; da_client : Da_layer.Client.t
  ; nats_client : Nats_client.t option   (* NEW *)
  ; ...
  }
```

The `nats_client` is `option` — when `None`, NATS publishing is disabled (backwards-compatible).

---

## 4. Finality Event Publishing

The sequencer tracks three state levels:
- **Unproved** (`unprovedLedgerHash`) — latest applied state, updated on every transaction
- **Proved** (`provedLedgerHash`) — latest state with a completed ZK proof
- **Committed** (`committedLedgerHash`) — latest state committed to L1

### GraphQL `get_latest_state` Status

The `get_latest_state` function (line 273) currently returns `Field.zero` for `proved_ledger_hash` and `committed_ledger_hash` via GraphQL. This is a separate concern from NATS publishing — finality events are published directly at the transition points where the actual hash values are already available (see below). The GraphQL TODO does not block NATS finality event publishing.

See [addendums/addendum-finality-todo.md](./addendums/addendum-finality-todo.md) for how to resolve the GraphQL TODO if needed.

### Proving Pipeline (Where "Proved" State Advances)

The proving pipeline is a parallel merger tree:

1. `apply_user_command` produces witnesses → `Merger.P.add_job` adds them to the merger tree (line 509)
2. `run_committer` (line 744) runs on a timer (`commitment_period_sec`) → calls `commit` periodically
3. `commit` (line 682) closes the current merger tree and waits for all base proofs to complete
4. When all proofs are done, the merger produces a `Txn_snark.serializable` containing `source_ledger` and `target_ledger` hashes

**The "proved" transition** happens when `Merger.P.commit_exn` returns a `Some (stmt, _)` at line 751-757:

```ocaml
match%map ledger_applied >>| Or_error.ok_exn with
| Some (stmt, _) ->
    [%log info] "Committed: %s -> %s"
      (Ledger_hash.to_decimal_string stmt.source_ledger)
      (Ledger_hash.to_decimal_string stmt.target_ledger)
```

At this point, `stmt.target_ledger` is the proved ledger hash.

**NATS publish point for `zeko.l2.finality` (level: "proved"):** After `run_committer` logs "Committed: %s -> %s" (line 755-757), publish with `stmt.target_ledger` as the proved hash.

### Commitment Pipeline (Where "Committed" State Advances)

The commit flow continues from the merger output:

1. `Merger.Commit.process` (line 135) is called with the merger output and commit witness
2. `Committer.prove_commit` (line 174) creates the outer ZK proof
3. `Executor.send_zkapp_command` (line 182) sends the proof as a zkApp transaction to L1
4. On success, `State.Last_committed_ledger.set` (line 184) updates the committed ledger state

**The "committed" transition** happens at line 184 in `Merger.Commit.process`:

```ocaml
let%bind () =
  Executor.send_zkapp_command ~logger executor command
in
State.Last_committed_ledger.set sequencer_state ~data:new_inner_ledger ;
```

At this point, `new_inner_ledger`'s merkle root is the committed ledger hash.

**NATS publish point for `zeko.l2.finality` (level: "committed"):** After `State.Last_committed_ledger.set` at line 184, publish with `Sparse_ledger.merkle_root new_inner_ledger` as the committed hash.


---

## 5. Rollback Handling — Consumer Responsibility

### Investigation Finding: No Runtime Rollbacks in the Sequencer

After thorough investigation, the sequencer has **no runtime rollback mechanism**:

1. **Slot range validation is pre-emptive** (`apply_user_command`, lines 383-398) — transactions with invalid slot ranges are rejected before application, not rolled back after.
2. **Startup sync is forward-only** (`sync`, line 766) — the sequencer replays diffs from DA layer to reach L1-committed state. No reverting.
3. **L1 forks are not handled at runtime** — the sequencer trusts its L1 connection. If the L1 chain reorganizes, the sequencer does not detect or respond during operation.
4. **The archive relay's "fork detection"** is crash → `reset_ledger` → retry from checkpoint. Not a graceful rollback.
5. **Expired commit slots** (`Committer.recommit_all`, committer.ml line 237) cause a fatal crash requiring manual intervention.

Adding rollback events to the sequencer would require building the rollback mechanism itself first — not just publishing an event. See [addendums/addendum-sequencer-rollbacks.md](./addendums/addendum-sequencer-rollbacks.md) for the complexity analysis. This is not desirable.

### Design: Consumers Detect and Handle Rollbacks

**Rollback detection is the consumer's (TS indexer's) responsibility.** The indexer implements hash-chain-continuity checking on the NATS stream to detect both rollbacks and gaps.

**Detection algorithm:**
```
For each incoming message M[n]:
  if M[n].source_ledger_hash != M[n-1].target_ledger_hash:
    # Hash chain break detected — this is a rollback or gap
    if M[n].source_ledger_hash matches an earlier M[k].target_ledger_hash:
      # Fork: messages M[k+1]..M[n-1] were rolled back
      # Revert indexer state to M[k], reprocess from M[n]
    else:
      # Gap: missing messages between M[n-1] and M[n]
      # Trigger backfill from backfill API (see Section 7)
```

**On rollback detection:**
1. Identify the common ancestor (the last matching hash in the indexer's processed history)
2. Revert SurrealDB state for all transactions after the common ancestor
3. Continue processing from the new fork point

**On gap detection:**
1. Pause processing (stop consuming from NATS)
2. Call `backfill(fromHash: M[n-1].target, toHash: M[n].source)` mutation → get job ID
3. Subscribe to `backfillProgress(id)` via SSE. On drop → query `backfillJob(id)`, check `health { instanceId }`, re-subscribe or re-submit
4. On `completed` → resume processing. The gap is now filled in the NATS stream

**Data structures the indexer maintains:**
- `ledger_hash → NATS sequence number` mapping (in-memory hash map, rebuilt from SurrealDB on indexer restart) — enables O(1) common ancestor lookup
- Each SurrealDB transaction record is tagged with its `target_ledger_hash` — enables efficient revert by hash

**No `zeko.l2.rollbacks` subject is used.** The NATS stream contains only `zeko.l2.transactions`, `zeko.l2.finality`, and `zeko.health`. Rollback handling is purely an indexer concern.

---

## 6. NATS Event Schemas

### `zeko.l2.transactions`

One message per diff, published immediately after `Da_layer.Client.enqueue_diff`.

```json
{
  "source_ledger_hash": "<Ledger_hash as decimal string>",
  "target_ledger_hash": "<Ledger_hash as decimal string>",
  "timestamp": "<Block_time as int64 milliseconds>",
  "acc_set": "<Field element as decimal string>",
  "command": {
    "type": "signed_command | zkapp_command",
    "hash": "<transaction hash>",
    "sender": "<public_key base58>",
    "receiver": "<public_key base58>",
    "amount": "<nanomina as string>",
    "fee": "<nanomina as string>",
    "nonce": 5,
    "memo": "<memo string>",
    "account_updates": ["<account_update objects for zkapp commands>"]
  },
  "changed_accounts": [
    {
      "index": 42,
      "account": {
        "public_key": "<base58>",
        "balance": "<nanomina as string>",
        "nonce": 6,
        "delegate": "<base58>",
        "token_id": "<token_id string>",
        "zkapp_state": ["<field_element>", "..."],
        "permissions": {},
        "timing": {}
      }
    }
  ],
  "genesis": false
}
```

**Notes:**
- The payload is essentially `Da_layer.Diff.Stable.V3.to_yojson` output with `target_ledger_hash` and `genesis` added
- `command` is `null` for fee transfers and some genesis diffs (when `command_with_action_step_flags` is `None`)
- The `changed_accounts` array contains the **full post-state** of each affected account (not a delta)
- `acc_set` is a field element used by the Indexed Merkle Tree for account set tracking

**Header:** `Nats-Msg-Id: <target_ledger_hash>`

The `Nats-Msg-Id` header enables JetStream message deduplication. If the sequencer publishes the same diff twice (e.g., after a restart), JetStream will deduplicate based on this header within the deduplication window.

### `zeko.l2.finality`

Published when proved or committed state advances.

```json
{
  "ledger_hash": "<Ledger_hash as decimal string>",
  "level": "proved | committed",
  "source_ledger_hash": "<Ledger_hash as decimal string>",
  "timestamp": "<ISO 8601>"
}
```

**Header:** `Nats-Msg-Id: finality-<level>-<ledger_hash>`

**Publish points:**
- `proved`: After `run_committer` gets `Some (stmt, _)` — `stmt.target_ledger` is the proved hash, `stmt.source_ledger` is the source
- `committed`: After `State.Last_committed_ledger.set` in `Merger.Commit.process` — `Sparse_ledger.merkle_root new_inner_ledger` is the committed hash

### `zeko.health`

Periodic heartbeat from the sequencer's NATS publisher.

```json
{
  "service": "sequencer-nats-publisher",
  "last_published_hash": "<Ledger_hash as decimal string>",
  "last_published_at": "<ISO 8601>",
  "unproved_hash": "<Ledger_hash as decimal string>"
}
```

---

## 7. Catchup, Bootstrap, and Replayability Strategy

### The Core Problem: Non-Persistent Sequencer

The sequencer is **not persistent across restarts**. When it starts, it performs a full bootstrap:

1. Fetches the L1-committed ledger hash from the L1 chain (`Gql_client.infer_state`, line 769)
2. Replays **all** diffs from the DA layer to reach that state (`Da_layer.Client.map_diffs`, line 813)
3. Only then begins processing new transactions

This means:
- The sequencer does not remember what it published to NATS before a restart
- After restart, the sequencer resumes publishing from whatever transaction comes next — it does **not** re-publish historical diffs
- Any diffs that were applied while NATS was down are permanently missing from NATS unless backfilled

### Two Data Sources

The explorer pipeline has two complementary data paths:

1. **Real-time:** Sequencer → NATS (zero latency, primary path during normal operation)
2. **Historical/backfill:** DA layer → Backfill API → NATS (on-demand, for bootstrap and gap filling)

### Initial Bootstrap

On first startup, the sequencer already replays all diffs from DA layer in the `sync` function (line 813-887, `Da_layer.Client.map_diffs` callback). When `--nats-url` is provided, each diff is published to NATS as it is processed during this replay. This means:

- The sequencer's first startup with NATS populates the NATS stream with the full history
- No separate bootstrap step is needed
- The indexer starts consuming from NATS sequence 1 and processes all historical diffs seamlessly

After bootstrap, the sequencer transitions to real-time publishing for new transactions.

### Gap Detection

When the indexer detects a hash chain break (Section 5), it distinguishes between rollbacks and gaps:

- **Rollback:** `M[n].source_ledger_hash` matches an earlier known hash → revert (Section 5)
- **Gap:** `M[n].source_ledger_hash` is unknown → missing diffs, trigger backfill

On gap detection, the indexer:
1. Pauses consumption from NATS
2. Calls the `backfill(fromHash, toHash)` mutation → returns a job ID
3. Subscribes to `backfillProgress(id)` via SSE for real-time progress events
4. On `completed` event → resumes NATS consumption. On SSE drop or service restart → re-queries job via `backfillJob(id)`, re-subscribes or re-submits

### Backfill Service

A single-file standalone OCaml service that exposes a GraphQL API (mutation + subscription + query) to trigger backfill of missing diffs from the DA layer into NATS.

**File:** `src/app/zeko/backfill/backfill.ml` (~200 lines)

**Dependencies (all already in the zeko repo):**
- `da_layer` — `Da_layer.Client.iter_diffs`, `Da_layer.Diff.Stable.V3.to_yojson`
- `graphql`, `graphql-async`, `graphql_cohttp_async` — GraphQL server (same as sequencer)
- `cohttp-async` — HTTP server + SSE transport for subscriptions
- `nats_client` — NATS publish (same client as sequencer)
- `async`, `core_kernel`, `yojson`

**GraphQL schema:**

```graphql
type BackfillJob {
  id: String!
  status: BackfillStatus!
  fromHash: String!
  toHash: String!
  diffsPublished: Int!
  error: String
}

enum BackfillStatus {
  RUNNING
  COMPLETED
  FAILED
}

type BackfillProgress {
  id: String!
  status: BackfillStatus!
  diffsPublished: Int!
  error: String
}

type Query {
  backfillJob(id: String!): BackfillJob
  health: Health!
}

type Health {
  ok: Boolean!
  instanceId: String!
  startedAt: String!
}

type Mutation {
  backfill(fromHash: String!, toHash: String!): BackfillJob!
}

type Subscription {
  backfillProgress(id: String!): BackfillProgress!
}
```

**Key design points:**

- **`instanceId` in `health` query** — the service generates a random UUID at startup. The indexer stores this on first contact. If a subsequent `health` query returns a different `instanceId`, the service restarted and all in-flight jobs are lost. The indexer re-submits.
- **Job storage is in-memory** (`Hashtbl`). Jobs are short-lived. The `instanceId` mechanism handles restart recovery, so persistence is not needed.
- **SSE subscription transport** — `backfillProgress(id)` is delivered via Server-Sent Events (`Content-Type: text/event-stream`). The `cohttp-async` response body streams `data: {"status":"running","diffsPublished":42}\n\n` frames as the job progresses. No WebSocket dependency.
- **Subscription pushes on every diff published** (or batched every N diffs for high-volume ranges) and a final `completed` or `failed` event.

**Robustness — indexer-side failure handling:**

| Failure | Detection | Recovery |
|---|---|---|
| **SSE connection drops** (network blip, TCP reset) | `EventSource` `error` event or stream ends unexpectedly | Query `backfillJob(id)` to get current status. If still `RUNNING`, re-subscribe. If `COMPLETED`/`FAILED`, act on result. |
| **Backfill service restarts** mid-job | `health { instanceId }` changes, or `backfillJob(id)` returns `null` | Re-submit `backfill(fromHash, toHash)` mutation. JetStream dedup prevents duplicate messages for any diffs already published before the restart. |
| **Backfill job fails** (DA layer error, NATS error) | `BackfillProgress` event with `status: FAILED` and `error` message | Log the error. Retry the `backfill` mutation with the same hash range (up to N retries with backoff). |
| **Backfill service unreachable** | HTTP connection refused / timeout | Retry with exponential backoff. The indexer remains paused (not consuming from NATS) until backfill succeeds. |

**CLI flags:**

| Flag | Type | Description |
|---|---|---|
| `--nats-url` | `string` | NATS server URL |
| `--da-node` | `string list` | DA layer node URIs (same as archive relay) |
| `-p` | `int` | HTTP/GraphQL listen port (default: 8090) |

**Deployment:** Standalone service, one instance per network. Same isolation as sequencer + NATS.

**How the indexer uses it:**

```typescript
// On gap detection: M[n-1].target_hash != M[n].source_hash
// and M[n].source_hash is unknown (not a rollback)

async function runBackfill(fromHash: string, toHash: string): Promise<void> {
  // 1. Check service identity (for restart detection later)
  const { data: { health } } = await gqlClient.query({
    query: gql`query { health { instanceId } }`
  });
  const instanceId = health.instanceId;

  // 2. Start backfill
  const { data: { backfill: job } } = await gqlClient.mutate({
    mutation: gql`mutation Backfill($from: String!, $to: String!) {
      backfill(fromHash: $from, toHash: $to) { id status }
    }`,
    variables: { from: fromHash, to: toHash },
  });

  // 3. Subscribe to progress via SSE
  await new Promise<void>((resolve, reject) => {
    const es = new EventSource(
      `${BACKFILL_URL}/graphql/stream?query=${encodeURIComponent(
        `subscription { backfillProgress(id: "${job.id}") { status diffsPublished error } }`
      )}`
    );

    es.onmessage = (event) => {
      const progress = JSON.parse(event.data);
      if (progress.status === "COMPLETED") { es.close(); resolve(); }
      if (progress.status === "FAILED") { es.close(); reject(new Error(progress.error)); }
    };

    es.onerror = async () => {
      es.close();
      // SSE dropped — check if service restarted or job still running
      try {
        const { data: { health: h } } = await gqlClient.query({
          query: gql`query { health { instanceId } }`
        });
        if (h.instanceId !== instanceId) {
          // Service restarted — re-submit from scratch
          reject(new BackfillServiceRestarted());
          return;
        }
        const { data: { backfillJob } } = await gqlClient.query({
          query: gql`query Job($id: String!) {
            backfillJob(id: $id) { status diffsPublished error }
          }`,
          variables: { id: job.id },
        });
        if (!backfillJob) { reject(new BackfillServiceRestarted()); return; }
        if (backfillJob.status === "COMPLETED") { resolve(); return; }
        if (backfillJob.status === "FAILED") { reject(new Error(backfillJob.error)); return; }
        // Still running — re-subscribe (recursive, with the same job ID)
        // In practice, wrap this in a retry loop
        reject(new BackfillSSEDropped());
      } catch {
        reject(new BackfillServiceUnreachable());
      }
    };
  });
}

// Top-level retry loop
const MAX_RETRIES = 5;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    await runBackfill(lastKnownHash, nextMessage.sourceHash);
    break; // success — resume NATS consumption
  } catch (e) {
    if (e instanceof BackfillServiceRestarted || e instanceof BackfillSSEDropped) {
      await sleep(1000 * 2 ** attempt); // exponential backoff
      continue; // re-submit
    }
    if (e instanceof BackfillServiceUnreachable) {
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    throw e; // unknown error — surface to operator
  }
}
```

### Operational Flows

```
First start (empty NATS stream):
  1. Sequencer starts with --nats-url
  2. sync() replays all DA diffs → published to NATS during replay
  3. NATS stream now has full history
  4. Indexer starts, consumes from sequence 1, builds SurrealDB

Sequencer restart (existing NATS stream):
  1. Sequencer restarts, sync() replays DA diffs internally
  2. sync() diffs are also published to NATS (deduplication handles overlaps)
  3. Gap between pre-restart and post-restart:
     → Indexer detects via hash chain break
     → Indexer calls backfill API for the gap range
     → Backfill service fills the gap from DA layer
     → Indexer resumes

Indexer restart:
  1. Indexer resumes from durable NATS consumer position
  2. No backfill needed — NATS has the history
  3. SurrealDB state consistent up to last processed message

Full SurrealDB rebuild:
  1. Delete SurrealDB
  2. Reset indexer's NATS consumer to sequence 1
  3. Indexer replays entire NATS stream
  4. If NATS stream is incomplete, indexer triggers backfill for gaps
```

### NATS JetStream Configuration

```
Stream: zeko-l2
  Subjects: zeko.l2.>
  Retention: Limits
  Storage: File
  Max Messages: -1 (unlimited)
  Max Bytes: -1 (unlimited)
  Max Age: 90d (3 months — configurable, 1-6 months depending on network volume)
  Discard: Old
  Dedup Window: 2m

Stream: zeko-health
  Subjects: zeko.health
  Retention: Limits
  Storage: File
  Max Messages: 1000
  Discard: Old
```

### R2 Archival and Stream Pruning

JetStream retains a rolling window (default 3 months). Older messages are archived to Cloudflare R2 before pruning.

**Archival flow:**

```
NATS JetStream (rolling 3 months)
        │
        ├── cron job exports messages older than (max_age - 1 week)
        │   to R2 as NDJSON files, partitioned by day
        │
        └── JetStream Max Age auto-prunes expired messages
```

**R2 storage layout:**
```
r2://zeko-nats-archive/
  zeko.l2.transactions/
    2026-01-15.ndjson.zst   # zstd-compressed, one JSON message per line
    2026-01-16.ndjson.zst
    ...
  zeko.l2.finality/
    2026-01-15.ndjson.zst
    ...
```

**Archival strategy:**
- A cron job (or scheduled task) reads from NATS using an archival consumer, exports messages to R2 as daily NDJSON files compressed with zstd
- Each line includes the original NATS headers (sequence number, timestamp, `Nats-Msg-Id`) so the archive is replayable
- The archival consumer runs ahead of the `Max Age` window to ensure no messages are pruned before archival
- R2 lifecycle rules can be used for long-term retention tiers (e.g., move to Infrequent Access after 1 year)

**Full rebuild from archive:**
1. Replay R2 archive files into NATS (or directly into the backfill service)
2. JetStream deduplication prevents duplicates if there's overlap with the live stream
3. Indexer replays from sequence 1 as usual

**Configuration:**
- `Max Age` on the `zeko-l2` stream controls the JetStream retention window (default: 90 days)
- Archival frequency: daily
- R2 bucket: one per network (devnet, testnet, mainnet)

---

## 8. Sequencer CLI Changes

### New Flag

| Flag | Type | Default | Description |
|---|---|---|---|
| `--nats-url` | `string option` | `None` | NATS server URL. If not provided, NATS publishing is disabled. |

**Example usage:**
```bash
# NATS enabled
zeko-sequencer --nats-url nats://localhost:4222 [other flags...]

# NATS disabled (default, backwards-compatible)
zeko-sequencer [other flags...]
```

### Behavior

- When `--nats-url` is not provided: NATS client is `None`, all publish calls are no-ops, sequencer behaves exactly as before
- When `--nats-url` is provided: NATS client connects at startup, publishes diffs after each `enqueue_diff` call
- If NATS connection drops during operation: publishes are silently dropped, sequencer continues normally, client reconnects automatically
- The archive relay continues running unchanged — NATS publishing is additive, not a replacement

---

## 9. Test Scenarios

See [test-scenarios/](./test-scenarios/) for all Gherkin acceptance test scenarios:

| File | Coverage |
|---|---|
| `transaction-publishing.feature` | User commands, zkApp commands, fee transfers, genesis diffs, hash chain continuity |
| `deduplication.feature` | JetStream Nats-Msg-Id deduplication |
| `nats-downtime.feature` | Sequencer continues when NATS is down, reconnection, disabled mode |
| `finality-events.feature` | Proved and committed finality event publishing |
| `health-heartbeat.feature` | Periodic health heartbeat messages |
| `consumer-rollback-detection.feature` | Indexer hash chain break detection, rollback vs gap disambiguation, revert logic |
| `backfill.feature` | Backfill API gap filling, full bootstrap, deduplication, progress tracking, error handling |

---

## 10. Open Questions

**None.** All questions from the original spike have been resolved:

| Original Question | Resolution |
|---|---|
| Module vs. microservice? | Neither — the sequencer publishes directly to NATS. No separate process. |
| Crash recovery and resume? | Sequencer publishes historical diffs during startup sync. Backfill API service fills gaps on demand. Indexer detects gaps via hash chain continuity. See Section 7. |
| Rollback signaling? | No runtime rollback mechanism exists in the sequencer (and adding one is not desirable). Consumers detect rollbacks via hash-chain-continuity checking. See Section 5. |

### Addendum Documents

- [addendums/addendum-sync-performance.md](./addendums/addendum-sync-performance.md) — How the new architecture eliminates the week-long archive sync bottleneck (1M+ transactions), with estimates and further optimizations (parallel DA fetching, pre-seeded NATS streams)
- [addendums/addendum-finality-todo.md](./addendums/addendum-finality-todo.md) — How to resolve the `get_latest_state` GraphQL TODO for proved/committed hashes (~20 LOC)
- [addendums/addendum-sequencer-rollbacks.md](./addendums/addendum-sequencer-rollbacks.md) — Analysis of why adding rollback events to the sequencer is not desirable (complexity vs. benefit)
