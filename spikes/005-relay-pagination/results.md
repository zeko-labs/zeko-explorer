# Spike 005: Cursor-Based Pagination Schema — Results

**Status:** Complete
**Date:** 2026-05-07

---

## 1. Context

The Explorer, Bridge, and Contract Registry GraphQL APIs need cursor-based pagination for all open-ended list queries (transactions, accounts, events, actions, bridge operations). Pothos has built-in Relay Connection support via `@pothos/plugin-relay`. The choice is binary:

- **Approach A — Full Relay.** `Node` interface, global IDs, `Connection` / `Edge` / `PageInfo` wrappers, the full Relay arg set (`first` / `after` / `last` / `before`).
- **Approach B — Custom flat.** A `{ items, nextCursor, hasMore }` page wrapper, natural identifiers, `limit` / `after` only, no Relay plugin.

A "hybrid" shape (Connection types without `Node`) is not under evaluation — §10.1 documents why no production API ships it.

This spike works each shape end-to-end against in-memory fixtures, surveys what the surrounding Mina/Zeko ecosystem already does, evaluates the performance impact of each shape, isolates what Relay's plugin enables that a custom shape cannot, and weighs the answer against the project's downstream milestones.

Working code lives in [`./poc/`](./poc/): two Pothos schemas, generated `.graphql` SDL files, and a runner with 23 strict-typed assertions.

---

## 2. Who consumes these APIs (Q1, Q2)

| Consumer | Client library | Pagination needs |
|---|---|---|
| **MCP code-mode agents** (Milestone 1, 4) | A typed SDK generated from the federated schema (`gql.tada` matches the existing zeko-ui pattern). Sandboxed JS. | Multi-step agent workflows benefit from polymorphic refetch (`node(id:)` returns any object across types). With per-type lookups, the agent must remember the type of each saved ID and route refetches accordingly. |
| **Bridge UI** (production today) | `@urql/vue`. | Needs a normalized cache with stable row identity. urql graphcache uses `__typename + id` by default — Relay `Node.id` lands in this slot for free; a custom shape requires per-type `keyFields` configuration. |
| **Explorer frontend** (Milestone 2) | Nuxt 3 SPA + `@urql/vue`. | Same as the bridge UI. Long-lived browsing sessions with subscription updates over SSE — see §6.4. |
| **Public API third parties** (Milestone 4) | Unknown clients. PRD §9.4 lists rate limiting, API key auth, and a documentation portal as the hardening surface. | Whichever shape we choose must be approachable for any GraphQL client. Connection-shaped APIs are the convention third-party tooling (codegen, IDE plugins, GraphiQL, Hasura) expects first. |

**Q2 — does the explorer frontend use Apollo Client?** No. zeko-ui standardizes on `@urql/vue`, and spike 004 keeps that choice. But urql's normalized cache (`@urql/exchange-graphcache`) shares the same `__typename + id` identity model as Apollo Client's `InMemoryCache` — both treat `Node.id` as the default cache key. Apollo's `relayStylePagination` does not apply directly, but the cache-identity benefits of `Node` apply to urql too.

---

## 3. Two approaches, side by side

For each approach: a worked Pothos sketch (the actual file in [`./poc/src/`](./poc/src/), trimmed for prose), the SDL it produces, source LOC, and SDL LOC.

The fixture is a list of 50 bridge operations (5 distinct `aux` strings, FIFO `auxSequence`, three pubkeys), sorted `(submit_block_height DESC, submit_timestamp DESC, aux ASC, aux_sequence ASC)`. The shared `compareOps` / `encodeCursor` / `decodeCursor` utilities live in [`./poc/src/fixtures.ts`](./poc/src/fixtures.ts).

### 3.1 Global identity strategy

Every indexed row is assigned a ULID primary key at insert time. ULID is time-ordered, URL-safe, and 16 bytes binary (26 chars Crockford base32). It serves three purposes simultaneously:

- **SurrealDB record ID**: `bridge_operation:01HYZ...`. The primary B-tree key.
- **`Node.id` for Approach A**: the global ID is the ULID directly — no base64 wrapping, no synthetic `Type:key` encoding.
- **Stable cache key for clients**: `__typename + id` is the default normalized-cache identity in both Apollo and urql graphcache.

Natural keys (`tx_hash`, `(aux, auxSequence)`, `public_key`) remain queryable via dedicated root fields (`transaction(hash:)`, `bridgeOperation(aux:, auxSequence:)`, `account(publicKey:)`). The two coexist: ULID is the cache/refetch handle, natural keys are the human-addressable lookups. This is the same pattern GitHub uses (`node(id:)` for refetch, `repository(owner:, name:)` for human lookup).

The POC uses `${aux}|${auxSequence}` as a synthetic global ID because the in-memory fixture predates the ULID column. In production, the global ID is the row's ULID.

### 3.2 Approach A — Full Relay (Node + global IDs + Connections)

**Pothos sketch** (full file: [`./poc/src/approach-a-full-relay.ts`](./poc/src/approach-a-full-relay.ts)):

```ts
const builder = new SchemaBuilder<Pothos>({
  plugins: [RelayPlugin],
  relay: { clientMutationId: "omit", cursorType: "String" },
})

const BridgeOpRef = builder.node(builder.objectRef<BridgeOp>("BridgeOperation"), {
  id: { resolve: (op) => op.uuid },                              // production: ULID
  loadOne: (id, { db }) => db.bridgeOperationByUuid(id),         // record-ID lookup
  fields: (t) => ({ aux: t.exposeString("aux", { nullable: false }), /* ...etc */ }),
})

builder.queryField("bridgeOperations", (t) =>
  t.connection({
    type: BridgeOpRef,
    args: { publicKey: t.arg.string({ required: true }) },
    resolve: (_root, args, { ops }) =>
      resolveCursorConnection<BridgeOp[]>(
        { args, toCursor: (op) => encodeCursor(op) },
        ({ before, after, limit, inverted }) =>
          keysetSlice(ops, args.publicKey, { before, after, limit, inverted }),
      ),
  })
)
```

**Generated SDL** (full output: [`./poc/schema-a-full-relay.graphql`](./poc/schema-a-full-relay.graphql)):

```graphql
interface Node { id: ID! }

type BridgeOperation implements Node {
  id: ID!                      # the ULID record key
  aux: String!
  auxSequence: Int!
  # ...
}

type QueryBridgeOperationsConnection {
  edges: [QueryBridgeOperationsConnectionEdge]
  pageInfo: PageInfo!
}

type QueryBridgeOperationsConnectionEdge { cursor: String!  node: BridgeOperation }

type PageInfo {
  hasNextPage: Boolean!  hasPreviousPage: Boolean!
  startCursor: String    endCursor: String
}

type Query {
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
  bridgeOperations(after: String, before: String, first: Int, last: Int, publicKey: String!): QueryBridgeOperationsConnection
}
```

**LOC:** 95 source, 50 SDL lines (47 non-blank).

### 3.3 Approach B — Custom flat (no Relay plugin)

**Pothos sketch** (full file: [`./poc/src/approach-b-custom.ts`](./poc/src/approach-b-custom.ts)):

```ts
const builder = new SchemaBuilder<Pothos>({})              // no plugins

const BridgeOpRef = builder.objectRef<BridgeOp>("BridgeOperation").implement({
  fields: (t) => ({ aux: t.exposeString("aux", { nullable: false }), /* ...etc */ }),
})

const BridgeOperationsPage = builder
  .objectRef<{ items: BridgeOp[]; nextCursor: string | null; hasMore: boolean }>("BridgeOperationsPage")
  .implement({
    fields: (t) => ({
      items: t.expose("items", { type: [BridgeOpRef], nullable: false }),
      nextCursor: t.exposeString("nextCursor", { nullable: true }),
      hasMore: t.exposeBoolean("hasMore", { nullable: false }),
    }),
  })

builder.queryField("bridgeOperations", (t) =>
  t.field({
    type: BridgeOperationsPage,
    args: { publicKey: t.arg.string({ required: true }), limit: t.arg.int(), after: t.arg.string() },
    resolve: (_root, args, { ops }) => {
      const limit = Math.min(args.limit ?? 20, 100)
      const filtered = filterAndSort(ops, args.publicKey, args.after)
      const slice = filtered.slice(0, limit + 1)
      const hasMore = slice.length > limit
      const items = slice.slice(0, limit)
      return { items, hasMore, nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null }
    },
  })
)
```

**Generated SDL** (full output: [`./poc/schema-b-custom.graphql`](./poc/schema-b-custom.graphql)):

```graphql
type BridgeOperation {
  aux: String!
  auxSequence: Int!
  # ...
}

type BridgeOperationsPage {
  items: [BridgeOperation!]!
  nextCursor: String
  hasMore: Boolean!
}

type Query {
  bridgeOperations(after: String, limit: Int, publicKey: String!): BridgeOperationsPage
}
```

**LOC:** 86 source, 32 SDL lines (28 non-blank).

### 3.4 Behavioral parity

The runner ([`./poc/run.ts`](./poc/run.ts)) issues `bridgeOperations(publicKey: PK, first/limit: 5)` against both schemas and asserts that the returned `(aux, auxSequence)` tuples are identical and in identical order. They are. Whichever shape is chosen, the underlying ordering and cursor semantics are the same.

### 3.5 Summary table

| | Approach A (full Relay) | Approach B (custom flat) |
|---|---|---|
| Source LOC (non-blank, non-comment) | 95 | 86 |
| SDL non-blank lines | 47 | 28 |
| Pothos plugin needed | `@pothos/plugin-relay` | none |
| Polymorphic refetch via `node(id:)` | yes | no (per-type root queries) |
| Default normalized-cache identity (urql, Apollo) | `__typename + Node.id` (free) | requires per-type `keyFields` config |
| Forward pagination (`first` / `limit` + `after`) | yes | yes |
| Backward pagination (`last` + `before`) | yes (built-in) | needs explicit add (non-breaking) |
| Federation: `@shareable PageInfo` directive | required | n/a |
| Production-API references | GitHub, Shopify, Blockscout | Stripe, Linear, Mina, Zeko |

---

## 4. Pothos cursor pagination without the Relay plugin (Q3)

Approach B answers this question. The recipe used in [`./poc/src/approach-b-custom.ts`](./poc/src/approach-b-custom.ts):

1. Define a generic page wrapper type via `builder.objectRef<...>("...Page").implement(...)`. Its `items` field is the underlying object ref typed as `[Ref!]!`; its `nextCursor` is nullable; its `hasMore` is non-null.
2. Define query fields with `t.field({ type: ThePageRef, args: { limit, after, ... }, resolve: ... })`.
3. The resolver implements keyset pagination directly: read `limit + 1` rows, slice off the overflow, encode the last kept row's sort tuple as `nextCursor`, set `hasMore = overflowed`.
4. Cursor encode/decode is a 10-line utility shared across resolvers (§5.4).

There is no Relay plugin and no Pothos-side boilerplate beyond the page wrapper. A `definePage(builder, ref, name)` helper would collapse the per-type cost to one line per list query.

---

## 5. SurrealDB cursor strategy (Q4)

### 5.1 Two cursor regimes

The cursor strategy depends on what the rows are sorted by:

- **Domain-ordered queries** (transactions by `(blockHeight, txIndex)`, bridge ops by `(submit_block_height, submit_timestamp, aux, aux_sequence)`, events by `(blockHeight, txIndex, eventIndex)`): cursors encode the values of the sort tuple. Keyset SELECTs run against a composite index on those columns.
- **Ingestion-ordered queries** (audit logs, raw event streams, anything that wants newest-first by ingestion time): cursors are the row's ULID directly. SurrealDB's record-ID range query (`SELECT * FROM table:start..end`) walks the primary B-tree without an index lookup — the fastest path the database offers.

Both regimes are shape-agnostic — Approach A and Approach B can each use either.

### 5.2 Sort tuple per query

Each cursor encodes the values of the sort tuple for a single row. The sort tuple ends in a strictly-unique tie-breaker so the keyset comparison is well-defined.

| Query | Sort tuple | Tie-breaker |
|---|---|---|
| `transactions` (global, account) | `(blockHeight DESC, txIndex DESC)` | `txIndex` is unique within block |
| `bridgeOperations(publicKey)` | `(submit_block_height DESC, submit_timestamp DESC, aux ASC, aux_sequence ASC)` | `(aux, aux_sequence)` (per spike 002 §7) |
| `zkappEvents(account)` / `zkappActions(account)` | `(blockHeight DESC, txIndex DESC, eventIndex DESC)` | `eventIndex` is unique within tx |
| `batches` | `(blockHeight DESC)` | one batch per block |
| `outerActions` / `innerActions` | range-bounded by `(beforeState, afterState)` | no cursor — see §7 |

### 5.3 SurrealQL keyset query template

For a `(blockHeight DESC, txIndex DESC)` sort:

```sql
SELECT * FROM transaction
WHERE
  account = $account                                   -- optional filter
  AND (
    blockHeight < $cursor_blockHeight
    OR (blockHeight = $cursor_blockHeight AND txIndex < $cursor_txIndex)
  )
ORDER BY blockHeight DESC, txIndex DESC
LIMIT $limit_plus_one;
```

`$cursor_blockHeight` and `$cursor_txIndex` come from decoding the `after` cursor. `$limit_plus_one` is `limit + 1` so the resolver computes `hasMore` from row count > limit. On the first page (`after = null`), the cursor predicate is omitted.

The composite index `(blockHeight DESC, txIndex DESC)` keeps the predicate seek-bounded. Each query has an index on its sort tuple — for `bridge_operation` this is the index already specified in spike 002 §7.

### 5.4 Cursor encoding

Cursors are opaque to clients. The wire format is base64-url JSON with a 1-byte version prefix, so the encoding can evolve without a schema break.

```ts
function encodeCursor(o: BridgeOp): string {
  const body = JSON.stringify({ bh: o.submitBlockHeight, ts: o.submitTimestamp, aux: o.aux, seq: o.auxSequence })
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(body, "utf8")]).toString("base64url")
}

function decodeCursor(s: string): { bh: number; ts: string; aux: string; seq: number } {
  const buf = Buffer.from(s, "base64url")
  if (buf[0] !== 0x01) throw new Error("Unknown cursor version")
  return JSON.parse(buf.subarray(1).toString("utf8"))
}
```

Implemented in [`./poc/src/fixtures.ts`](./poc/src/fixtures.ts) and exercised by the runner against both schemas.

The cursor JSON shape varies per query:

| Query | Cursor JSON shape (before base64) |
|---|---|
| `transactions` | `{"bh":12345,"ti":5}` |
| `bridgeOperations` | `{"bh":12345,"ts":"2026-05-07T12:34:56Z","aux":"...","seq":2}` |
| `zkappEvents` | `{"bh":12345,"ti":5,"ei":2}` |

### 5.5 Resolver structure

```ts
async function listForUser(args: ListBridgeOpsArgs) {
  const cursor = args.after ? decodeCursor(args.after) : null
  const rows = await db.query(KEYSET_QUERY, { ...args, cursor, limit: args.limit + 1 })
  const hasMore = rows.length > args.limit
  const items = rows.slice(0, args.limit)
  return { items, hasMore, nextCursor: hasMore ? encodeCursor(toCursor(items.at(-1)!)) : null }
}
```

For Approach A, the same resolver wraps in `resolveCursorConnection`, which converts the array to `edges` and synthesizes `pageInfo`. The keyset query underneath is identical.

---

## 6. Performance impact

The DB layer is shape-agnostic — the same SurrealQL keyset query underlies each approach, so DB cost is identical for the dominant case. The differences live in four layers above the DB.

### 6.1 Database

- **Domain-ordered queries**: both approaches issue identical keyset SELECTs against indexed sort columns. Cost: O(log n) index seek + O(limit) row fetch via index → main-table indirection. **Equal.**
- **Ingestion-ordered queries** (when the cursor is the row's ULID): `SELECT * FROM table:start..end LIMIT 20` walks the primary B-tree directly. Roughly 1.5–2× faster than the secondary-index path because the indirection step disappears. **Available to both A and B equally** — the DB optimization is independent of GraphQL shape.

### 6.2 Wire size

For a 20-row page of typical 250-byte rows on `bridgeOperations`:

| | Per-row overhead | Per-page overhead | 20-row total |
|---|---|---|---|
| **A** | `id: ID!` (~26 B ULID) + `cursor: String!` (~50 B) + edge wrapper (~20 B) ≈ 96 B | `pageInfo` (~150 B) | ~6950 B |
| **B** | none (just the row data) | `nextCursor` (~50 B) + `hasMore` (~15 B) | ~5065 B |

A is ~37% heavier pre-gzip. After gzip, ULIDs share their time-prefix and cursors share encoding overhead, so the residual gap collapses to ~5–10%. Material at scale on a byte-rate-limited public API (Milestone 4); invisible at typical browsing rates.

### 6.3 Resolver overhead

A allocates ~21 wrapper objects per page (one edge per row + one pageInfo). B allocates one. ~1 KB of additional JS heap per request for A. Trivial.

### 6.4 Client-side cache identity

Both `@urql/exchange-graphcache` and Apollo Client's `InMemoryCache` normalize rows by `__typename + id` by default. Approach A lands in this slot for free: every paginated row already exposes `id: ID!`, and the cache's internal map is keyed by it.

Approach B requires per-type `keyFields` configuration:

```ts
// urql graphcache config — one entry per type, kept in sync with the schema
keys: {
  BridgeOperation: (op) => `${op.aux}|${op.auxSequence}`,
  Transaction: (tx) => tx.hash,
  Account: (a) => a.publicKey,
  // ...etc, ~10 types
}
```

This works, but it's per-type configuration the frontend maintains in sync with the API schema. Adding a new paginated type to the API requires touching the cache config too.

### 6.5 Subscription patching

The explorer fans out SurrealDB live queries to clients via SSE. When a row's status changes (e.g., `submitted → completed`), the subscription emits a delta.

- **A**: emit `{ id: <ulid>, status: COMPLETED }`. The cache looks up the row by `Node.id` in its normalized map and patches `status` in O(1). Works the same in Apollo and urql graphcache without any schema-shape-specific configuration.
- **B**: emit `{ aux, auxSequence, status }`. The cache patch goes through the configured `keyFields` resolver — O(1) if configured (§6.4), or O(N) scan across cached pages if not. Possible, but requires the per-type config to be present and correct.

### 6.6 Net

- **DB**: equal.
- **Wire**: B is ~5–10% lighter post-gzip — a small public-API consideration.
- **Resolver overhead**: equal.
- **Cache identity**: A is the default-on path; B works but requires per-type frontend config.
- **Subscription patching**: A is the default-on path; B works with the same per-type config.

The performance differences are real but small. None dominate the choice. The recurring theme is that A inherits the `Node.id` identity convention that both major GraphQL clients normalize against by default, while B works equivalently if the frontend maintains a parallel configuration.

---

## 7. Backward pagination needed? (Q5)

A block explorer is read-bottom-up (newest first). The natural user gesture is "load more older entries", which is forward pagination. Stripe, Linear, the Mina daemon, the zeko-ui actions API, and zeko-bridge-sdk all ship forward-only pagination. Etherscan-style explorers do too — their UI reads "page 1, 2, 3..." but the underlying API is forward-only with cursors.

There is no use case across Milestones 1–4 (transaction history, account activity, bridge op list, zkApp events/actions, settlement batches, ethereum-side equivalents) where a user starts at "row N" and pages backward. Live updates land at the front of the list via subscriptions, not via backward pagination.

**Conclusion: forward only in v1.** Approach A inherits the full Relay arg set from `t.connection`; resolvers reject `last`/`before` until a use case demands it. Approach B exposes `limit` + `after` only.

---

## 8. Future-milestone considerations

The recommendation has to survive the next four milestones, not just the first.

**Milestone 1 — MCP Server + GraphQL APIs + Indexing Substrate.** The MCP server is the first consumer of these schemas, via a typed SDK. Multi-step agent workflows commonly save an ID from one query, navigate to an unrelated query, then refetch the original object to compose results. With Approach A, the agent saves the global ID and refetches with `node(id:)` — one query, type-agnostic. With Approach B, the agent must remember each saved ID's type and route to the correct typed root field — workable, but the agent's tool harness is the one paying the type-routing cost. **Tilts toward A.**

**Milestone 2 — Explorer Frontend (Nuxt 3 SPA, urql, SSE).** urql graphcache normalizes by `__typename + id` by default. Approach A's `Node.id` is the convention; Approach B works equivalently with per-type `keyFields` config (§6.4). Both work. SSE subscription patches favor A by default (§6.5). **Mild tilt toward A.**

**Milestone 3 — Settlement Finality, L1 Rollback.** Adds the `_meta` freshness envelope on query responses. Pagination is independent of this concern; the freshness envelope wraps both shapes equally. **Neutral.**

**Milestone 4 — Ethereum Support + Public API hardening.** This is the milestone where third-party consumers come into scope. Two populations to consider:

- **Mina-ecosystem-native consumers** (wallet integrators, indexer operators, MCP-driven analytics on Mina archive nodes): familiar with the flat-list shape from the Mina daemon and zeko-bridge-sdk. Either shape is consumable; B is one fewer learning step.
- **General GraphQL consumers** (developers approaching the API through the public documentation portal, codegen tooling, GraphiQL): the Connection convention is what their tools default to. Apollo Client `relayStylePagination()` is a one-liner for A; B requires a custom merge field policy. IDE tooling, schema introspection viewers, and the major learning resources all default to Connection shapes. **Tilts toward A.**

The PRD's Milestone 4 deliverable list (rate limiting, API key auth, documentation portal) implies a public API positioned for general GraphQL consumers, not exclusively Mina-native ones. The cost of the convention deviation is paid by every third-party developer; the cost of the convention adoption is paid once by us.

**Net across milestones: A is preferred or neutral at every step. The strongest signal is M4's broader public-API positioning.**

---

## 9. Surrounding ecosystem

The four GraphQL surfaces this project sits next to all use flat lists, never Connection types. This is a data point worth recording, but it does not deicde the recommendation — see §10.

- **Mina daemon**: paginates blocks via `bestChain(maxLength: Int): [Block!]`. No `first`, no `after`, no Connection types. The Mina daemon's GraphQL was written before Pothos and modern Relay tooling matured; it is path-of-least-resistance for that era, not a deliberate convention choice.
- **Zeko sequencer**: a fork of the Mina daemon schema with extra Zeko-specific fields. Same shape, same lack of Connection types.
- **zeko-ui actions API** (`services/actions/api/src/schema/outer.ts`): Pothos without the Relay plugin. `outerActions(input: ...): [OuterAction!]!`, `outerWitnessesFromAuxes(input: ...): [OuterWitness!]!`. Built quickly to ship the bridge UI; the existing federated subgraph the explorer will sit alongside.
- **zeko-bridge-sdk** (`src/queries.ts`): range-bounded inputs, flat list outputs. Apollo Client client-side, no `relayStylePagination`. The canonical SDK that wallets use to talk to Mina archive nodes.

### 9.1 Production references for each shape

| Shape | Production references |
|---|---|
| **Full Relay** (Node + Connections) | GitHub API v4, Shopify Admin, Blockscout |
| **Custom flat** `{items, nextCursor, hasMore}` | Stripe, Slack (cursor-based), Linear, Mina daemon, Zeko sequencer, zeko-ui actions API, zeko-bridge-sdk |

### 9.2 Federation across heterogeneous subgraphs

The Hive gateway composes types across subgraphs; pagination shape is per-field, not per-gateway. The existing zeko-ui actions API stays flat (existing code, not in scope to rewrite); a new explorer subgraph can adopt Connection types without conflict. The gateway exposes both shapes side-by-side under one endpoint. `@shareable PageInfo` is a one-line directive on the explorer subgraph — not a compositional burden.

### 9.3 Client support

Both wire shapes are first-class in the clients we use. Neither shape is structurally blocked by any client.

| Client | Relay Connection support | Custom flat support |
|---|---|---|
| **urql** (`@urql/exchange-graphcache`) | `cursorPagination` for Connections; `Node.id` is the default cache key | `simplePagination` merges `{items, nextCursor}` shapes; per-type `keyFields` required for normalized identity |
| **Apollo Client** | `relayStylePagination()` helper | Custom `merge` field policy; per-type `keyFields` required |
| **gql.tada** (used by zeko-ui) | Shape-agnostic | Shape-agnostic |

---

## 10. Recommendation

**Adopt Approach A — full Relay (Connection types + `Node` interface) — across all three GraphQL APIs.** Use natural-key root queries (`transaction(hash:)`, `bridgeOperation(aux:, auxSequence:)`, `account(publicKey:)`) alongside `node(id:)` for refetch. Every indexed row carries a ULID primary key that serves as both the SurrealDB record ID and the GraphQL `Node.id`.

The decision rests on five observations:

1. **Once ULID is the DB primary key, the structural objection to Approach A dissolves.** The global ID is the database record key, not a synthetic base64 wrapper around natural keys. Natural keys remain queryable via dedicated root fields. The two coexist cleanly — same pattern GitHub uses (`node(id:)` for refetch, typed root queries for human lookup).

2. **`Node.id` is the default normalized-cache identity in both Apollo and urql graphcache.** Approach A inherits client-side row identity, subscription patching, and Apollo `relayStylePagination` for free (§6.4, §6.5). Approach B works equivalently but requires per-type `keyFields` configuration the frontend maintains in sync with the API schema. The cost of Approach A's convention is paid once at the API; the cost of Approach B's deviation is paid at every client integration.

3. **The public API in Milestone 4 must be approachable for the broader GraphQL ecosystem.** Connection types are what every modern GraphQL client, IDE plugin, codegen tool, and learning resource defaults to. Adopting the convention removes a learning step for every third-party developer; the alternative pays that cost N times across the consumer population (§8).

4. **Performance differences are small and net roughly neutral.** Approach B saves ~5–10% post-gzip wire size; Approach A inherits cache identity and subscription patching for free. Neither dominates (§6).

5. **The Pothos plugin handles edge cases the custom shape would re-derive.** Cursor inversion under `last` / `before`, edge nullability, `pageInfo` synthesis, federation `@shareable PageInfo` directives — all are plugin-managed in A. A custom shape re-implements each per query if the same capabilities are ever needed.

The `Node`-interface complaint that drove earlier Mina-ecosystem GraphQL APIs toward flat lists no longer applies once the database commits to ULID record IDs. The Mina daemon's flat-list convention is a legacy of pre-modern-Relay tooling; the explorer is a new API and is not bound to inherit it. Heterogeneous subgraph styles compose under the Hive gateway without conflict — the existing zeko-ui actions API stays flat, the explorer adopts Connection types, both work behind one endpoint (§9.2).

Approach B is rejected because its only structural advantage — single-level access path — is offset by per-type cache configuration and a wider gap to the convention third-party tooling expects. Its ecosystem-alignment argument (matches the Mina daemon shape) does not outweigh M4's broader public-API positioning.

### 10.1 Why no "hybrid" middle was considered

A "hybrid" shape would adopt Connection wrappers (`edges`, `node`, `pageInfo`) without adopting `Node` and global IDs. Documentation surveys of GitHub, Shopify, Stripe, Linear, Slack, Blockscout, Mina, and Zeko found zero production adopters. The shape exists in `@pothos/plugin-relay` (`builder.connectionObject`) but has no real-world deployment. Adopting an unvalidated shape adds the worst of both options: the verbosity of Relay's edge wrappers without the cache-identity payoff that comes from `Node`. Not worth considering.

---

## 11. Project-wide conventions (proposed)

Across the Explorer, Bridge, and Contract Registry APIs:

1. **Every indexed row carries a ULID primary key**, assigned at insert time by the indexer. SurrealDB record IDs use this ULID directly (`bridge_operation:01HYZ...`); the GraphQL `Node.id` is the same ULID.
2. **Two query shapes, picked by the data:**
   - **Range-bounded reads** (action witnesses, block ranges, event windows): `someThing(input: { from?, to?, max? }): [SomeThing!]!`. Flat list, range-bounded args. Matches the existing zeko-ui actions API convention 1:1.
   - **Open-ended cursor reads** (transactions, bridge op history, zkApp events): `someThing(filter…, first: Int = 20, after: String): SomeThingConnection`. Returns the standard Relay shape (`edges`, `node`, `pageInfo`).
3. **Every paginated type implements `Node`.** `id: ID!` is the row's ULID. The schema exposes `node(id: ID!): Node` as the polymorphic refetch root.
4. **Single-row lookups also use natural keys.** `transaction(hash: String!)`, `account(publicKey: String!)`, `bridgeOperation(aux: String!, auxSequence: Int!)`. Natural-key lookups and `node(id:)` coexist.
5. **Pagination args.** `first: Int = 20, after: String`. Server clamps `first` to 100. `last`/`before` are accepted by the schema (free with `t.connection`) but resolvers reject them until a use case demands it (§7).
6. **Cursors are opaque.** Version-prefixed base64-JSON of the keyset sort tuple. Clients MUST round-trip unchanged.
7. **`PageInfo` is shareable across federated subgraphs** via the `@shareable` directive.
8. **Subscriptions emit single nodes**, not pages. SurrealDB live queries push deltas keyed by `Node.id`; the client cache patches in place via its `__typename + id` index.
9. **`totalCount` is opt-in per field** when a use case justifies it; not a default convention.

Pothos `t.connection` keeps the per-type cost constant — no project-local helper is required.

---

## 12. Edge cases

### 12.1 Aux collision and FIFO sequence

Per spike 002, `(aux, aux_sequence)` is the composite key for `bridge_operation` because `aux` is a Poseidon hash that is not unique. The `bridgeOperations` cursor encodes both fields. The POC fixture simulates this (50 ops across 5 aux strings, FIFO sequence) and the parity test confirms ordering matches across both approaches.

### 12.2 Rollback during pagination

A consumer mid-pagination may request `after = X` for a row that was rolled back since the previous page. The keyset predicate skips the missing row (the cursor encodes the sort key, not the row identity). The client sees a smaller-than-expected last page, which is fine.

If a row's status changes between pages (e.g. `submitted → completed`), the row appears in any subsequent listing under its current status. Pagination is unaffected because the sort key is `submit_block_height` / `submit_timestamp`, not `status`. The subscription channel emits a `{id, status}` delta; clients with the row in cache patch in place (§6.5).

### 12.3 Cursor across schema migrations

The 1-byte version prefix in the cursor encoding lets a v1 decoder remain in service while the resolver emits v2 cursors. The resolver tries the current decoder first and falls back for older bytes during the transition window.

### 12.4 Federation (Hive gateway)

`PageInfo` is the federation-shareable type — a one-line `@shareable` directive on the subgraph schema. Each subgraph's connection types are subgraph-private; the `Node` interface is also subgraph-scoped (each subgraph implements `node(id:)` over its own types).

### 12.5 SSE freshness

The `_meta` freshness envelope sits on every query response, including paginated ones. Pagination cursors are unaffected by freshness.

### 12.6 `totalCount`

A precise count needs a full `COUNT(*)` query — expensive on growing tables, rarely useful in a block explorer. Omitted from v1; added per-field when a UI element justifies it.

---

## 13. Deliverables checklist

| Deliverable from `README.md` | Where it lives |
|---|---|
| Schema examples for both approaches | §3.2, §3.3 (worked SDL) + [`./poc/schema-a-full-relay.graphql`](./poc/schema-a-full-relay.graphql), [`./poc/schema-b-custom.graphql`](./poc/schema-b-custom.graphql) (full SDL output) |
| Pothos implementation sketch per approach | §3.2, §3.3 + [`./poc/src/`](./poc/src/) (working code) |
| SurrealDB cursor strategy | §5 |
| Pagination capability and performance analysis | §6 |
| Recommendation with justification | §10 (with milestone context in §8) |

| Question from `README.md` | Answer | Section |
|---|---|---|
| Q1. Who are the primary API consumers? Which shape is most ergonomic? | MCP agents, bridge UI, explorer frontend (urql / gql.tada). Public API consumers in M4. Approach A is the default-on path for normalized cache identity and polymorphic refetch. | §2, §8 |
| Q2. Does the explorer frontend use Apollo Client? | No — `@urql/vue`. urql graphcache uses the same `__typename + id` cache identity as Apollo, so `Node.id` benefits transfer. | §2 |
| Q3. How does Pothos handle cursor-based pagination without the Relay plugin? | A page wrapper via `objectRef.implement` plus a resolver that reads `limit + 1` and computes `hasMore`. ~10 lines per list query. Documented for completeness; not the recommended path. | §4 |
| Q4. How are SurrealDB cursors implemented? | Opaque base64-url JSON of the keyset sort tuple, with a 1-byte version prefix. Sort tuples per query, ending in a strictly-unique tie-breaker. ULID primary keys enable record-ID range queries for ingestion-ordered cursors. | §5 |
| Q5. Is backward pagination needed? | No across Milestones 1–4. Forward only in v1; the schema accepts the full Relay arg set, but resolvers reject `last`/`before` until needed. | §7 |

---

## 14. References

- **Working POC**: [`./poc/`](./poc/) — two Pothos schemas + 23 strict-typed assertions (`pnpm test`) + generated SDL files (`pnpm sdl`).
- Mina daemon schema (`zeko/graphql_schema.json`): the Mina/Zeko-shared GraphQL surface — flat lists, `bestChain(maxLength:)`-style pagination.
- zeko-ui actions API (`zeko-ui/services/actions/api/src/schema/outer.ts`): existing federated subgraph the explorer composes alongside.
- zeko-bridge-sdk (`zeko-bridge-sdk/src/queries.ts`): canonical wallet SDK for Mina archive node action queries.
- [Pothos Relay Plugin](https://pothos-graphql.dev/docs/plugins/relay) — `t.connection`, `resolveCursorConnection`, `builder.node`.
- [GraphQL Cursor Connections Specification (Relay)](https://relay.dev/graphql/connections.htm).
- [Apollo Federation: Relay-Style Connections](https://www.apollographql.com/docs/graphos/schema-design/guides/relay-style-connections) — `PageInfo` is the federation-shareable type.
- [urql graphcache pagination](https://commerce.nearform.com/open-source/urql/docs/graphcache/local-resolvers/#pagination).
- [Apollo Client cursor-based pagination](https://www.apollographql.com/docs/react/pagination/cursor-based).
- [SurrealDB SELECT (LIMIT/START/ORDER BY)](https://surrealdb.com/docs/surrealql/statements/select).
- [SurrealDB Record IDs](https://surrealdb.com/docs/surrealql/datamodel/ids).
- [ULID — Sortable Unique Identifiers (arXiv:2509.08969)](https://arxiv.org/pdf/2509.08969).
- `spikes/002-bridge-correlation/results.md` §7 — `bridge_operation` SurrealDB schema and indexes.
- `spikes/004-deployment-topology.md` — federation gateway placement.
