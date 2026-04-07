# Addendum: Resolving the `get_latest_state` TODO

## Context

The `get_latest_state` function in `zeko_sequencer.ml` (line 273) currently returns `Field.zero` for `proved_ledger_hash` and `committed_ledger_hash`:

```ocaml
let get_latest_state t =
  (* TODO: proved hashes *)
  State_hashes.
    { proved_ledger_hash = Field.zero
    ; unproved_ledger_hash = get_root t
    ; committed_ledger_hash = Field.zero
    }
```

This TODO is **not blocking** for NATS finality event publishing. The finality events are published at the exact transition points where the actual hash values are already available:
- **Proved:** `stmt.target_ledger` at `run_committer` line 755
- **Committed:** `Sparse_ledger.merkle_root new_inner_ledger` at `Merger.Commit.process` line 184

The TODO only affects the GraphQL `stateHashes` query. If correct proved/committed values should also be returned via GraphQL (and used in health heartbeats), this addendum describes the implementation.

## Implementation

### 1. Add State Singletons

Two new KVDB singletons in `State` module (after line 58):

```ocaml
module Last_proved_ledger_hash = Kvdb_base.Make_singleton (struct
  type t = Ledger_hash.t [@@deriving yojson]
  let key = "last_proved_ledger_hash"
end)

module Last_committed_ledger_hash = Kvdb_base.Make_singleton (struct
  type t = Ledger_hash.t [@@deriving yojson]
  let key = "last_committed_ledger_hash"
end)
```

### 2. Set Proved Hash in `run_committer`

At line 755, after the "Committed" log:

```ocaml
| Some (stmt, _) ->
    [%log info] "Committed: %s -> %s"
      (Ledger_hash.to_decimal_string stmt.source_ledger)
      (Ledger_hash.to_decimal_string stmt.target_ledger) ;
    State.Last_proved_ledger_hash.set t.state ~data:stmt.target_ledger
```

### 3. Set Committed Hash in `Merger.Commit.process`

At line 184, the committed ledger hash is already tracked via `State.Last_committed_ledger` (a `Sparse_ledger.t`). Extract the merkle root:

```ocaml
State.Last_committed_ledger.set sequencer_state ~data:new_inner_ledger ;
State.Last_committed_ledger_hash.set sequencer_state
  ~data:(Sparse_ledger.merkle_root new_inner_ledger)
```

### 4. Update `get_latest_state`

```ocaml
let get_latest_state t =
  State_hashes.
    { proved_ledger_hash =
        State.Last_proved_ledger_hash.get t.state
        |> Option.value ~default:Field.zero
    ; unproved_ledger_hash = get_root t
    ; committed_ledger_hash =
        State.Last_committed_ledger_hash.get t.state
        |> Option.value ~default:Field.zero
    }
```

### 5. Initialize on Sync

In the `sync` function (line 766), after `State.Last_committed_ledger.set t.state ~data:sparse_ledger` (line 904):

```ocaml
State.Last_committed_ledger_hash.set t.state
  ~data:(Sparse_ledger.merkle_root sparse_ledger)
```

The proved hash starts at `Field.zero` until the first proof completes — this is correct behavior since no proofs exist at sync time.

## Complexity

~20 lines of OCaml across 2 files. No new dependencies. No schema changes. The KVDB singletons are persisted to the same RocksDB instance as other state.

## Dependencies

None. This can be implemented independently of NATS publishing.
