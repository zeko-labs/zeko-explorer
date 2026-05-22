# Spike 005: Cursor-Based Pagination Schema — Relay Spec Tradeoffs

**Status:** Not started
**Blocking:** Milestone 1 (GraphQL API design)
**Owner:** TBD

---

## Context

The Explorer and Bridge GraphQL APIs need cursor-based pagination for all list queries (transactions, accounts, events, actions, bridge operations). Cursor-based pagination is chosen over offset-based because the data grows continuously — new blocks arrive while users page through results, causing offset-based pagination to produce duplicates or skip items.

**Pothos** (the GraphQL schema builder) has built-in support for the Relay Connection specification via its Relay plugin. The question is whether to adopt the full Relay spec or use a simpler cursor-based approach.

---

## What is the Relay Connection Spec?

The [Relay Connection Specification](https://relay.dev/graphql/connections.htm) defines a standard way to express paginated relationships in GraphQL:

```graphql
type TransactionConnection {
  edges: [TransactionEdge!]!
  pageInfo: PageInfo!
}

type TransactionEdge {
  cursor: String!
  node: Transaction!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

It also defines the `Node` interface (`node(id: ID!)` root query for refetching any object by global ID).

---

## Tradeoffs to Evaluate

### Full Relay Spec

**Pros:**
- Industry standard for GraphQL pagination. Well-understood by GraphQL clients.
- Pothos Relay plugin handles most of the boilerplate.
- Global `node(id)` query useful for caching (e.g., Apollo Client normalized cache).
- Forward and backward pagination built-in.
- `edges` wrapper allows per-edge metadata (e.g., cursor, relationship metadata).

**Cons:**
- Verbose — `edges { node { ... } }` nesting for every list query.
- Global ID encoding (base64 `Type:id`) can be confusing in a block explorer context where users expect raw hashes.
- The `Node` interface requires every type to implement `id: ID!` — may conflict with natural identifiers (tx hash, public key).
- MCP/agent consumers may find the nesting awkward compared to flat arrays.
- Backward pagination (`last`/`before`) is rarely useful in a block explorer.

### Cursor-Based Without Full Relay

**Pros:**
- Simpler schema — flat arrays with `pageInfo` appended.
- No global ID encoding — natural identifiers (hashes, public keys) used directly.
- Easier for MCP/agent consumers.
- Still get stable cursor-based pagination semantics.

**Cons:**
- No standard — each API defines its own pagination shape.
- Pothos Relay plugin less useful (may need custom implementation).
- Apollo Client normalized cache doesn't work out of the box without `Node` interface.
- Forward/backward pagination needs manual implementation.

### Hybrid

- Use Relay Connection types (`edges`/`pageInfo`) for the pagination wrapper but skip the global `Node` interface and ID encoding. Natural identifiers everywhere.

---

## Questions to Answer

1. **Who are the primary API consumers?** MCP agents (code-first), bridge UI, explorer frontend. Which pagination shape is most ergonomic for each?
2. **Does the explorer frontend use Apollo Client?** If so, the normalized cache benefits of Relay connections may be significant.
3. **How does Pothos handle cursor-based pagination without the Relay plugin?** Is there a clean, low-boilerplate path?
4. **For SurrealDB queries**, how are cursors implemented? Opaque base64-encoded sort keys? Timestamp + ID composites?
5. **Is backward pagination needed?** In a block explorer, users typically paginate forward through time-ordered lists.

---

## Deliverables

1. **Schema examples** for all three approaches (full Relay, custom cursor, hybrid) applied to a representative query (e.g., `transactions` list).
2. **Pothos implementation sketch** for each approach — lines of code, boilerplate, ergonomics.
3. **SurrealDB cursor strategy** — how cursors map to SurrealDB query parameters.
4. **Recommendation** with justification based on consumer ergonomics and implementation cost.

---

## References

- [Relay Connection Specification](https://relay.dev/graphql/connections.htm)
- [Pothos Relay Plugin](https://pothos-graphql.dev/docs/plugins/relay)
- [Pothos Cursor-Based Pagination (without Relay)](https://pothos-graphql.dev/docs/guide/args)
- SurrealDB pagination / range queries documentation
