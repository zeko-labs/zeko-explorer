# @zeko/zeko-indexer

Unified Zeko indexer runtime projection logic.

This package consumes the shared NATS event contracts and materializes the runtime rows defined by `docs/PRD.html`, `docs/spikes/`, and the database schema. Those documents are the source of truth for this implementation.

## Runtime Shape

The package exposes a small public surface through `src/public.ts`:

- `createZekoIndexer` consumes typed envelopes into an `IndexerStore`.
- `createIndexerRuntime` wires envelope sources, projection flushing, and shutdown.
- `createSurrealClient` uses the official SurrealDB JavaScript SDK for production writes.
- `consumeNatsEnvelopes` reads JetStream messages and converts them to shared envelopes.

`src/index.ts` is the development entrypoint and should stay the target for the package dev command.

## Projection Domains

- `src/indexer.ts` handles envelope parsing and core account, transaction, batch, zkApp event, and zkApp action projection.
- `src/da.ts` owns data-availability attestation transitions, signer quorum handling, and pending attestation reconciliation.
- `src/bridge.ts` owns bridge projection from L1 events, L1 outer actions, and L2 inner actions.
- `src/bridge-status.ts` contains the bridge lifecycle transition rules as pure functions.
- `src/adapters/nats.ts` and `src/adapters/surreal.ts` are runtime adapters. The SurrealDB adapter uses the SDK; generated statements are SurrealQL strings.

The implementation is intentionally functional at the domain boundaries: event consumers mutate the store as the projection context, while lifecycle and precedence rules live in small pure helpers.

## Testing

Tests use `vitest-cucumber` with feature files under `tests/features`.

Important coverage areas:

- `tests/core-indexer.test.ts` covers core projection, rollback, batch linkage, data availability, zkApp events/actions, and deterministic replay behavior.
- `tests/bridge-indexer.test.ts` covers bridge lifecycle projection, rollback, timeouts, finalization, and action correlation.
- `tests/surreal-adapter.test.ts` covers SurrealQL statement generation and projection removals.
- `tests/nats-adapter.test.ts` covers JetStream envelope consumption.
- `tests/runtime.test.ts` covers runtime configuration, flush sequencing, cancellation, and SDK adapter wiring.
- `tests/runtime-integration.test.ts` verifies the runtime against real NATS and SurrealDB when enabled.

Useful commands:

```sh
moon run zeko-indexer:typecheck
moon run zeko-indexer:test
ZEKO_INDEXER_RUN_RUNTIME_INTEGRATION=1 moon run zeko-indexer:test -- --run tests/runtime-integration.test.ts
moon ci
```

## Local Runtime

Runtime configuration is resolved from environment variables:

- `ZEKO_INDEXER_NATS_SERVERS`
- `ZEKO_INDEXER_NATS_DURABLE_NAME`
- `ZEKO_INDEXER_NATS_NEXT_EXPIRES_MS`
- `ZEKO_INDEXER_NATS_REPLAY_FROM_START`
- `ZEKO_INDEXER_STREAMS`
- `ZEKO_INDEXER_SURREAL_ENDPOINT`
- `ZEKO_INDEXER_SURREAL_NAMESPACE`
- `ZEKO_INDEXER_SURREAL_DATABASE`
- `ZEKO_INDEXER_SURREAL_USERNAME`
- `ZEKO_INDEXER_SURREAL_PASSWORD`
- `ZEKO_INDEXER_DA_AUTHORIZED_SIGNERS`
- `ZEKO_INDEXER_DA_QUORUM`
- `ZEKO_INDEXER_BRIDGE_INNER_ACTION_PUBLIC_KEYS`
- `ZEKO_INDEXER_BRIDGE_WITHDRAWAL_DELAY_SLOTS`

The runtime consumes all configured streams concurrently and serializes projection flushes so SurrealDB writes remain deterministic relative to processed envelopes.
