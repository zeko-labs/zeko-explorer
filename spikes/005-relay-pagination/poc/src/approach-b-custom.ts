/**
 * Approach B — Custom flat lists, no Relay, no Node.
 *
 * Models what Mina daemon, Mina archive node, the existing zeko-ui actions API,
 * and the Mina archive node all do.
 */
import SchemaBuilder from "@pothos/core"
import {
  type BridgeOp,
  compareOps,
  encodeCursor,
  decodeCursor,
  compareCursorAgainstOp,
  makeOps,
} from "./fixtures.js"

type Pothos = { Context: { ops: BridgeOp[] } }

const builder = new SchemaBuilder<Pothos>({})

builder.queryType({})

const BridgeOperationType = builder.enumType("BridgeOperationType", {
  values: ["DEPOSIT", "WITHDRAWAL"] as const,
})

const BridgeOperationStatus = builder.enumType("BridgeOperationStatus", {
  values: ["SUBMITTED", "L1_WITNESSED", "COMMITTED", "COMPLETED"] as const,
})

const BridgeOpRef = builder.objectRef<BridgeOp>("BridgeOperation").implement({
  fields: (t) => ({
    aux: t.exposeString("aux", { nullable: false }),
    auxSequence: t.exposeInt("auxSequence", { nullable: false }),
    type: t.field({ type: BridgeOperationType, nullable: false, resolve: (o) => o.type }),
    status: t.field({ type: BridgeOperationStatus, nullable: false, resolve: (o) => o.status }),
    sender: t.exposeString("sender", { nullable: false }),
    recipient: t.exposeString("recipient", { nullable: false }),
    amount: t.exposeString("amount", { nullable: false }),
    submitBlockHeight: t.exposeInt("submitBlockHeight", { nullable: false }),
  }),
})

const BridgeOperationsPage = builder
  .objectRef<{ items: BridgeOp[]; nextCursor: string | null; hasMore: boolean }>(
    "BridgeOperationsPage"
  )
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
    args: {
      publicKey: t.arg.string({ required: true }),
      limit: t.arg.int({ required: false }),
      after: t.arg.string({ required: false }),
    },
    resolve: (_root, args, { ops }) => {
      const limit = Math.min(args.limit ?? 20, 100)
      let filtered = ops
        .filter((o) => o.sender === args.publicKey || o.recipient === args.publicKey)
        .sort(compareOps)
      if (args.after) {
        const c = decodeCursor(args.after)
        filtered = filtered.filter((o) => compareCursorAgainstOp(c, o) < 0)
      }
      const slice = filtered.slice(0, limit + 1)
      const hasMore = slice.length > limit
      const items = slice.slice(0, limit)
      return {
        items,
        hasMore,
        nextCursor: hasMore ? encodeCursor(items[items.length - 1]!) : null,
      }
    },
  })
)

export const schemaB = builder.toSchema()
export const fixturesB = { makeOps }
