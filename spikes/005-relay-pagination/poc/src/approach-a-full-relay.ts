/**
 * Approach A — Full Relay: Node interface + global IDs + Connections.
 *
 * Models what GitHub / Shopify / Blockscout do.
 */
import SchemaBuilder from "@pothos/core"
import RelayPlugin, { resolveCursorConnection, encodeGlobalID, decodeGlobalID } from "@pothos/plugin-relay"
import {
  type BridgeOp,
  compareOps,
  encodeCursor,
  decodeCursor,
  compareCursorAgainstOp,
  makeOps,
} from "./fixtures.js"

type Pothos = {
  Context: { ops: BridgeOp[] }
  Scalars: { ID: { Input: string; Output: string } }
}

const builder = new SchemaBuilder<Pothos>({
  plugins: [RelayPlugin],
  relay: {
    clientMutationId: "omit",
    cursorType: "String",
  },
})

builder.queryType({})

const BridgeOperationType = builder.enumType("BridgeOperationType", {
  values: ["DEPOSIT", "WITHDRAWAL"] as const,
})

const BridgeOperationStatus = builder.enumType("BridgeOperationStatus", {
  values: ["SUBMITTED", "L1_WITNESSED", "COMMITTED", "COMPLETED"] as const,
})

const BridgeOpRef = builder.node(builder.objectRef<BridgeOp>("BridgeOperation"), {
  // In production, `Node.id` is the row's ULID primary key (the SurrealDB record ID).
  // The fixture has no ULID column, so the POC synthesises one from `(aux, auxSequence)`
  // — using a `|` separator so the existing `_` in aux strings like "aux_alpha" doesn't collide.
  id: { resolve: (op) => `${op.aux}|${op.auxSequence}` },
  loadOne: (id, { ops }) => {
    const sep = id.lastIndexOf("|")
    const aux = id.slice(0, sep)
    const seq = id.slice(sep + 1)
    return ops.find((o) => o.aux === aux && String(o.auxSequence) === seq) ?? null
  },
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

builder.queryField("bridgeOperations", (t) =>
  t.connection({
    type: BridgeOpRef,
    args: {
      publicKey: t.arg.string({ required: true }),
    },
    resolve: (_root, args, { ops }) =>
      resolveCursorConnection<BridgeOp[]>(
        {
          args,
          toCursor: (op) => encodeCursor(op),
        },
        ({ before, after, limit, inverted }) => {
          let filtered = ops
            .filter((o) => o.sender === args.publicKey || o.recipient === args.publicKey)
            .sort(compareOps)

          if (after) {
            const c = decodeCursor(after)
            filtered = filtered.filter((o) => compareCursorAgainstOp(c, o) < 0)
          }
          if (before) {
            const c = decodeCursor(before)
            filtered = filtered.filter((o) => compareCursorAgainstOp(c, o) > 0)
          }
          if (inverted) filtered = filtered.reverse()
          return filtered.slice(0, limit)
        }
      ),
  })
)

export const schemaA = builder.toSchema()
export const fixturesA = { makeOps, encodeGlobalID, decodeGlobalID }
