import { describe, expect, it } from "vitest";

import { applyFinality, applySettlement, emptyDaStatusState } from "./da-status";

describe("DA status baseline derivation", () => {
  it("buffers proved finality until the matching batch exists", () => {
    const state = applyFinality(emptyDaStatusState, {
      network: "zeko-m-local",
      level: "proved",
      ledgerHash: "target-1",
      timestamp: "2026-05-13T00:00:00.000Z",
    });

    expect(state.pending.get("target-1")).toMatchObject({
      ledgerHash: "target-1",
      source: "proved",
    });
  });

  it("marks a settlement-created batch as attested and clears pending", () => {
    const withPending = applyFinality(emptyDaStatusState, {
      network: "zeko-m-local",
      level: "proved",
      ledgerHash: "target-1",
      timestamp: "2026-05-13T00:00:00.000Z",
    });

    const settled = applySettlement(withPending, {
      network: "zeko-m-local",
      targetLedgerHash: "target-1",
      l1TransactionHash: "tx-1",
      blockHeight: 42,
      confirmations: 290,
      timestamp: "2026-05-13T00:01:00.000Z",
    });

    expect(settled.pending.has("target-1")).toBe(false);
    expect(settled.batches.get("target-1")).toMatchObject({
      daStatus: "attested",
      daSource: "settlement",
      daAttestedAt: "2026-05-13T00:01:00.000Z",
    });
  });

  it("ignores committed finality for DA attestation", () => {
    const state = applyFinality(emptyDaStatusState, {
      network: "zeko-m-local",
      level: "committed",
      ledgerHash: "target-1",
      timestamp: "2026-05-13T00:00:00.000Z",
    });

    expect(state.pending.size).toBe(0);
    expect(state.batches.size).toBe(0);
  });
});
