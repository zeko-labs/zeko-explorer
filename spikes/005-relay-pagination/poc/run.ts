/**
 * Plain Node test runner — sidesteps vitest's dual-module-realm issue with graphql.
 * Run with: pnpm tsx run.ts
 */
import { type ExecutionResult, type GraphQLSchema, graphql, printSchema } from "graphql"
import { schemaA } from "./src/approach-a-full-relay.js"
import { schemaB } from "./src/approach-b-custom.js"
import { type BridgeOp, makeOps } from "./src/fixtures.js"

const PK = "B62qkAa7tBtCKf3WP7zjvPxQRBz3UTFkMLaA8hUQVgHpkeFL7CsLvwa"

type BridgeOperationView = Pick<BridgeOp, "aux" | "auxSequence">

type RelayConnection = {
  edges: Array<{ cursor: string; node: BridgeOperationView & { id?: string } }>
  pageInfo: { hasNextPage: boolean; hasPreviousPage?: boolean; endCursor: string | null; startCursor?: string | null }
}

type CustomPage = {
  items: BridgeOperationView[]
  hasMore: boolean
  nextCursor: string | null
}

type NodeRefetch = {
  node: { __typename: string; aux: string; auxSequence: number } | null
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function run<T>(schema: GraphQLSchema, query: string): Promise<ExecutionResult<T>> {
  return (await graphql({ schema, source: query, contextValue: { ops: makeOps() } })) as ExecutionResult<T>
}

// =================================================================
console.log("\n=== Approach A: full Relay (Node + globalID + Connections) ===")
const sdlA = printSchema(schemaA)
check("SDL has interface Node", /interface Node/.test(sdlA))
check("SDL has node(id: ID!): Node", /node\(id: ID!\): Node/.test(sdlA))
check("SDL has nodes(ids: [ID!]!): [Node]!", /nodes\(ids: \[ID!\]!\): \[Node\]!/.test(sdlA))
check("BridgeOperation implements Node", /type BridgeOperation implements Node/.test(sdlA))
check("BridgeOperation has id: ID!", /\bid: ID!/.test(sdlA))

const aPage1 = await run<{ bridgeOperations: RelayConnection }>(
  schemaA,
  `query { bridgeOperations(publicKey: "${PK}", first: 3) {
    edges { cursor node { id aux auxSequence } }
    pageInfo { hasNextPage endCursor }
  } }`
)
check("forward pagination has no errors", !aPage1.errors, JSON.stringify(aPage1.errors))
const aConn = aPage1.data?.bridgeOperations
check("first=3 returns 3 edges", aConn?.edges.length === 3)
check("pageInfo.hasNextPage = true", aConn?.pageInfo.hasNextPage === true)
const aId = aConn?.edges[0]?.node.id
check("global ID is base64url", typeof aId === "string" && /^[A-Za-z0-9+/=_-]+$/.test(aId))
const aDecoded = aId ? Buffer.from(aId, "base64").toString("utf8") : ""
check("decoded ID begins with 'BridgeOperation:'", /^BridgeOperation:/.test(aDecoded), aDecoded)

// Refetch via Node interface
const aRefetch = await run<NodeRefetch>(
  schemaA,
  `query { node(id: "${aId}") { __typename ... on BridgeOperation { aux auxSequence } } }`
)
const refetched = aRefetch.data?.node
check("refetch via node(id) returns BridgeOperation", refetched?.__typename === "BridgeOperation")
check("refetched aux matches original", refetched?.aux === aConn?.edges[0]?.node.aux)

// =================================================================
console.log("\n=== Approach B: custom flat {items, nextCursor, hasMore} ===")
const sdlB = printSchema(schemaB)
check("SDL has NO interface Node", !/interface Node/.test(sdlB))
check("SDL has NO node(id: ID!) query", !/\bnode\(id: ID!\)/.test(sdlB))
check("SDL has NO PageInfo type", !/type PageInfo/.test(sdlB))
check("SDL has NO 'edges:' field", !/\bedges: /.test(sdlB))

const bP1 = await run<{ bridgeOperations: CustomPage }>(
  schemaB,
  `query { bridgeOperations(publicKey: "${PK}", limit: 3) {
    items { aux auxSequence } hasMore nextCursor
  } }`
)
check("forward pagination has no errors", !bP1.errors, JSON.stringify(bP1.errors))
const bP1d = bP1.data?.bridgeOperations
check("limit=3 returns 3 items", bP1d?.items.length === 3)
check("hasMore = true", bP1d?.hasMore === true)
check("nextCursor present", typeof bP1d?.nextCursor === "string" && bP1d.nextCursor.length > 0)

const bP2 = await run<{ bridgeOperations: CustomPage }>(
  schemaB,
  `query { bridgeOperations(publicKey: "${PK}", limit: 3, after: "${bP1d?.nextCursor}") {
    items { aux auxSequence } hasMore
  } }`
)
const bP2d = bP2.data?.bridgeOperations
check("page 2 returns 3 items", bP2d?.items.length === 3)
const bK1 = bP1d?.items.map((o) => `${o.aux}_${o.auxSequence}`) ?? []
const bK2 = bP2d?.items.map((o) => `${o.aux}_${o.auxSequence}`) ?? []
check("no overlap between page 1 and page 2", bK1.filter((k) => bK2.includes(k)).length === 0)

// =================================================================
console.log("\n=== Behavioral parity: A and B return the same data in the same order ===")
const ra = await run<{ bridgeOperations: RelayConnection }>(
  schemaA,
  `query { bridgeOperations(publicKey: "${PK}", first: 5) { edges { node { aux auxSequence } } } }`
)
const rb = await run<{ bridgeOperations: CustomPage }>(
  schemaB,
  `query { bridgeOperations(publicKey: "${PK}", limit: 5) { items { aux auxSequence } } }`
)
const a = ra.data?.bridgeOperations.edges.map((e) => `${e.node.aux}_${e.node.auxSequence}`) ?? []
const b = rb.data?.bridgeOperations.items.map((o) => `${o.aux}_${o.auxSequence}`) ?? []
check("A == B (ordering)", JSON.stringify(a) === JSON.stringify(b), `\n    A=${JSON.stringify(a)}\n    B=${JSON.stringify(b)}`)

// =================================================================
console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log("\nFailures:")
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
process.exit(0)
