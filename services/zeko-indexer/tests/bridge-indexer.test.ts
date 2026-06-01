import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { createZekoIndexer, InMemoryIndexerStore, type ZekoIndexer } from "../src/public.ts";

const feature = await loadFeature("tests/features/bridge-indexer.feature");
const timestamp = "2026-05-13T00:00:00.000Z";

const l1Envelope = (blockHeight = 5000, slot = 120) =>
  ({
    schemaVersion: 1,
    provider: "mina",
    network: "zeko-m-devnet",
    source: "l1-watcher",
    observedAt: timestamp,
    block: {
      height: blockHeight,
      hash: `l1-block-${blockHeight}`,
      parentHash: `l1-block-${blockHeight - 1}`,
      slot,
      timestamp,
      confirmationDepth: 12,
    },
  }) as const;

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let indexer: ZekoIndexer;
  let replayedBridgeOperationIds: string[];

  const reset = () => {
    store = new InMemoryIndexerStore();
    indexer = createZekoIndexer(store, {
      bridge: {
        innerActionPublicKeys: new Set(["B62qInnerBridge"]),
        withdrawalDelaySlots: 100,
      },
    });
    replayedBridgeOperationIds = [];
  };

  const operation = (aux: string, sequence: number) => {
    const row = store.bridgeOperationsByAux(aux)[sequence];
    expect(row).toBeDefined();
    return row;
  };

  const consumeDeposit = async (
    aux: string,
    operationIndex = 0,
    eventKey = `${operationIndex}`,
    blockOffset = operationIndex,
  ) => {
    await indexer.consume({
      subject: "zeko.l1.bridge-events",
      payload: {
        ...l1Envelope(5000 + blockOffset),
        subject: "zeko.l1.bridge-events",
        bridgeEventId: `l1-deposit-${aux}-${eventKey}`,
        type: "deposit_submitted",
        userPk: "B62qUser",
        userPkSource: "account_update",
        txHash: `l1-submit-${aux}-${eventKey}`,
        aux,
        amount: "1000000000",
        recipient: "B62qRecipient",
        operationIndex,
        deposit: {
          timeoutSlot: 500,
          holderAccountL1: "B62qHolder",
          outerPk: "B62qOuter",
          rawActionFields: [aux, "1000000000"],
        },
      },
    });
  };

  const consumeWitness = async (aux: string, blockHeight = 5010, slot = 130) => {
    await indexer.consume({
      subject: "zeko.l1.outer-actions",
      payload: {
        ...l1Envelope(blockHeight, slot),
        subject: "zeko.l1.outer-actions",
        outerActionId: `outer-witness-${aux}`,
        txHash: `l1-witness-${aux}`,
        accountUpdateId: `au-witness-${aux}`,
        actionIndex: 0,
        actionKind: "witness",
        actionState: {
          current: `outer-witness-${aux}`,
          vector: ["a", "b", "c", "d", "e"],
          before: `outer-before-${aux}`,
          after: `outer-witness-${aux}`,
        },
        rawFields: ["1", aux],
        parsed: {
          kind: "witness",
          aux,
          slotRange: { lower: 100, upper: 130 },
        },
        archive: {
          transactionSequenceNumber: blockHeight,
          chainStatus: "canonical",
          distanceFromMaxBlockHeight: 0,
        },
      },
    });
  };

  const consumeWitnessInTransaction = async (
    aux: string,
    txHash: string,
    actionIndex: number,
    blockHeight = 5010,
    slot = 130,
  ) => {
    await indexer.consume({
      subject: "zeko.l1.outer-actions",
      payload: {
        ...l1Envelope(blockHeight, slot),
        subject: "zeko.l1.outer-actions",
        outerActionId: `outer-witness-${txHash}-${actionIndex}`,
        txHash,
        accountUpdateId: `au-witness-${actionIndex}`,
        actionIndex,
        actionKind: "witness",
        actionState: {
          current: `outer-witness-${txHash}-${actionIndex}`,
          vector: ["a", "b", "c", "d", "e"],
          before: `outer-before-${txHash}-${actionIndex}`,
          after: `outer-witness-${txHash}-${actionIndex}`,
        },
        rawFields: ["1", aux],
        parsed: {
          kind: "witness",
          aux,
          slotRange: { lower: 100, upper: 130 },
        },
        archive: {
          transactionSequenceNumber: blockHeight,
          chainStatus: "canonical",
          distanceFromMaxBlockHeight: 0,
        },
      },
    });
  };

  const consumeCommit = async (innerActionState: string, blockHeight = 5020, slot = 131) => {
    await indexer.consume({
      subject: "zeko.l1.outer-actions",
      payload: {
        ...l1Envelope(blockHeight, slot),
        subject: "zeko.l1.outer-actions",
        outerActionId: `outer-commit-${innerActionState}`,
        txHash: `l1-commit-${innerActionState}`,
        accountUpdateId: `au-commit-${innerActionState}`,
        actionIndex: 0,
        actionKind: "commit",
        actionState: {
          current: `outer-commit-${innerActionState}`,
          vector: ["a", "b", "c", "d", "e"],
          before: `outer-before-commit-${innerActionState}`,
          after: `outer-commit-${innerActionState}`,
        },
        rawFields: ["0", "ledger-bridge", innerActionState],
        parsed: {
          kind: "commit",
          ledgerHash: "ledger-bridge",
          innerActionState,
          innerActionStateLength: 1,
          synchronizedOuterActionState: `sync-${innerActionState}`,
          synchronizedOuterActionStateLength: 1,
          slotRange: { lower: 100, upper: 130 },
        },
        archive: {
          transactionSequenceNumber: blockHeight,
          chainStatus: "canonical",
          distanceFromMaxBlockHeight: 0,
        },
      },
    });
  };

  const consumeInnerAction = async (aux: string, actionState: string) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
        target_ledger_hash: `ledger-${actionState}`,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-${actionState}`,
          sender: "B62qUser",
          receiver: "B62qRecipient",
          amount: "1000000000",
          fee: "1",
          nonce: 1,
          account_updates: [
            {
              public_key: "B62qInnerBridge",
              actions: [
                {
                  fields: ["1", aux, "B62qRecipient", "1000000000"],
                  before_action_state: "0",
                  action_state: actionState,
                },
              ],
            },
          ],
        },
        changed_accounts: [
          {
            index: 0,
            account: {
              public_key: "B62qInnerBridge",
              balance: "0",
              nonce: 1,
              token_id: "1",
              action_state: [actionState],
              permissions: {},
              timing: {},
            },
          },
        ],
      },
    });
  };

  const consumeNonBridgeAction = async (aux: string) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
        target_ledger_hash: `ledger-non-bridge-${aux}`,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-non-bridge-${aux}`,
          sender: "B62qUser",
          fee: "1",
          nonce: 1,
          account_updates: [
            {
              public_key: "B62qUnrelatedContract",
              actions: [
                {
                  fields: ["1", aux, "B62qRecipient", "1000000000"],
                  before_action_state: "0",
                  action_state: `non-bridge-${aux}`,
                },
              ],
            },
          ],
        },
        changed_accounts: [
          {
            index: 0,
            account: {
              public_key: "B62qUnrelatedContract",
              balance: "0",
              nonce: 1,
              token_id: "1",
              action_state: [`non-bridge-${aux}`],
              permissions: {},
              timing: {},
            },
          },
        ],
      },
    });
  };

  const consumeReplacement = async (sourceLedgerHash: string, targetLedgerHash: string) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "signed_command",
          hash: `tx-${targetLedgerHash}`,
          sender: "B62qUser",
          receiver: "B62qRecipient",
          amount: "1",
          fee: "1",
          nonce: 2,
        },
        changed_accounts: [
          {
            index: 0,
            account: {
              public_key: "B62qUser",
              balance: "99",
              nonce: 2,
              token_id: "1",
              permissions: {},
              timing: {},
            },
          },
        ],
      },
    });
  };

  const consumeCancellation = async (aux: string, cancelledDepositIndex = 0) => {
    await indexer.consume({
      subject: "zeko.l1.bridge-events",
      payload: {
        ...l1Envelope(5030),
        subject: "zeko.l1.bridge-events",
        bridgeEventId: `l1-cancel-${aux}-${cancelledDepositIndex}`,
        type: "deposit_cancelled",
        userPk: "B62qUser",
        userPkSource: "account_update",
        txHash: `l1-cancel-${aux}`,
        aux,
        cancel: {
          cancelledDepositIndex,
          helperAccountL1: "B62qHelper",
        },
      },
    });
  };

  const consumeWithdrawalFinalization = async (aux: string) => {
    await indexer.consume({
      subject: "zeko.l1.bridge-events",
      payload: {
        ...l1Envelope(5050),
        subject: "zeko.l1.bridge-events",
        bridgeEventId: `l1-withdrawal-finalized-${aux}`,
        type: "withdrawal_finalized",
        userPk: "B62qL1User",
        userPkSource: "event_log",
        txHash: `l1-withdrawal-finalized-${aux}`,
        aux,
        amount: "0",
        recipient: "unknown",
        withdrawal: {
          withdrawalIndex: 0,
          rawEventFields: [aux],
        },
      },
    });
  };

  const consumeSettlementAtSlot = async (slot: number) => {
    await indexer.consume({
      subject: "zeko.l1.settlements",
      payload: {
        ...l1Envelope(5200 + slot, slot),
        subject: "zeko.l1.settlements",
        eventType: "detected",
        settlementId: `settlement-slot-${slot}`,
        finalityLevel: "settling",
        txHash: `l1-settlement-slot-${slot}`,
        commit: {
          ledgerHash: `ledger-settlement-slot-${slot}`,
          innerActionState: `inner-settlement-slot-${slot}`,
          innerActionStateLength: 1,
          synchronizedOuterActionState: `outer-settlement-slot-${slot}`,
          synchronizedOuterActionStateLength: 1,
          slotRange: { lower: slot - 20, upper: slot },
          rawFields: [`ledger-settlement-slot-${slot}`, `inner-settlement-slot-${slot}`, "1"],
        },
      },
    });
  };

  const consumeBridgeEventRollback = async (bridgeEventId: string) => {
    await indexer.consume({
      subject: "zeko.l1.rollbacks",
      payload: {
        schemaVersion: 1,
        provider: "mina",
        network: "zeko-m-devnet",
        source: "l1-watcher",
        subject: "zeko.l1.rollbacks",
        rollbackId: `rollback-${bridgeEventId}`,
        detectedAt: timestamp,
        commonAncestor: { height: 4999, hash: "l1-block-4999" },
        orphanedBlocks: [{ height: 5030, hash: "l1-block-5030", parentHash: "l1-block-5029" }],
        replacementBlocks: [{ height: 5030, hash: "l1-block-5030b", parentHash: "l1-block-5029" }],
        affected: {
          settlementIds: [],
          outerActionIds: [],
          bridgeEventIds: [bridgeEventId],
        },
      },
    });
  };

  const consumeOuterActionRollback = async (outerActionId: string) => {
    await indexer.consume({
      subject: "zeko.l1.rollbacks",
      payload: {
        schemaVersion: 1,
        provider: "mina",
        network: "zeko-m-devnet",
        source: "l1-watcher",
        subject: "zeko.l1.rollbacks",
        rollbackId: `rollback-${outerActionId}`,
        detectedAt: timestamp,
        commonAncestor: { height: 4999, hash: "l1-block-4999" },
        orphanedBlocks: [{ height: 5010, hash: "l1-block-5010", parentHash: "l1-block-5009" }],
        replacementBlocks: [{ height: 5010, hash: "l1-block-5010b", parentHash: "l1-block-5009" }],
        affected: {
          settlementIds: [],
          outerActionIds: [outerActionId],
          bridgeEventIds: [],
        },
      },
    });
  };

  Scenario("Deposit submission is recorded from L1 bridge events", ({ When, Then, And }) => {
    reset();
    When("the indexer consumes a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has type {string}",
      (_, aux: string, sequence: number, type: string) => {
        expect(operation(aux, sequence).type).toBe(type);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has sender {string}",
      (_, aux: string, sequence: number, sender: string) => {
        expect(operation(aux, sequence).sender).toBe(sender);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has amount {string}",
      (_, aux: string, sequence: number, amount: string) => {
        expect(operation(aux, sequence).amount).toBe(amount);
      },
    );
  });

  Scenario("Replayed deposit submissions derive stable bridge operation IDs", ({ When, Then }) => {
    When(
      "two fresh indexers consume the same deposit submission for aux {string}",
      async (_context, aux: string) => {
        reset();
        await consumeDeposit(aux);
        const firstOperationId = operation(aux, 0).id;
        reset();
        await consumeDeposit(aux);
        replayedBridgeOperationIds = [firstOperationId, operation(aux, 0).id];
      },
    );

    Then("the replayed bridge operation IDs match", () => {
      expect(replayedBridgeOperationIds[0]).toBeDefined();
      expect(replayedBridgeOperationIds[1]).toBe(replayedBridgeOperationIds[0]);
    });
  });

  Scenario("Deposit lifecycle correlates L1 and L2 actions", ({ Given, When, And, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    When("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    And(
      "the indexer consumes an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    And(
      "the indexer consumes an L1 commit covering inner action state {string}",
      (_context, innerActionState: string) => consumeCommit(innerActionState),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has search text containing {string}",
      (_, aux: string, sequence: number, value: string) => {
        expect(operation(aux, sequence).search_text).toContain(value);
      },
    );
    And("one L1 witness link exists for aux {string}", (_, aux: string) => {
      const row = operation(aux, 0);
      expect(
        [...store.l1ActionLinks.values()].filter(
          (link) => link.out === row.id && link.role === "witness",
        ),
      ).toHaveLength(1);
    });
    And("one L1 commit link exists for aux {string}", (_, aux: string) => {
      const row = operation(aux, 0);
      expect(
        [...store.l1ActionLinks.values()].filter(
          (link) => link.out === row.id && link.role === "commit",
        ),
      ).toHaveLength(1);
    });
    And("one L2 {string} link exists for aux {string}", (_, role: string, aux: string) => {
      const row = operation(aux, 0);
      expect(
        [...store.l2ActionLinks.values()].filter(
          (link) => link.in === row.id && link.role === role,
        ),
      ).toHaveLength(1);
    });
  });

  Scenario("Deposit L2 finalization waits for commit evidence", ({ Given, And, When, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    When(
      "the indexer consumes an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario("Non-bridge zkApp actions are not projected as bridge operations", ({ When, Then }) => {
    reset();
    When(
      "the indexer consumes a non-bridge zkApp action for aux {string}",
      (_context, aux: string) => consumeNonBridgeAction(aux),
    );
    Then("no bridge operation exists for aux {string}", (_context, aux: string) => {
      expect(store.bridgeOperationsByAux(aux)).toHaveLength(0);
    });
  });

  Scenario("Deposit commit waits for L1 witness evidence", ({ Given, And, When, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    And(
      "the indexer consumes an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    When(
      "the indexer consumed an L1 commit covering inner action state {string}",
      (_context, innerActionState: string) => consumeCommit(innerActionState),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "Late L2 inner actions replay previously indexed commits",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      And(
        "the indexer consumed an L1 commit covering inner action state {string}",
        (_context, innerActionState: string) => consumeCommit(innerActionState),
      );
      When(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And("one L1 commit link exists for aux {string}", (_, aux: string) => {
        const row = operation(aux, 0);
        expect(
          [...store.l1ActionLinks.values()].filter(
            (link) => link.out === row.id && link.role === "commit",
          ),
        ).toHaveLength(1);
      });
    },
  );

  Scenario("L2 rollback removes derived bridge inner evidence", ({ Given, And, When, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    And(
      "the indexer consumed an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    And(
      "the indexer consumed an L1 commit covering inner action state {string}",
      (_context, innerActionState: string) => consumeCommit(innerActionState),
    );
    When(
      "the indexer consumes an L2 replacement from source ledger {string} to target ledger {string}",
      (_context, source: string, target: string) => consumeReplacement(source, target),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And("no L2 links exist for aux {string}", (_, aux: string) => {
      const row = operation(aux, 0);
      expect([...store.l2ActionLinks.values()].filter((link) => link.in === row.id)).toHaveLength(
        0,
      );
    });
    And("no L1 commit link exists for aux {string}", (_, aux: string) => {
      const row = operation(aux, 0);
      expect(
        [...store.l1ActionLinks.values()].filter(
          (link) => link.out === row.id && link.role === "commit",
        ),
      ).toHaveLength(0);
    });
  });

  Scenario(
    "L2 withdrawal after rollback creates a fresh bridge operation",
    ({ Given, And, When, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And(
        "the indexer consumes an L2 replacement from source ledger {string} to target ledger {string}",
        (_context, source: string, target: string) => consumeReplacement(source, target),
      );
      When(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario("L1 witness skips rolled-back withdrawal operations", ({ Given, And, When, Then }) => {
    reset();
    Given(
      "the indexer consumed an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    And(
      "the indexer consumes an L2 replacement from source ledger {string} to target ledger {string}",
      (_context, source: string, target: string) => consumeReplacement(source, target),
    );
    And(
      "the indexer consumes an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    When("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "L2 rollback of a completed withdrawal rolls back finalization evidence",
    ({ Given, And, When, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And(
        "the indexer consumed an L1 commit covering inner action state {string}",
        (_context, innerActionState: string) => consumeCommit(innerActionState),
      );
      And(
        "the indexer observes L1 slot {int} for aux {string}",
        async (_context, slot: number, aux: string) => {
          await consumeCommit(`unrelated-${slot}-${aux}`, 5100 + slot, slot);
          expect(operation(aux, 0).status).toBe("delay_passed");
        },
      );
      And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      When(
        "the indexer consumes an L2 replacement from source ledger {string} to target ledger {string}",
        (_context, source: string, target: string) => consumeReplacement(source, target),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has no L1 witness tx hash",
        (_, aux: string, sequence: number) => {
          expect(operation(aux, sequence).l1_witness_tx_hash).toBeUndefined();
        },
      );
    },
  );

  Scenario("Repeated deposits with the same aux keep FIFO identity", ({ When, And, Then }) => {
    reset();
    When("the indexer consumes a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    And(
      "the indexer consumes another deposit submission for aux {string}",
      async (_context, aux: string) => {
        await consumeDeposit(aux, 1);
      },
    );
    And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "Repeated deposits derive FIFO identity when producer action index resets",
    ({ When, And, Then }) => {
      reset();
      When("the indexer consumes a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And(
        "the indexer consumes another deposit submission for aux {string} with producer action index {int}",
        (_context, aux: string, operationIndex: number) =>
          consumeDeposit(aux, operationIndex, "same-producer-index", 1),
      );
      And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "Out-of-order deposit submission enriches existing witness evidence",
    ({ Given, When, Then, And }) => {
      reset();
      Given("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      When("the indexer consumes a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has sender {string}",
        (_, aux: string, sequence: number, sender: string) => {
          expect(operation(aux, sequence).sender).toBe(sender);
        },
      );
    },
  );

  Scenario("Replayed L1 witness actions are idempotent", ({ Given, When, And, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    When("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    And("the indexer replays the L1 witness for aux {string}", (_context, aux: string) =>
      consumeWitness(aux),
    );
    Then(
      "exactly {int} bridge operation exists for aux {string}",
      (_, count: number, aux: string) => {
        expect(store.bridgeOperationsByAux(aux)).toHaveLength(count);
      },
    );
    And("one L1 witness link exists for aux {string}", (_, aux: string) => {
      const row = operation(aux, 0);
      expect(
        [...store.l1ActionLinks.values()].filter(
          (link) => link.out === row.id && link.role === "witness",
        ),
      ).toHaveLength(1);
    });
  });

  Scenario(
    "Multiple outer actions in one L1 transaction keep unique positions",
    ({ When, Then }) => {
      reset();
      When(
        "the indexer consumes L1 witnesses for aux {string} and {string} in one transaction",
        async (_context, firstAux: string, secondAux: string) => {
          await consumeWitnessInTransaction(firstAux, "l1-multi-action", 0);
          await consumeWitnessInTransaction(secondAux, "l1-multi-action", 1);
        },
      );
      Then("outer action rows have unique action indexes", () => {
        const indexes = [...store.outerActions.values()]
          .filter((row) => row.txn_hash === "l1-multi-action")
          .map((row) => row.action_index);
        expect(indexes).toHaveLength(2);
        expect(new Set(indexes).size).toBe(indexes.length);
      });
    },
  );

  Scenario("Deposit cancellation updates the matching operation", ({ Given, When, Then, And }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    When("the indexer consumes a deposit cancellation for aux {string}", (_context, aux: string) =>
      consumeCancellation(aux),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has cancel tx hash {string}",
      (_, aux: string, sequence: number, txHash: string) => {
        expect(operation(aux, sequence).cancel_tx_hash).toBe(txHash);
      },
    );
  });

  Scenario(
    "Deposit cancellation uses the cancelled deposit index",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And(
        "the indexer consumed another deposit submission for aux {string}",
        async (_context, aux: string) => {
          await consumeDeposit(aux, 1);
        },
      );
      When(
        "the indexer consumes a deposit cancellation for aux {string} sequence {int}",
        (_context, aux: string, sequence: number) => consumeCancellation(aux, sequence),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "Cancelled deposits do not accept later L1 witness evidence",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed a deposit cancellation for aux {string}", (_context, aux: string) =>
        consumeCancellation(aux),
      );
      When("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "Cancelled deposits do not accept later L2 inner evidence",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed a deposit cancellation for aux {string}", (_context, aux: string) =>
        consumeCancellation(aux),
      );
      When(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has type {string}",
        (_, aux: string, sequence: number, type: string) => {
          expect(operation(aux, sequence).type).toBe(type);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "L1 rollback of a deposit cancellation restores the deposit",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed a deposit cancellation for aux {string}", (_context, aux: string) =>
        consumeCancellation(aux),
      );
      When(
        "the indexer consumes an L1 rollback affecting bridge event {string}",
        (_context, bridgeEventId: string) => consumeBridgeEventRollback(bridgeEventId),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has no cancel tx hash",
        (_, aux: string, sequence: number) => {
          expect(operation(aux, sequence).cancel_tx_hash).toBeUndefined();
        },
      );
    },
  );

  Scenario("Settlement slots advance deposit timeouts", ({ Given, When, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    When("the indexer consumes an L1 settlement at slot {int}", (_context, slot: number) =>
      consumeSettlementAtSlot(slot),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "Timed-out deposits are not completed by late L2 evidence",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumes an L1 settlement at slot {int}", (_context, slot: number) =>
        consumeSettlementAtSlot(slot),
      );
      When(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario("Timed-out deposits can still be cancelled", ({ Given, And, When, Then }) => {
    reset();
    Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
      consumeDeposit(aux),
    );
    And("the indexer consumes an L1 settlement at slot {int}", (_context, slot: number) =>
      consumeSettlementAtSlot(slot),
    );
    When("the indexer consumes a deposit cancellation for aux {string}", (_context, aux: string) =>
      consumeCancellation(aux),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
    And(
      "bridge operation for aux {string} sequence {int} has cancel tx hash {string}",
      (_, aux: string, sequence: number, txHash: string) => {
        expect(operation(aux, sequence).cancel_tx_hash).toBe(txHash);
      },
    );
  });

  Scenario("Settlement slots advance withdrawal delay", ({ Given, And, When, Then }) => {
    reset();
    Given(
      "the indexer consumed an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    And(
      "the indexer consumed an L1 commit covering inner action state {string}",
      (_context, innerActionState: string) => consumeCommit(innerActionState),
    );
    When("the indexer consumes an L1 settlement at slot {int}", (_context, slot: number) =>
      consumeSettlementAtSlot(slot),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "Withdrawal lifecycle uses L2 inner actions, commits, delay, and L1 witnesses",
    ({ Given, When, And, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      When(
        "the indexer consumes an L1 commit covering inner action state {string}",
        (_context, innerActionState: string) => consumeCommit(innerActionState),
      );
      And("the indexer observes L1 slot {int}", async (_context, slot: number) => {
        await consumeCommit(`unrelated-${slot}`, 5100 + slot, slot);
        expect(operation("aux-withdrawal", 0).status).toBe("delay_passed");
      });
      And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has type {string}",
        (_, aux: string, sequence: number, type: string) => {
          expect(operation(aux, sequence).type).toBe(type);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "L1 rollback of a withdrawal witness preserves elapsed delay",
    ({ Given, And, When, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And(
        "the indexer consumed an L1 commit covering inner action state {string}",
        (_context, innerActionState: string) => consumeCommit(innerActionState),
      );
      And(
        "the indexer observes L1 slot {int} for aux {string}",
        async (_context, slot: number, aux: string) => {
          await consumeCommit(`unrelated-${slot}-${aux}`, 5100 + slot, slot);
          expect(operation(aux, 0).status).toBe("delay_passed");
        },
      );
      And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      When(
        "the indexer consumes an L1 rollback affecting outer action {string}",
        async (_context, outerActionId: string) => {
          await indexer.consume({
            subject: "zeko.l1.rollbacks",
            payload: {
              schemaVersion: 1,
              provider: "mina",
              network: "zeko-m-devnet",
              source: "l1-watcher",
              subject: "zeko.l1.rollbacks",
              rollbackId: `rollback-${outerActionId}`,
              detectedAt: timestamp,
              commonAncestor: { height: 5009, hash: "l1-block-5009" },
              orphanedBlocks: [
                { height: 5010, hash: "l1-block-5010", parentHash: "l1-block-5009" },
              ],
              replacementBlocks: [
                { height: 5010, hash: "l1-block-5010b", parentHash: "l1-block-5009" },
              ],
              affected: {
                settlementIds: [],
                outerActionIds: [outerActionId],
                bridgeEventIds: [],
              },
            },
          });
        },
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario("Withdrawal inner action is exposed as L2 witnessed before commit", ({ When, Then }) => {
    reset();
    When(
      "the indexer consumes an L2 inner action for aux {string} with action state {string}",
      (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
    );
    Then(
      "bridge operation for aux {string} sequence {int} has status {string}",
      (_, aux: string, sequence: number, status: string) => {
        expect(operation(aux, sequence).status).toBe(status);
      },
    );
  });

  Scenario(
    "Out-of-order withdrawal finalization is enriched by the L2 burn",
    ({ Given, When, Then, And }) => {
      reset();
      Given(
        "the indexer consumed an L1 withdrawal finalization for aux {string}",
        (_context, aux: string) => consumeWithdrawalFinalization(aux),
      );
      When(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has submit tx hash {string}",
        (_, aux: string, sequence: number, txHash: string) => {
          expect(operation(aux, sequence).submit_tx_hash).toBe(txHash);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has sender {string}",
        (_, aux: string, sequence: number, sender: string) => {
          expect(operation(aux, sequence).sender).toBe(sender);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has amount {string}",
        (_, aux: string, sequence: number, amount: string) => {
          expect(operation(aux, sequence).amount).toBe(amount);
        },
      );
    },
  );

  Scenario(
    "Out-of-order withdrawal finalization does not invent an L2 submit",
    ({ When, Then, And }) => {
      reset();
      When(
        "the indexer consumed an L1 withdrawal finalization for aux {string}",
        (_context, aux: string) => consumeWithdrawalFinalization(aux),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has no submit tx hash",
        (_, aux: string, sequence: number) => {
          expect(operation(aux, sequence).submit_tx_hash).toBeUndefined();
        },
      );
    },
  );

  Scenario(
    "Withdrawal finalization enriches an already witnessed withdrawal",
    ({ Given, And, When, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And("the indexer consumes an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      When(
        "the indexer consumed an L1 withdrawal finalization for aux {string}",
        (_context, aux: string) => consumeWithdrawalFinalization(aux),
      );
      Then(
        "exactly {int} bridge operation exists for aux {string}",
        (_, count: number, aux: string) => {
          expect(store.bridgeOperationsByAux(aux)).toHaveLength(count);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has submit tx hash {string}",
        (_, aux: string, sequence: number, txHash: string) => {
          expect(operation(aux, sequence).submit_tx_hash).toBe(txHash);
        },
      );
    },
  );

  Scenario(
    "L1 rollback of a withdrawal finalization keeps L2 withdrawal evidence",
    ({ Given, And, When, Then }) => {
      reset();
      Given(
        "the indexer consumed an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And(
        "the indexer consumed an L1 withdrawal finalization for aux {string}",
        (_context, aux: string) => consumeWithdrawalFinalization(aux),
      );
      When(
        "the indexer consumes an L1 rollback affecting bridge event {string}",
        (_context, bridgeEventId: string) => consumeBridgeEventRollback(bridgeEventId),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has no L1 witness tx hash",
        (_, aux: string, sequence: number) => {
          expect(operation(aux, sequence).l1_witness_tx_hash).toBeUndefined();
        },
      );
    },
  );

  Scenario(
    "L1 rollback invalidating a witness recalculates bridge status",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      When(
        "the indexer consumes an L1 rollback affecting outer action {string}",
        async (_context, outerActionId: string) => {
          await indexer.consume({
            subject: "zeko.l1.rollbacks",
            payload: {
              schemaVersion: 1,
              provider: "mina",
              network: "zeko-m-devnet",
              source: "l1-watcher",
              subject: "zeko.l1.rollbacks",
              rollbackId: `rollback-${outerActionId}`,
              detectedAt: timestamp,
              commonAncestor: { height: 4999, hash: "l1-block-4999" },
              orphanedBlocks: [
                { height: 5010, hash: "l1-block-5010", parentHash: "l1-block-5009" },
              ],
              replacementBlocks: [
                { height: 5010, hash: "l1-block-5010b", parentHash: "l1-block-5009" },
              ],
              affected: {
                settlementIds: [],
                outerActionIds: [outerActionId],
                bridgeEventIds: [],
              },
            },
          });
        },
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And("no L1 witness link exists for aux {string}", (_, aux: string) => {
        const row = operation(aux, 0);
        expect(
          [...store.l1ActionLinks.values()].filter(
            (link) => link.out === row.id && link.role === "witness",
          ),
        ).toHaveLength(0);
      });
    },
  );

  Scenario(
    "L1 rollback does not downgrade unrelated clock-derived bridge status",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      And("the indexer observes L1 slot {int}", async (_context, slot: number) => {
        await consumeCommit(`unrelated-${slot}`, 5100 + slot, slot);
      });
      When(
        "the indexer consumes an L1 rollback affecting outer action {string}",
        async (_context, outerActionId: string) => {
          await indexer.consume({
            subject: "zeko.l1.rollbacks",
            payload: {
              schemaVersion: 1,
              provider: "mina",
              network: "zeko-m-devnet",
              source: "l1-watcher",
              subject: "zeko.l1.rollbacks",
              rollbackId: `rollback-${outerActionId}`,
              detectedAt: timestamp,
              commonAncestor: { height: 4999, hash: "l1-block-4999" },
              orphanedBlocks: [
                { height: 5010, hash: "l1-block-5010", parentHash: "l1-block-5009" },
              ],
              replacementBlocks: [
                { height: 5010, hash: "l1-block-5010b", parentHash: "l1-block-5009" },
              ],
              affected: {
                settlementIds: [],
                outerActionIds: [outerActionId],
                bridgeEventIds: [],
              },
            },
          });
        },
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "L1 rollback invalidating a deposit commit keeps L2 evidence uncompleted",
    ({ Given, And, When, Then }) => {
      reset();
      Given("the indexer consumed a deposit submission for aux {string}", (_context, aux: string) =>
        consumeDeposit(aux),
      );
      And("the indexer consumed an L1 witness for aux {string}", (_context, aux: string) =>
        consumeWitness(aux),
      );
      And(
        "the indexer consumes an L2 inner action for aux {string} with action state {string}",
        (_context, aux: string, actionState: string) => consumeInnerAction(aux, actionState),
      );
      And(
        "the indexer consumed an L1 commit covering inner action state {string}",
        (_context, innerActionState: string) => consumeCommit(innerActionState),
      );
      When(
        "the indexer consumes an L1 rollback affecting outer action {string}",
        (_context, outerActionId: string) => consumeOuterActionRollback(outerActionId),
      );
      Then(
        "bridge operation for aux {string} sequence {int} has status {string}",
        (_, aux: string, sequence: number, status: string) => {
          expect(operation(aux, sequence).status).toBe(status);
        },
      );
      And("no L1 commit link exists for aux {string}", (_, aux: string) => {
        const row = operation(aux, 0);
        expect(
          [...store.l1ActionLinks.values()].filter(
            (link) => link.out === row.id && link.role === "commit",
          ),
        ).toHaveLength(0);
      });
    },
  );
});
