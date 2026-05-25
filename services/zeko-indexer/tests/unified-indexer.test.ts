import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  InMemoryIndexerStore,
  type L2AccountChangeInput,
  type L2AccountUpdateInput,
  ZekoIndexer,
} from "../src/index";

const feature = await loadFeature("tests/unified-indexer.feature");

const timestamp = "2026-05-13T00:00:00.000Z";
const oneState = ["1", "1", "1", "1", "1", "1", "1", "1"] as const;
const twoState = ["2", "2", "2", "2", "2", "2", "2", "2"] as const;

const changedAccount = (
  publicKey: string,
  balance: string,
  nonce: number,
  zkappState?: readonly string[],
  actionState?: readonly string[],
  index = 0,
): L2AccountChangeInput => ({
  index,
  account: {
    public_key: publicKey,
    balance,
    nonce,
    token_id: "1",
    zkapp_state: zkappState ? [...zkappState] : undefined,
    action_state: actionState ? [...actionState] : undefined,
    permissions: {},
    timing: {},
  },
});

const zkappUpdate = (
  publicKey: string,
  _state: readonly string[],
  actionState: string,
  events = [["100", "200"]],
  actions: Array<{ fields: string[]; before_action_state: string; action_state: string }> = [
    { fields: ["42"], before_action_state: "action-before", action_state: actionState },
  ],
): L2AccountUpdateInput => ({
  public_key: publicKey,
  events,
  actions,
});

const bodyShapedZkappUpdate = (publicKey: string): L2AccountUpdateInput => ({
  body: {
    public_key: publicKey,
    events: [["300", "400"]],
    actions: [["77"]],
  },
});

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let indexer: ZekoIndexer;
  let lastError: unknown;

  const reset = () => {
    store = new InMemoryIndexerStore();
    indexer = new ZekoIndexer(store, {
      da: {
        authorizedSigners: new Set(["PK_A", "PK_B"]),
        quorum: 2,
        verifySignature: () => true,
      },
    });
    lastError = undefined;
  };

  const consumePayment = async (
    targetLedgerHash: string,
    sourceLedgerHash = store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
    changedAccounts: L2AccountChangeInput[] = [
      changedAccount("B62qsender", "900", 6),
      changedAccount("B62qreceiver", "1100", 0),
    ],
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "signed_command",
          hash: targetLedgerHash === "ledger-1" ? "tx-payment-1" : `tx-${targetLedgerHash}`,
          sender: "B62qsender",
          receiver: "B62qreceiver",
          amount: "100",
          fee: "1",
          nonce: 5,
          memo: "payment",
        },
        changed_accounts: changedAccounts,
      },
    });
  };

  const tryConsumePayment = async (targetLedgerHash: string, sourceLedgerHash: string) => {
    try {
      await consumePayment(targetLedgerHash, sourceLedgerHash);
    } catch (error) {
      lastError = error;
    }
  };

  const consumeZkapp = async (
    targetLedgerHash: string,
    txHash: string,
    state: readonly string[],
    actionState: string,
    sourceLedgerHash = store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: txHash,
          sender: "B62qsender",
          fee: "1",
          nonce: 1,
          account_updates: [zkappUpdate("B62qContract", state, actionState)],
        },
        changed_accounts: [
          changedAccount("B62qsender", "999", 2),
          changedAccount("B62qContract", "500", 0, state, [actionState, "0", "0", "0", "0"]),
        ],
      },
    });
  };

  const consumeBodyShapedZkapp = async (
    targetLedgerHash: string,
    publicKey: string,
    sourceLedgerHash = store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-${targetLedgerHash}`,
          sender: "B62qsender",
          fee: "1",
          nonce: 1,
          account_updates: [bodyShapedZkappUpdate(publicKey)],
        },
        changed_accounts: [
          changedAccount("B62qsender", "999", 2),
          changedAccount(publicKey, "500", 0, oneState, [
            "action-after-body",
            "action-before-body",
            "0",
            "0",
            "0",
          ]),
        ],
      },
    });
  };

  const consumeCommandlessDiff = async (
    targetLedgerHash: string,
    genesis = false,
    sourceLedgerHash = store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: null,
        changed_accounts: [changedAccount("B62qsequencer", "10000", 0)],
        genesis,
      },
    });
  };

  Scenario(
    "Payment ingestion writes transaction, account, activity, and sync state rows",
    ({ When, Then, And }) => {
      When(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      Then("one applied transaction row exists for hash {string}", (_context, hash: string) => {
        const tx = store.transactionByHash(hash);
        expect(tx?.status).toBe("applied");
      });

      And("the transaction row uses a ULID record id", () => {
        expect(store.transactionByHash("tx-payment-1")?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      });

      And("payment account rows are updated", () => {
        expect(store.accountByPublicKey("B62qsender")).toMatchObject({
          balance: "900",
          nonce: 6,
        });
        expect(store.accountByPublicKey("B62qreceiver")).toMatchObject({
          balance: "1100",
          nonce: 0,
        });
      });

      And(
        "account activity snapshots exist for ledger {string}",
        (_context, ledgerHash: string) => {
          expect(store.accountActivityByLedger(ledgerHash)).toHaveLength(2);
        },
      );

      And(
        "sync status for {string} has last_hash {string}",
        (_context, source: string, lastHash: string) => {
          expect(store.syncStatus.get(source)?.last_hash).toBe(lastHash);
        },
      );
    },
  );

  Scenario("Duplicate L2 transaction messages are idempotent", ({ When, And, Then }) => {
    When(
      "the indexer consumes a payment transaction for ledger {string}",
      async (_context, ledger: string) => {
        reset();
        await consumePayment(ledger);
      },
    );

    And(
      "the indexer consumes the same payment transaction for ledger {string} again",
      async (_context, ledger: string) => {
        await consumePayment(ledger);
      },
    );

    Then("exactly {int} transaction row exists", (_context, count: number) => {
      expect(store.transactions.size).toBe(count);
    });

    And("exactly {int} account activity rows exist", (_context, count: number) => {
      expect(store.accountActivities.size).toBe(count);
    });
  });

  Scenario("Account activity preserves the sequencer changed account index", ({ When, Then }) => {
    When(
      "the indexer consumes an account update for {string} with changed account index {int}",
      async (_context, publicKey: string, activityIndex: number) => {
        reset();
        await consumePayment("ledger-indexed-account", undefined, [
          changedAccount(publicKey, "100", 0, undefined, undefined, activityIndex),
        ]);
      },
    );

    Then(
      "account activity for {string} has activity_index {int}",
      (_context, publicKey: string, activityIndex: number) => {
        expect(
          [...store.accountActivities.values()].find(
            (activity) => activity.account_public_key === publicKey,
          )?.activity_index,
        ).toBe(activityIndex);
      },
    );
  });

  Scenario(
    "zkApp ingestion is schema-blind and stores raw event and action fields",
    ({ When, Then, And }) => {
      When(
        "the indexer consumes a zkApp transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumeZkapp(ledger, "tx-zk-1", oneState, "action-after");
        },
      );

      Then("one zkapp_event row exists for account {string}", (_context, publicKey: string) => {
        expect(store.zkappEventsByAccount(publicKey)).toHaveLength(1);
      });

      And('the zkapp_event row stores raw fields ["100", "200"]', () => {
        expect(store.zkappEventsByAccount("B62qContract")[0]?.fields).toEqual(["100", "200"]);
      });

      And("one zkapp_action row exists for account {string}", (_context, publicKey: string) => {
        expect(store.zkappActionsByAccount(publicKey)).toHaveLength(1);
      });

      And('the zkapp_action row stores raw fields ["42"]', () => {
        expect(store.zkappActionsByAccount("B62qContract")[0]?.fields).toEqual(["42"]);
      });

      And(
        "the zkapp_action row has before_action_state {string} and action_state {string}",
        (_context, before: string, after: string) => {
          expect(store.zkappActionsByAccount("B62qContract")[0]).toMatchObject({
            before_action_state: before,
            action_state: after,
          });
        },
      );

      And(
        "the zkApp child rows are tagged with target_ledger_hash {string}",
        (_context, ledger: string) => {
          expect(store.zkappEventsByLedger(ledger)).toHaveLength(1);
          expect(store.zkappActionsByLedger(ledger)).toHaveLength(1);
        },
      );
    },
  );

  Scenario(
    "zkApp ingestion accepts Spike 003 body-shaped account updates",
    ({ Given, When, Then, And }) => {
      Given(
        "account {string} has prior action_state head {string}",
        async (_context, publicKey: string, priorActionState: string) => {
          reset();
          await consumePayment("ledger-zk-body-prior", undefined, [
            changedAccount(publicKey, "500", 0, oneState, [priorActionState, "0", "0", "0", "0"]),
          ]);
        },
      );

      When(
        "the indexer consumes a body-shaped zkApp transaction for {string} on ledger {string}",
        async (_context, publicKey: string, ledger: string) => {
          await consumeBodyShapedZkapp(ledger, publicKey);
        },
      );

      Then("one zkapp_event row exists for account {string}", (_context, publicKey: string) => {
        expect(store.zkappEventsByAccount(publicKey)).toHaveLength(1);
      });

      And('the zkapp_event row stores raw fields ["300", "400"]', () => {
        expect(store.zkappEventsByAccount("B62qBodyContract")[0]?.fields).toEqual(["300", "400"]);
      });

      And("one zkapp_action row exists for account {string}", (_context, publicKey: string) => {
        expect(store.zkappActionsByAccount(publicKey)).toHaveLength(1);
      });

      And('the zkapp_action row stores raw fields ["77"]', () => {
        expect(store.zkappActionsByAccount("B62qBodyContract")[0]?.fields).toEqual(["77"]);
      });

      And(
        "the zkapp_action row has before_action_state {string} and action_state {string}",
        (_context, before: string, after: string) => {
          expect(store.zkappActionsByAccount("B62qBodyContract")[0]).toMatchObject({
            before_action_state: before,
            action_state: after,
          });
        },
      );
    },
  );

  Scenario(
    "Fee transfer and genesis diffs are classified without commands",
    ({ When, Then, And }) => {
      let lastHash = "";

      When(
        "the indexer consumes a fee transfer diff for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumeCommandlessDiff(ledger);
          lastHash = `${ledger}:diff`;
        },
      );

      const latestCommandlessTransactionHasType = (_context: unknown, type: string) => {
        expect(store.transactionByHash(lastHash)).toMatchObject({ status: "applied", type });
      };

      Then(
        "the latest commandless transaction row has type {string}",
        latestCommandlessTransactionHasType,
      );

      When(
        "the indexer consumes a genesis diff for ledger {string}",
        async (_context, ledger: string) => {
          await consumeCommandlessDiff(ledger, true);
          lastHash = `${ledger}:diff`;
        },
      );

      And(
        "the latest commandless transaction row has type {string}",
        latestCommandlessTransactionHasType,
      );
    },
  );

  Scenario(
    "Proved finality updates an existing batch without settlement",
    ({ Given, When, Then, And }) => {
      Given("a pending batch row exists for ledger {string}", (_context, ledger: string) => {
        reset();
        store.upsertBatchForTest(ledger, {
          proof_status: "pending",
          settlement_status: "pending",
        });
      });

      When(
        "the indexer consumes a proved finality message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({
            subject: "zeko.l2.finality",
            payload: {
              ledger_hash: ledger,
              level: "proved",
              source_ledger_hash: "prev",
              timestamp,
            },
          });
        },
      );

      Then(
        "batch for ledger {string} has proof_status {string}",
        (_context, ledger: string, status: string) => {
          expect(store.batchByLedger(ledger)?.proof_status).toBe(status);
        },
      );

      And(
        "batch for ledger {string} has da_status {string} and da_source {string}",
        (_context, ledger: string, status: string, source: string) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            da_status: status,
            da_source: source,
          });
        },
      );
    },
  );

  Scenario("Committed finality does not derive DA attestation", ({ Given, When, Then }) => {
    Given("a pending batch row exists for ledger {string}", (_context, ledger: string) => {
      reset();
      store.upsertBatchForTest(ledger, {
        proof_status: "pending",
        settlement_status: "pending",
      });
    });

    When(
      "the indexer consumes a committed finality message for ledger {string}",
      async (_context, ledger: string) => {
        await indexer.consume({
          subject: "zeko.l2.finality",
          payload: {
            ledger_hash: ledger,
            level: "committed",
            source_ledger_hash: "prev",
            timestamp,
          },
        });
      },
    );

    Then("batch for ledger {string} has no da_status", (_context, ledger: string) => {
      expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
    });
  });

  Scenario(
    "Settlement creates a batch and links the covered L2 transactions",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      When(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then(
        "batch for ledger {string} covers transaction heights {int} through {int}",
        (_context, ledger: string, first: number, last: number) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            first_tx_height: first,
            last_tx_height: last,
          });
        },
      );

      And(
        "batch for ledger {string} has transaction_count {int}",
        (_context, ledger: string, count: number) => {
          expect(store.batchByLedger(ledger)?.transaction_count).toBe(count);
        },
      );

      And(
        "transactions {string} and {string} are linked to batch for ledger {string}",
        (_context, firstHash: string, secondHash: string, ledger: string) => {
          const batchId = store.batchByLedger(ledger)?.id;
          expect(store.transactionByHash(firstHash)?.batch).toBe(batchId);
          expect(store.transactionByHash(secondHash)?.batch).toBe(batchId);
        },
      );
    },
  );

  Scenario(
    "Settlement links covered L2 transactions that arrive later",
    ({ Given, When, And, Then }) => {
      Given(
        "the indexer consumed a settlement message before L2 transactions for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      When(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      And(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      Then(
        "batch for ledger {string} covers transaction heights {int} through {int}",
        (_context, ledger: string, first: number, last: number) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            first_tx_height: first,
            last_tx_height: last,
          });
        },
      );

      And(
        "batch for ledger {string} has transaction_count {int}",
        (_context, ledger: string, count: number) => {
          expect(store.batchByLedger(ledger)?.transaction_count).toBe(count);
        },
      );

      And(
        "transactions {string} and {string} are linked to batch for ledger {string}",
        (_context, firstHash: string, secondHash: string, ledger: string) => {
          const batchId = store.batchByLedger(ledger)?.id;
          expect(store.transactionByHash(firstHash)?.batch).toBe(batchId);
          expect(store.transactionByHash(secondHash)?.batch).toBe(batchId);
        },
      );
    },
  );

  Scenario(
    "Replayed settling settlement does not downgrade finalized batch",
    ({ Given, When, Then, And }) => {
      Given(
        "the indexer consumed a finalized settlement message for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.l1.settlements",
            payload: settlement(ledger, "finalized"),
          });
        },
      );

      When(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then(
        "batch for ledger {string} has settlement_status {string}",
        (_context, ledger: string, settlementStatus: string) => {
          expect(store.batchByLedger(ledger)?.settlement_status).toBe(settlementStatus);
        },
      );

      And(
        "batch for ledger {string} keeps settled_at {string}",
        (_context, ledger: string, settledAt: string) => {
          expect(store.batchByLedger(ledger)?.settled_at).toBe(settledAt);
        },
      );
    },
  );

  Scenario("Settlement stores the source L1 provider", ({ When, Then }) => {
    When(
      "the indexer consumes an {string} settlement message for ledger {string}",
      async (_context, provider: "mina" | "ethereum", ledger: string) => {
        reset();
        await indexer.consume({
          subject: "zeko.l1.settlements",
          payload: settlement(ledger, "settling", provider),
        });
      },
    );

    Then(
      "batch for ledger {string} has l1_chain {string}",
      (_context, ledger: string, provider: string) => {
        expect(store.batchByLedger(ledger)?.l1_chain).toBe(provider);
      },
    );
  });

  Scenario(
    "L2 rollback deletes derived zkApp rows and restores account snapshots",
    ({ Given, When, Then, And }) => {
      Given(
        "the indexer consumed a zkApp transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumeZkapp(ledger, "tx-zk-keep", oneState, "action-keep");
        },
      );

      And(
        "the indexer consumed a follow-up zkApp transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumeZkapp(ledger, "tx-zk-reverted", twoState, "action-reverted");
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      Then("transaction {string} is marked reverted", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("reverted");
      });

      And("no zkapp_event rows remain for target ledger {string}", (_context, ledger: string) => {
        expect(store.zkappEventsByLedger(ledger)).toHaveLength(0);
      });

      And("no zkapp_action rows remain for target ledger {string}", (_context, ledger: string) => {
        expect(store.zkappActionsByLedger(ledger)).toHaveLength(0);
      });

      And('account "B62qContract" has zkapp_state ["1", "1", "1", "1", "1", "1", "1", "1"]', () => {
        expect(store.accountByPublicKey("B62qContract")?.zkapp_state).toEqual([...oneState]);
      });

      And(
        "account {string} has last_activity_height {int}",
        (_context, publicKey: string, height: number) => {
          expect(store.accountByPublicKey(publicKey)?.last_activity_height).toBe(height);
        },
      );
    },
  );

  Scenario(
    "L2 rollback removes accounts first created by the reverted range",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      And(
        "the indexer consumed a payment transaction creating account {string} for ledger {string}",
        async (_context, publicKey: string, ledger: string) => {
          await consumePayment(ledger, undefined, [changedAccount(publicKey, "25", 0)]);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      Then("account {string} no longer exists", (_context, publicKey: string) => {
        expect(store.accountByPublicKey(publicKey)).toBeUndefined();
      });
    },
  );

  Scenario(
    "Later rollbacks do not restore account state from reverted ledgers",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed an account update for {string} with balance {string} on ledger {string}",
        async (_context, publicKey: string, balance: string, ledger: string) => {
          reset();
          await consumePayment(ledger, undefined, [changedAccount(publicKey, balance, 0)]);
        },
      );

      And(
        "the indexer consumed an account update for {string} with balance {string} on ledger {string}",
        async (_context, publicKey: string, balance: string, ledger: string) => {
          await consumePayment(ledger, undefined, [changedAccount(publicKey, balance, 0)]);
        },
      );

      And(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source, [changedAccount("B62qsender", "150", 0)]);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source, [changedAccount("B62qother", "175", 0)]);
        },
      );

      Then(
        "account {string} has balance {string}",
        (_context, publicKey: string, balance: string) => {
          expect(store.accountByPublicKey(publicKey)?.balance).toBe(balance);
        },
      );
    },
  );

  Scenario(
    "Replayed reverted L2 messages do not replace the canonical ledger",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      And(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      When(
        "the indexer consumes a replayed reverted transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      Then("transaction {string} is marked reverted", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("reverted");
      });

      And("transaction {string} is still applied", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("applied");
      });

      And(
        "sync status for {string} has last_hash {string}",
        (_context, source: string, lastHash: string) => {
          expect(store.syncStatus.get(source)?.last_hash).toBe(lastHash);
        },
      );
    },
  );

  Scenario(
    "The first observed L2 diff can roll back to its source ledger",
    ({ Given, When, Then, And }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      Then("transaction {string} is marked reverted", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("reverted");
      });

      And("transaction {string} is still applied", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("applied");
      });

      And(
        "sync status for {string} has last_hash {string}",
        (_context, source: string, lastHash: string) => {
          expect(store.syncStatus.get(source)?.last_hash).toBe(lastHash);
        },
      );
    },
  );

  Scenario("Unknown L2 source hash pauses indexing for backfill", ({ Given, When, Then, And }) => {
    Given(
      "the indexer consumed a payment transaction for ledger {string}",
      async (_context, ledger: string) => {
        reset();
        await consumePayment(ledger);
      },
    );

    When(
      "the indexer consumes a payment transaction from source ledger {string} to target ledger {string}",
      async (_context, source: string, target: string) => {
        await tryConsumePayment(target, source);
      },
    );

    Then("the indexer rejects the message with an L2 gap error", () => {
      expect(lastError).toBeInstanceOf(Error);
      expect(String((lastError as Error).message)).toContain("L2 gap detected");
    });

    And("sync status for {string} is paused", (_context, source: string) => {
      expect(store.syncStatus.get(source)?.status).toBe("paused");
    });
  });

  Scenario(
    "Proved finality before settlement is buffered and transferred",
    ({ When, Then, And }) => {
      When(
        "the indexer consumes a proved finality message for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.l2.finality",
            payload: {
              ledger_hash: ledger,
              level: "proved",
              source_ledger_hash: "prev",
              timestamp,
            },
          });
        },
      );

      Then(
        "pending DA attestation for {string} has source {string}",
        (_context, ledger: string, source: string) => {
          expect(store.pendingDa.get(ledger)?.source).toBe(source);
        },
      );

      When(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then(
        "batch for ledger {string} has da_status {string} and da_source {string}",
        (_context, ledger: string, status: string, source: string) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            da_status: status,
            da_source: source,
          });
        },
      );

      And("no pending DA attestation remains for {string}", (_context, ledger: string) => {
        expect(store.pendingDa.has(ledger)).toBe(false);
      });
    },
  );

  Scenario("Direct DA signatures respect source precedence", ({ Given, When, Then, And }) => {
    Given(
      "batch for ledger {string} is attested from source {string}",
      (_context, ledger: string, source: "proved" | "settlement" | "da-direct") => {
        reset();
        store.upsertBatchForTest(ledger, { da_status: "attested", da_source: source });
      },
    );

    When(
      "the indexer consumes valid DA signatures for ledger {string} from {string} and {string}",
      async (_context, ledger: string, first: string, second: string) => {
        await indexer.consume({
          subject: "zeko.da.signatures",
          payload: daSignature(ledger, first),
        });
        await indexer.consume({
          subject: "zeko.da.signatures",
          payload: daSignature(ledger, second),
        });
      },
    );

    Then(
      "batch for ledger {string} has da_status {string} and da_source {string}",
      (_context, ledger: string, status: string, source: string) => {
        expect(store.batchByLedger(ledger)).toMatchObject({ da_status: status, da_source: source });
      },
    );

    When(
      "the indexer consumes a settlement message for ledger {string}",
      async (_context, ledger: string) => {
        await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
      },
    );

    Then(
      "after settlement batch for ledger {string} has da_status {string} and da_source {string}",
      (_context, ledger: string, status: string, source: string) => {
        expect(store.batchByLedger(ledger)).toMatchObject({ da_status: status, da_source: source });
      },
    );

    And(
      "batch for ledger {string} records DA signers {string} and {string}",
      (_context, ledger: string, first: string, second: string) => {
        expect(store.batchByLedger(ledger)?.da_signers?.map((signer) => signer.publicKey)).toEqual([
          first,
          second,
        ]);
      },
    );
  });

  Scenario("L1 rollback preserves DA facts for later rebinding", ({ Given, When, Then, And }) => {
    Given(
      "batch for ledger {string} is attested from source {string}",
      (_context, ledger: string, source: "proved" | "settlement" | "da-direct") => {
        reset();
        store.upsertBatchForTest(ledger, {
          settlement_id: `settlement-${ledger}`,
          settlement_status: "settling",
          da_status: "attested",
          da_source: source,
          da_attested_at: timestamp,
        });
      },
    );

    When(
      "the indexer consumes an L1 rollback affecting settlement {string}",
      async (_context, settlementId: string) => {
        await indexer.consume({
          subject: "zeko.l1.rollbacks",
          payload: {
            schemaVersion: 1,
            provider: "mina",
            network: "zeko-m-devnet",
            source: "l1-watcher",
            subject: "zeko.l1.rollbacks",
            rollbackId: `rollback-${settlementId}`,
            detectedAt: timestamp,
            commonAncestor: { height: 1, hash: "ancestor" },
            orphanedBlocks: [{ height: 2, hash: "old", parentHash: "ancestor" }],
            replacementBlocks: [{ height: 2, hash: "new", parentHash: "ancestor" }],
            affected: {
              settlementIds: [settlementId],
              outerActionIds: [],
              bridgeEventIds: [],
            },
          },
        });
      },
    );

    Then(
      "batch for ledger {string} has settlement_status {string}",
      (_context, ledger: string, settlementStatus: string) => {
        expect(store.batchByLedger(ledger)?.settlement_status).toBe(settlementStatus);
      },
    );

    And(
      "pending DA attestation for {string} has source {string}",
      (_context, ledger: string, source: string) => {
        expect(store.pendingDa.get(ledger)?.source).toBe(source);
      },
    );
  });

  Scenario("Pending DA attestations are pruned after the max age", ({ Given, When, Then }) => {
    Given(
      "pending DA attestation for {string} was received 31 days ago",
      (_context, ledger: string) => {
        reset();
        store.pendingDa.set(ledger, {
          ledger_hash: ledger,
          source: "proved",
          received_at: "2026-04-12T00:00:00.000Z",
          attested_at: "2026-04-12T00:00:00.000Z",
        });
      },
    );

    When("the pending DA pruner runs with a {int} day max age", (_context, maxAgeDays: number) => {
      indexer.prunePendingDa("2026-05-13T00:00:00.000Z", maxAgeDays);
    });

    Then("no pending DA attestation remains for {string}", (_context, ledger: string) => {
      expect(store.pendingDa.has(ledger)).toBe(false);
    });
  });

  Scenario("Restart resumes from durable sync state", ({ Given, When, And, Then }) => {
    Given(
      "the indexer consumes a payment transaction for ledger {string}",
      async (_context, ledger: string) => {
        reset();
        await consumePayment(ledger);
      },
    );

    When("a new indexer instance uses the same store", () => {
      indexer = new ZekoIndexer(store);
    });

    And(
      "the indexer consumes a payment transaction from source ledger {string} to target ledger {string}",
      async (_context, source: string, target: string) => {
        await consumePayment(target, source);
      },
    );

    Then(
      "sync status for {string} has last_hash {string}",
      (_context, source: string, lastHash: string) => {
        expect(store.syncStatus.get(source)?.last_hash).toBe(lastHash);
      },
    );
  });

  Scenario("Indexer remains schema-blind at the package boundary", ({ Then }) => {
    Then('the zeko-indexer source does not import "@zeko/contract-schema"', async () => {
      const srcDir = fileURLToPath(new URL("../src", import.meta.url));
      const files = await tsFilesUnder(srcDir);
      const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
      expect(contents.join("\n")).not.toContain("@zeko/contract-schema");
    });
  });
});

const tsFilesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return tsFilesUnder(path);
      }
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return files.flat();
};

const settlement = (
  ledger: string,
  finalityLevel: "settling" | "finalized" = "settling",
  provider: "mina" | "ethereum" = "mina",
) => ({
  schemaVersion: 1,
  provider,
  network: "zeko-m-devnet",
  source: "l1-watcher",
  subject: "zeko.l1.settlements",
  observedAt: timestamp,
  block: {
    height: 100,
    hash: "state-hash-100",
    parentHash: "state-hash-99",
    slot: 200,
    timestamp,
    confirmationDepth: 12,
  },
  eventType: finalityLevel === "finalized" ? "finalized" : "detected",
  settlementId: `settlement-${ledger}`,
  finalityLevel,
  txHash: `l1-tx-${ledger}`,
  commit: {
    ledgerHash: ledger,
    innerActionState: "inner-state",
    innerActionStateLength: 7,
    synchronizedOuterActionState: "outer-state",
    synchronizedOuterActionStateLength: 9,
    slotRange: { lower: 100, upper: 120 },
    rawFields: [ledger, "inner-state", "7"],
  },
});

const daSignature = (ledger: string, publicKey: string) => ({
  schemaVersion: 1,
  implementation: "zeko-multisig-v1",
  ledgerHash: ledger,
  accSet: "acc-set",
  publicKey,
  signature: `sig-${publicKey}`,
  instanceId: `instance-${publicKey}`,
  signedAt: timestamp,
});
