/**
 * Shared in-memory fixture: 50 bridge operations representing a realistic
 * mix of deposits/withdrawals, with `aux` collisions handled via auxSequence
 * (the spike-002 design). Fixed seed so tests are deterministic.
 */
export type BridgeOp = {
  aux: string
  auxSequence: number
  type: "DEPOSIT" | "WITHDRAWAL"
  status: "SUBMITTED" | "L1_WITNESSED" | "COMMITTED" | "COMPLETED"
  sender: string
  recipient: string
  amount: string
  submitBlockHeight: number
  submitTimestamp: string
}

const PUBKEYS = [
  "B62qkAa7tBtCKf3WP7zjvPxQRBz3UTFkMLaA8hUQVgHpkeFL7CsLvwa",
  "B62qiAR2TdPe1V4ouTajT9YLN5Q1byuV6h74L24KEDF1uRhYgnq6BHN",
  "B62qmoNwHdxvZqtHgkAmxRHpJgdeNu8dNaRfgw7VQ2Fk8aN7BNJsTEn",
]

const AUXES = ["aux_alpha", "aux_beta", "aux_gamma", "aux_delta", "aux_epsilon"]

export function makeOps(): BridgeOp[] {
  const ops: BridgeOp[] = []
  let auxCounters = new Map<string, number>()
  for (let i = 0; i < 50; i++) {
    const aux = AUXES[i % AUXES.length]!
    const auxSequence = (auxCounters.get(aux) ?? 0)
    auxCounters.set(aux, auxSequence + 1)
    ops.push({
      aux,
      auxSequence,
      type: i % 3 === 0 ? "WITHDRAWAL" : "DEPOSIT",
      status: (["SUBMITTED", "L1_WITNESSED", "COMMITTED", "COMPLETED"] as const)[i % 4]!,
      sender: PUBKEYS[i % PUBKEYS.length]!,
      recipient: PUBKEYS[(i + 1) % PUBKEYS.length]!,
      amount: String(BigInt(1_000_000) * BigInt(i + 1)),
      submitBlockHeight: 1_000_000 - i,
      submitTimestamp: new Date(Date.UTC(2026, 4, 7, 12, 0, 0) - i * 60_000).toISOString(),
    })
  }
  return ops
}

/**
 * Sort tuple for keyset pagination, matching what the SurrealDB schema indexes
 * (per spike 002 §7): (submitBlockHeight DESC, submitTimestamp DESC, aux ASC, auxSequence ASC).
 */
export function sortKey(o: BridgeOp): [number, string, string, number] {
  return [-o.submitBlockHeight, "z" + (1e15 - new Date(o.submitTimestamp).getTime()), o.aux, o.auxSequence]
}

export function compareOps(a: BridgeOp, b: BridgeOp): number {
  const ka = sortKey(a), kb = sortKey(b)
  for (let i = 0; i < ka.length; i++) {
    const va = ka[i]!, vb = kb[i]!
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

/** Serialize the cursor tuple as base64 with a 1-byte version prefix. */
export function encodeCursor(o: BridgeOp): string {
  const body = JSON.stringify({
    bh: o.submitBlockHeight,
    ts: o.submitTimestamp,
    aux: o.aux,
    seq: o.auxSequence,
  })
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(body, "utf8")]).toString("base64url")
}

export function decodeCursor(s: string): { bh: number; ts: string; aux: string; seq: number } {
  const buf = Buffer.from(s, "base64url")
  if (buf[0] !== 0x01) throw new Error("Unknown cursor version")
  return JSON.parse(buf.subarray(1).toString("utf8"))
}

export function compareCursorAgainstOp(c: ReturnType<typeof decodeCursor>, o: BridgeOp): number {
  // Returns -1 if cursor < op (op comes after), +1 if cursor > op, 0 if equal.
  // Uses the same ordering as `compareOps` so we can do keyset filtering.
  const fakeOp: BridgeOp = {
    aux: c.aux,
    auxSequence: c.seq,
    type: "DEPOSIT",
    status: "SUBMITTED",
    sender: "",
    recipient: "",
    amount: "0",
    submitBlockHeight: c.bh,
    submitTimestamp: c.ts,
  }
  return compareOps(fakeOp, o)
}
