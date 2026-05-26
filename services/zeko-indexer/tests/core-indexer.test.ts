import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { AccountUpdate, Field } from "o1js";
import { expect } from "vitest";
import {
  InMemoryIndexerStore,
  type L2AccountChangeInput,
  type L2AccountUpdateInput,
  type SurrealHttpClient,
  writeIndexerProjectionToSurreal,
  ZekoIndexer,
} from "../src/index";

const feature = await loadFeature("tests/core-indexer.feature");
const execFileAsync = promisify(execFile);
const serviceRoot = fileURLToPath(new URL("..", import.meta.url));

const timestamp = "2026-05-13T00:00:00.000Z";
const minaEmptyActionState = AccountUpdate.Actions.emptyActionState().toString();
const oneState = ["1", "1", "1", "1", "1", "1", "1", "1"] as const;
const twoState = ["2", "2", "2", "2", "2", "2", "2", "2"] as const;

type ReplayProjectionIds = {
  transactions: string[];
  accounts: string[];
  accountActivities: string[];
};

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

const tokenChangedAccount = (
  publicKey: string,
  tokenId: string,
  balance: string,
  nonce: number,
  zkappState?: readonly string[],
  actionState?: readonly string[],
  index = 0,
): L2AccountChangeInput => ({
  ...changedAccount(publicKey, balance, nonce, zkappState, actionState, index),
  account: {
    ...changedAccount(publicKey, balance, nonce, zkappState, actionState, index).account,
    token_id: tokenId,
  },
});

const delegatedAccount = (
  publicKey: string,
  delegate: string,
  balance = "100",
  nonce = 0,
): L2AccountChangeInput => ({
  ...changedAccount(publicKey, balance, nonce),
  account: {
    ...changedAccount(publicKey, balance, nonce).account,
    delegate,
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

const tokenZkappUpdate = (
  publicKey: string,
  tokenId: string,
  actionState: string,
): L2AccountUpdateInput => ({
  body: {
    public_key: publicKey,
    token_id: tokenId,
    events: [["900", "901"]],
    actions: [{ fields: ["902"], before_action_state: "token-before", action_state: actionState }],
  },
});

const bodyShapedZkappUpdate = (
  publicKey: string,
  actions: string[][] = [["77"]],
): L2AccountUpdateInput => ({
  body: {
    public_key: publicKey,
    events: [["300", "400"]],
    actions,
  },
});

const deriveActionChain = (actions: string[][], beforeHead: string) => {
  let cursor = Field(beforeHead);
  return actions.map((fields) => {
    const before = cursor.toString();
    const actionHash = AccountUpdate.Actions.hash([fields.map((field) => Field(field))]);
    cursor = AccountUpdate.Actions.updateSequenceState(cursor, actionHash);
    return {
      fields,
      before_action_state: before,
      action_state: cursor.toString(),
    };
  });
};

const replayProjectionIds = (store: InMemoryIndexerStore): ReplayProjectionIds => ({
  transactions: [...store.transactions.values()].map((transaction) => transaction.id).sort(),
  accounts: [...store.accounts.values()].map((account) => account.id).sort(),
  accountActivities: [...store.accountActivities.values()].map((activity) => activity.id).sort(),
});

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let indexer: ZekoIndexer;
  let lastError: unknown;
  let projectionStatements: string[];
  let projectionClient: SurrealHttpClient;

  const reset = () => {
    store = new InMemoryIndexerStore();
    indexer = new ZekoIndexer(store, {
      da: {
        authorizedSigners: new Set(["PK_A", "PK_B", "PK_C"]),
        quorum: 2,
        verifySignature: () => true,
      },
    });
    lastError = undefined;
    projectionStatements = [];
    projectionClient = {
      async query(sql: string): Promise<void> {
        projectionStatements.push(sql);
      },
    };
  };

  const consumePayment = async (
    targetLedgerHash: string,
    sourceLedgerHash = store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
    changedAccounts: L2AccountChangeInput[] = [
      changedAccount("B62qsender", "900", 6),
      changedAccount("B62qreceiver", "1100", 0),
    ],
    occurredAt: string | number = timestamp,
    commandHash?: string,
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: sourceLedgerHash,
        target_ledger_hash: targetLedgerHash,
        timestamp: occurredAt,
        acc_set: "acc-set",
        command: {
          type: "signed_command",
          hash:
            commandHash ??
            (targetLedgerHash === "ledger-1" ? "tx-payment-1" : `tx-${targetLedgerHash}`),
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
    actionState = "action-after-body",
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
            actionState,
            "action-before-body",
            "0",
            "0",
            "0",
          ]),
        ],
      },
    });
  };

  const consumeTokenZkapp = async (
    targetLedgerHash: string,
    publicKey: string,
    tokenId: string,
  ) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-${targetLedgerHash}`,
          sender: "B62qsender",
          fee: "1",
          nonce: 1,
          account_updates: [tokenZkappUpdate(publicKey, tokenId, "token-after")],
        },
        changed_accounts: [
          changedAccount("B62qsender", "999", 2),
          tokenChangedAccount(publicKey, tokenId, "700", 1, oneState, [
            "token-after",
            "token-before",
            "0",
            "0",
            "0",
          ]),
        ],
      },
    });
  };

  const consumeBodyShapedZkappWithRawActions = async (
    targetLedgerHash: string,
    publicKey: string,
    actionFields: string[][],
    priorActionState: string,
  ) => {
    const chain = deriveActionChain(actionFields, priorActionState);
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-${targetLedgerHash}`,
          sender: "B62qsender",
          fee: "1",
          nonce: 1,
          account_updates: [bodyShapedZkappUpdate(publicKey, actionFields)],
        },
        changed_accounts: [
          changedAccount("B62qsender", "999", 2),
          changedAccount(
            publicKey,
            "500",
            0,
            oneState,
            chain
              .slice(-5)
              .toReversed()
              .map((action) => action.action_state),
          ),
        ],
      },
    });
  };

  const consumeRepeatedZkappUpdates = async (targetLedgerHash: string, publicKey: string) => {
    await indexer.consume({
      subject: "zeko.l2.transactions",
      payload: {
        source_ledger_hash: store.syncStatus.get("l2-transactions")?.last_hash ?? "ledger-0",
        target_ledger_hash: targetLedgerHash,
        timestamp,
        acc_set: "acc-set",
        command: {
          type: "zkapp_command",
          hash: `tx-${targetLedgerHash}`,
          sender: "B62qsender",
          fee: "1",
          nonce: 1,
          account_updates: [
            zkappUpdate(
              publicKey,
              oneState,
              "action-repeat-1",
              [["10"]],
              [
                {
                  fields: ["100"],
                  before_action_state: "action-repeat-0",
                  action_state: "action-repeat-1",
                },
              ],
            ),
            zkappUpdate(
              publicKey,
              oneState,
              "action-repeat-2",
              [["20"]],
              [
                {
                  fields: ["200"],
                  before_action_state: "action-repeat-1",
                  action_state: "action-repeat-2",
                },
              ],
            ),
          ],
        },
        changed_accounts: [
          changedAccount("B62qsender", "999", 2),
          changedAccount(publicKey, "500", 0, oneState, [
            "action-repeat-2",
            "action-repeat-1",
            "action-repeat-0",
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

  Scenario("L2 millisecond timestamp strings are normalized", ({ When, Then }) => {
    When(
      "the indexer consumes a payment transaction for ledger {string} with timestamp {string}",
      async (_context, ledger: string, observedAt: string) => {
        reset();
        await consumePayment(ledger, undefined, undefined, observedAt);
      },
    );

    Then(
      "transaction {string} has timestamp {string}",
      (_context, hash: string, expectedTimestamp: string) => {
        expect(store.transactionByHash(hash)?.timestamp).toBe(expectedTimestamp);
      },
    );
  });

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

  Scenario("Replayed L2 transactions use stable row identities", ({ When, Then, And }) => {
    let firstProjection: ReplayProjectionIds;
    let replayedProjection: ReplayProjectionIds;

    When(
      "two fresh indexers consume the same payment transaction for ledger {string}",
      async (_context, ledger: string) => {
        reset();
        await consumePayment(ledger);
        firstProjection = replayProjectionIds(store);

        reset();
        await consumePayment(ledger);
        replayedProjection = replayProjectionIds(store);
      },
    );

    Then("replayed transaction ids are identical", () => {
      expect(replayedProjection.transactions).toEqual(firstProjection.transactions);
    });

    And("replayed account ids are identical", () => {
      expect(replayedProjection.accounts).toEqual(firstProjection.accounts);
    });

    And("replayed account activity ids are identical", () => {
      expect(replayedProjection.accountActivities).toEqual(firstProjection.accountActivities);
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

  Scenario("Token accounts with the same public key remain distinct", ({ When, Then, And }) => {
    When(
      "the indexer consumes token account updates for {string} on ledger {string}",
      async (_context, publicKey: string, ledger: string) => {
        reset();
        await consumePayment(ledger, undefined, [
          changedAccount(publicKey, "100", 0, undefined, undefined, 0),
          {
            ...changedAccount(publicKey, "200", 0, undefined, undefined, 1),
            account: {
              ...changedAccount(publicKey, "200", 0).account,
              token_id: "2",
            },
          },
        ]);
      },
    );

    Then(
      "account {string} with token {string} has balance {string}",
      (_context, publicKey: string, tokenId: string, balance: string) => {
        expect(store.accountByPublicKey(publicKey, tokenId)?.balance).toBe(balance);
      },
    );

    And(
      "account {string} with token {string} has balance {string}",
      (_context, publicKey: string, tokenId: string, balance: string) => {
        expect(store.accountByPublicKey(publicKey, tokenId)?.balance).toBe(balance);
      },
    );

    And(
      "token account activity rows for {string} point to distinct account records",
      (_context, publicKey: string) => {
        const accountIds = [...store.accountActivities.values()]
          .filter((activity) => activity.account_public_key === publicKey)
          .map((activity) => activity.account);
        expect(new Set(accountIds).size).toBe(2);
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
    "zkApp child rows link to the token account that emitted them",
    ({ Given, And, When, Then }) => {
      Given(
        "account {string} exists for token {string} with action_state head {string}",
        async (_context, publicKey: string, tokenId: string, actionState: string) => {
          reset();
          await consumePayment("ledger-token-zkapp-prior-native", undefined, [
            tokenChangedAccount(publicKey, tokenId, "500", 0, oneState, [
              actionState,
              "0",
              "0",
              "0",
              "0",
            ]),
          ]);
        },
      );

      And(
        "account {string} exists for token {string} with action_state head {string}",
        async (_context, publicKey: string, tokenId: string, actionState: string) => {
          await consumePayment("ledger-token-zkapp-prior-token", undefined, [
            tokenChangedAccount(publicKey, tokenId, "600", 0, oneState, [
              actionState,
              "0",
              "0",
              "0",
              "0",
            ]),
          ]);
        },
      );

      When(
        "the indexer consumes a token zkApp transaction for {string} on ledger {string}",
        async (_context, publicKey: string, ledger: string) => {
          await consumeTokenZkapp(ledger, publicKey, "2");
        },
      );

      Then(
        "one zkapp_event row exists for account {string} with token {string}",
        (_context, publicKey: string, tokenId: string) => {
          const account = store.accountByPublicKey(publicKey, tokenId);
          expect(
            [...store.zkappEvents.values()].filter(
              (event) => event.emitting_account === account?.id,
            ),
          ).toHaveLength(1);
        },
      );

      And(
        "one zkapp_action row exists for account {string} with token {string}",
        (_context, publicKey: string, tokenId: string) => {
          const account = store.accountByPublicKey(publicKey, tokenId);
          expect(
            [...store.zkappActions.values()].filter(
              (action) => action.emitting_account === account?.id,
            ),
          ).toHaveLength(1);
        },
      );

      And(
        "no zkApp child rows exist for account {string} with token {string}",
        (_context, publicKey: string, tokenId: string) => {
          const account = store.accountByPublicKey(publicKey, tokenId);
          expect(
            [...store.zkappEvents.values()].filter(
              (event) => event.emitting_account === account?.id,
            ),
          ).toHaveLength(0);
          expect(
            [...store.zkappActions.values()].filter(
              (action) => action.emitting_account === account?.id,
            ),
          ).toHaveLength(0);
        },
      );

      And(
        "the token zkapp_action row has before_action_state {string} and action_state {string}",
        (_context, before: string, after: string) => {
          const account = store.accountByPublicKey("B62qTokenContract", "2");
          expect(
            [...store.zkappActions.values()].find(
              (action) => action.emitting_account === account?.id,
            ),
          ).toMatchObject({ before_action_state: before, action_state: after });
        },
      );
    },
  );

  Scenario("First raw zkApp action uses the Mina empty action state", ({ When, Then, And }) => {
    When(
      "the indexer consumes a first body-shaped zkApp transaction for {string} on ledger {string}",
      async (_context, publicKey: string, ledger: string) => {
        reset();
        await consumeBodyShapedZkapp(ledger, publicKey, undefined, "action-after-first-body");
      },
    );

    Then("one zkapp_action row exists for account {string}", (_context, publicKey: string) => {
      expect(store.zkappActionsByAccount(publicKey)).toHaveLength(1);
    });

    And('the zkapp_action row stores raw fields ["77"]', () => {
      expect(store.zkappActionsByAccount("B62qFirstBodyContract")[0]?.fields).toEqual(["77"]);
    });

    And("the zkapp_action row starts from the Mina empty action state", () => {
      expect(store.zkappActionsByAccount("B62qFirstBodyContract")[0]?.before_action_state).toBe(
        minaEmptyActionState,
      );
    });
  });

  Scenario(
    "Raw zkApp action batches use Mina protocol action-state hashing",
    ({ Given, When, Then, And }) => {
      const actionFields = [["201"], ["202"], ["203"]];
      const priorActionState = minaEmptyActionState;
      let expectedChain: ReturnType<typeof deriveActionChain>;

      Given(
        "account {string} has prior Mina action_state head",
        async (_context, publicKey: string) => {
          reset();
          expectedChain = deriveActionChain(actionFields, priorActionState);
          await consumePayment("ledger-protocol-actions-prior", undefined, [
            changedAccount(publicKey, "500", 0, oneState, [priorActionState, "0", "0", "0", "0"]),
          ]);
        },
      );

      When(
        "the indexer consumes a body-shaped zkApp transaction with {int} protocol raw actions for {string} on ledger {string}",
        async (_context, count: number, publicKey: string, ledger: string) => {
          await consumeBodyShapedZkappWithRawActions(
            ledger,
            publicKey,
            actionFields.slice(0, count),
            priorActionState,
          );
        },
      );

      Then(
        "{int} zkapp_action rows exist for account {string}",
        (_context, count: number, publicKey: string) => {
          expect(store.zkappActionsByAccount(publicKey)).toHaveLength(count);
        },
      );

      And(
        "the raw zkapp_action chain for {string} matches Mina protocol action-state hashing",
        (_context, publicKey: string) => {
          const actions = store.zkappActionsByAccount(publicKey);
          expect(
            actions.map(({ fields, before_action_state, action_state }) => ({
              fields,
              before_action_state,
              action_state,
            })),
          ).toEqual(expectedChain);
        },
      );
    },
  );

  Scenario(
    "Raw zkApp action batches beyond the retained vector are indexed",
    ({ Given, When, Then, And }) => {
      const actionFields = [["101"], ["102"], ["103"], ["104"], ["105"], ["106"]];
      let expectedChain: ReturnType<typeof deriveActionChain>;

      Given(
        "account {string} has prior numeric action_state head {string}",
        async (_context, publicKey: string, priorActionState: string) => {
          reset();
          expectedChain = deriveActionChain(actionFields, priorActionState);
          await consumePayment("ledger-long-actions-prior", undefined, [
            changedAccount(publicKey, "500", 0, oneState, [priorActionState, "0", "0", "0", "0"]),
          ]);
        },
      );

      When(
        "the indexer consumes a body-shaped zkApp transaction with {int} raw actions for {string} on ledger {string}",
        async (_context, count: number, publicKey: string, ledger: string) => {
          await consumeBodyShapedZkappWithRawActions(
            ledger,
            publicKey,
            actionFields.slice(0, count),
            "0",
          );
        },
      );

      Then(
        "{int} zkapp_action rows exist for account {string}",
        (_context, count: number, publicKey: string) => {
          expect(store.zkappActionsByAccount(publicKey)).toHaveLength(count);
        },
      );

      And(
        "the raw zkapp_action chain for {string} is contiguous",
        (_context, publicKey: string) => {
          const actions = store.zkappActionsByAccount(publicKey);
          expect(
            actions.map(({ fields, before_action_state, action_state }) => ({
              fields,
              before_action_state,
              action_state,
            })),
          ).toEqual(expectedChain);
        },
      );

      And(
        "the final zkapp_action state equals the account action_state head for {string}",
        (_context, publicKey: string) => {
          const actions = store.zkappActionsByAccount(publicKey);
          const account = store.accountByPublicKey(publicKey);
          expect(actions.at(-1)?.action_state).toBe(account?.action_state?.[0]);
        },
      );
    },
  );

  Scenario(
    "Repeated zkApp account updates for one account preserve all child rows",
    ({ When, Then, And }) => {
      When(
        "the indexer consumes a zkApp transaction with repeated updates for {string} on ledger {string}",
        async (_context, publicKey: string, ledger: string) => {
          reset();
          await consumeRepeatedZkappUpdates(ledger, publicKey);
        },
      );

      Then(
        "{int} zkapp_event rows exist for account {string}",
        (_context, count: number, publicKey: string) => {
          expect(store.zkappEventsByAccount(publicKey)).toHaveLength(count);
        },
      );

      And('the zkapp_event rows store raw fields ["10"] and ["20"]', () => {
        expect(
          store.zkappEventsByAccount("B62qRepeatedContract").map((event) => event.fields),
        ).toEqual([["10"], ["20"]]);
      });

      And(
        "{int} zkapp_action rows exist for account {string}",
        (_context, count: number, publicKey: string) => {
          expect(store.zkappActionsByAccount(publicKey)).toHaveLength(count);
        },
      );

      And('the zkapp_action rows store raw fields ["100"] and ["200"]', () => {
        expect(
          store.zkappActionsByAccount("B62qRepeatedContract").map((action) => action.fields),
        ).toEqual([["100"], ["200"]]);
      });

      And(
        "the zkapp child rows for {string} use indexes {int} and {int}",
        (_context, publicKey: string, firstIndex: number, secondIndex: number) => {
          expect(store.zkappEventsByAccount(publicKey).map((event) => event.event_index)).toEqual([
            firstIndex,
            secondIndex,
          ]);
          expect(
            store.zkappActionsByAccount(publicKey).map((action) => action.action_index),
          ).toEqual([firstIndex, secondIndex]);
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

  Scenario(
    "Proved finality creates a batch for already indexed L2 transactions",
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
        "batch for ledger {string} covers transaction heights {int} through {int}",
        (_context, ledger: string, first: number, last: number) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            first_tx_height: first,
            last_tx_height: last,
          });
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
    "Delayed proved finality does not re-attest an L2 rolled-back batch",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment(ledger);
        },
      );

      And("a pending batch row exists for ledger {string}", (_context, ledger: string) => {
        store.upsertBatchForTest(ledger, {
          proof_status: "pending",
          settlement_status: "pending",
        });
      });

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And(
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
        "batch for ledger {string} has settlement_status {string}",
        (_context, ledger: string, settlementStatus: string) => {
          expect(store.batchByLedger(ledger)?.settlement_status).toBe(settlementStatus);
        },
      );

      And(
        "batch for ledger {string} has proof_status {string}",
        (_context, ledger: string, status: string) => {
          expect(store.batchByLedger(ledger)?.proof_status).toBe(status);
        },
      );

      And("batch for ledger {string} has no da_status", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
      });
    },
  );

  Scenario(
    "Delayed proved finality does not create pending DA for an already rolled-back L2 ledger",
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
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And(
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

      Then("no batch row exists for ledger {string}", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)).toBeUndefined();
      });

      And("no pending DA attestation remains for {string}", (_context, ledger: string) => {
        expect(store.pendingDa.get(ledger)).toBeUndefined();
      });
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
    "Out-of-order settlements recompute earlier batch links",
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
        "the indexer consumed a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      When(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then(
        "batch for ledger {string} has transaction_count {int}",
        (_context, ledger: string, count: number) => {
          expect(store.batchByLedger(ledger)?.transaction_count).toBe(count);
        },
      );

      And(
        "batch for ledger {string} has transaction_count {int}",
        (_context, ledger: string, count: number) => {
          expect(store.batchByLedger(ledger)?.transaction_count).toBe(count);
        },
      );

      And(
        "later batch for ledger {string} has batch_height {int}",
        (_context, ledger: string, height: number) => {
          expect(store.batchByLedger(ledger)?.batch_height).toBe(height);
          expect(store.batchByLedger(ledger)?.sort_batch_height).toBe(-height);
        },
      );

      And(
        "batch for ledger {string} has batch_height {int}",
        (_context, ledger: string, height: number) => {
          expect(store.batchByLedger(ledger)?.batch_height).toBe(height);
          expect(store.batchByLedger(ledger)?.sort_batch_height).toBe(-height);
        },
      );

      And(
        "later transaction {string} is linked to batch for ledger {string}",
        (_context, hash: string, ledger: string) => {
          expect(store.transactionByHash(hash)?.batch).toBe(store.batchByLedger(ledger)?.id);
        },
      );

      And(
        "transaction {string} is linked to batch for ledger {string}",
        (_context, hash: string, ledger: string) => {
          expect(store.transactionByHash(hash)?.batch).toBe(store.batchByLedger(ledger)?.id);
        },
      );
    },
  );

  Scenario(
    "L2 rollback clears stale batch links before replacement settlement",
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
        "the indexer consumed a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then("transaction {string} is marked reverted", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.status).toBe("reverted");
      });

      And("transaction {string} is not linked to a batch", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.batch).toBeUndefined();
      });

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
    "L2 rollback projects deletion for cleared batch links",
    ({ Given, When, And, Then }) => {
      const oldBatchLinkByHash = new Map<string, string>();

      Given(
        "the indexer flushed a settled batch for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          const priorLedger = ledger.replace(/-2$/, "-1");
          await consumePayment(priorLedger);
          await consumePayment(ledger);
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
          const revertedTx = store.transactionByHash(`tx-${ledger}`);
          const oldBatch = revertedTx?.batch;
          expect(revertedTx).toBeDefined();
          expect(oldBatch).toBeDefined();
          oldBatchLinkByHash.set(revertedTx?.hash ?? "", `${oldBatch}:${revertedTx?.id}`);
          await writeIndexerProjectionToSurreal(projectionClient, store);
          projectionStatements = [];
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And("the full indexer projection is flushed again", async () => {
        await writeIndexerProjectionToSurreal(projectionClient, store);
      });

      Then(
        "the SurrealDB SQL deletes the old batch link for transaction {string}",
        (_context, hash: string) => {
          const relationId = oldBatchLinkByHash.get(hash);
          expect(relationId).toBeDefined();
          expect(projectionStatements.join("\n")).toContain(
            `DELETE batch_transaction:${encodedRecordId(relationId ?? "")}`,
          );
        },
      );
    },
  );

  Scenario(
    "L2 rollback projects deletion for reverted account transaction links",
    ({ Given, When, And, Then }) => {
      const oldAccountLinkByHash = new Map<string, string>();

      Given(
        "the indexer flushed account transaction links for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          const priorLedger = ledger.replace(/-2$/, "-1");
          await consumePayment(priorLedger);
          await consumePayment(ledger);
          const revertedTx = store.transactionByHash(`tx-${ledger}`);
          const oldActivity = [...store.accountActivities.values()].find(
            (activity) =>
              activity.transaction === revertedTx?.id &&
              ["sender", "receiver", "fee_payer", "touched"].includes(activity.role),
          );
          expect(revertedTx).toBeDefined();
          expect(oldActivity).toBeDefined();
          oldAccountLinkByHash.set(
            revertedTx?.hash ?? "",
            `${oldActivity?.transaction}:${oldActivity?.account}:${oldActivity?.role}:${oldActivity?.activity_index}`,
          );
          await writeIndexerProjectionToSurreal(projectionClient, store);
          projectionStatements = [];
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And("the full indexer projection is flushed again", async () => {
        await writeIndexerProjectionToSurreal(projectionClient, store);
      });

      Then(
        "the SurrealDB SQL deletes the old account transaction link for transaction {string}",
        (_context, hash: string) => {
          const relationId = oldAccountLinkByHash.get(hash);
          expect(relationId).toBeDefined();
          expect(projectionStatements.join("\n")).toContain(
            `DELETE account_transaction:${encodedRecordId(relationId ?? "")}`,
          );
        },
      );

      And(
        "the SurrealDB SQL does not reinsert the old account transaction link for transaction {string}",
        (_context, hash: string) => {
          const relationId = oldAccountLinkByHash.get(hash);
          expect(relationId).toBeDefined();
          expect(projectionStatements.join("\n")).not.toContain(
            `id: account_transaction:${encodedRecordId(relationId ?? "")}`,
          );
        },
      );
    },
  );

  Scenario(
    "Stale settlements do not resurrect L2 rolled-back batches",
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
        "the indexer consumed a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And(
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
        "batch for ledger {string} has proof_status {string}",
        (_context, ledger: string, proofStatus: string) => {
          expect(store.batchByLedger(ledger)?.proof_status).toBe(proofStatus);
        },
      );

      And("batch for ledger {string} has no da_status", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
      });

      And("batch for ledger {string} has no l1_tx_hash", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.l1_tx_hash).toBeUndefined();
      });

      And("transaction {string} is not linked to a batch", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.batch).toBeUndefined();
      });
    },
  );

  Scenario(
    "Stale settlement does not create a batch for an already rolled-back L2 ledger",
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
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then("no batch row exists for ledger {string}", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)).toBeUndefined();
      });

      And("transaction {string} is not linked to a batch", (_context, hash: string) => {
        expect(store.transactionByHash(hash)?.batch).toBeUndefined();
      });
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

      And(
        "batch for ledger {string} keeps l1_confirmations {int}",
        (_context, ledger: string, confirmations: number) => {
          expect(store.batchByLedger(ledger)?.l1_confirmations).toBe(confirmations);
        },
      );
    },
  );

  Scenario(
    "Replayed settling settlement keeps finalized rollback identity",
    ({ Given, When, And, Then }) => {
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
        "the indexer consumes a settlement message for ledger {string} with settlement id {string}",
        async (_context, ledger: string, settlementId: string) => {
          await indexer.consume({
            subject: "zeko.l1.settlements",
            payload: settlement(ledger, "settling", "mina", settlementId),
          });
        },
      );

      And(
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

      And("batch for ledger {string} has no l1_tx_hash", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.l1_tx_hash).toBeUndefined();
      });
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

  Scenario("Duplicate zkApp action states are rejected", ({ Given, When, Then, And }) => {
    Given(
      "the indexer consumed a zkApp transaction for ledger {string}",
      async (_context, ledger: string) => {
        reset();
        await consumeZkapp(ledger, "tx-zk-keep", oneState, "action-keep");
      },
    );

    When(
      "the indexer rejects a zkApp transaction for ledger {string} with duplicate action_state {string}",
      async (_context, ledger: string, actionState: string) => {
        try {
          await consumeZkapp(ledger, "tx-zk-duplicate-action", twoState, actionState);
        } catch (error) {
          lastError = error;
        }
      },
    );

    Then(
      "exactly {int} zkapp_action row has action_state {string}",
      (_context, count: number, actionState: string) => {
        expect(
          [...store.zkappActions.values()].filter((action) => action.action_state === actionState),
        ).toHaveLength(count);
      },
    );

    And("transaction {string} does not exist", (_context, hash: string) => {
      expect(store.transactionByHash(hash)).toBeUndefined();
      expect(lastError).toBeInstanceOf(Error);
    });
  });

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
    "L2 rollback projects deletion for accounts first created by the reverted range",
    ({ Given, When, And, Then }) => {
      const accountIdsByPublicKey = new Map<string, string>();

      Given(
        "the indexer flushed an account created on reverted ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await consumePayment("ledger-account-delete-keep");
          await consumePayment(ledger, undefined, [changedAccount("B62qDeletedAccount", "25", 0)]);
          const account = store.accountByPublicKey("B62qDeletedAccount");
          expect(account).toBeDefined();
          accountIdsByPublicKey.set("B62qDeletedAccount", account?.id ?? "");
          await writeIndexerProjectionToSurreal(projectionClient, store);
          projectionStatements = [];
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      And("the full indexer projection is flushed again", async () => {
        await writeIndexerProjectionToSurreal(projectionClient, store);
      });

      Then("the SurrealDB SQL deletes account {string}", (_context, publicKey: string) => {
        const accountId = accountIdsByPublicKey.get(publicKey);
        expect(accountId).toBeDefined();
        expect(projectionStatements.join("\n")).toContain(
          `DELETE account:${encodedRecordId(accountId ?? "")}`,
        );
      });
    },
  );

  Scenario("L2 rollback restores delegated account state", ({ Given, And, When, Then }) => {
    Given(
      "the indexer consumed an account update for {string} with delegate {string} on ledger {string}",
      async (_context, publicKey: string, delegate: string, ledger: string) => {
        reset();
        await consumePayment(ledger, undefined, [delegatedAccount(publicKey, delegate)]);
      },
    );

    And(
      "the indexer consumed an account update for {string} with delegate {string} on ledger {string}",
      async (_context, publicKey: string, delegate: string, ledger: string) => {
        await consumePayment(ledger, undefined, [delegatedAccount(publicKey, delegate)]);
      },
    );

    When(
      "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
      async (_context, source: string, target: string) => {
        await consumePayment(target, source, [changedAccount("B62qsender", "150", 0)]);
      },
    );

    Then(
      "account {string} has delegate {string}",
      (_context, publicKey: string, delegate: string) => {
        expect(store.accountByPublicKey(publicKey)?.delegate).toBe(delegate);
      },
    );

    And(
      "rollback account activity for {string} records delegate_before {string} and delegate_after {string}",
      (_context, publicKey: string, delegateBefore: string, delegateAfter: string) => {
        expect(
          [...store.accountActivities.values()].find(
            (activity) => activity.account_public_key === publicKey && activity.role === "rollback",
          ),
        ).toMatchObject({
          delegate_before: delegateBefore,
          delegate_after: delegateAfter,
        });
      },
    );

    And(
      "rollback account activity for {string} has a unique activity index",
      (_context, publicKey: string) => {
        const rollbackActivity = [...store.accountActivities.values()].find(
          (activity) => activity.account_public_key === publicKey && activity.role === "rollback",
        );
        expect(rollbackActivity).toBeDefined();
        expect(
          [...store.accountActivities.values()].filter(
            (activity) =>
              activity.transaction === rollbackActivity?.transaction &&
              activity.account === rollbackActivity.account &&
              activity.activity_index === rollbackActivity.activity_index,
          ),
        ).toHaveLength(1);
      },
    );
  });

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
    "Multi-ledger L2 rollback activity uses the pre-rollback account snapshot",
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
        "the indexer consumed another account update for {string} with balance {string} on ledger {string}",
        async (_context, publicKey: string, balance: string, ledger: string) => {
          await consumePayment(ledger, undefined, [changedAccount(publicKey, balance, 0)]);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source, [changedAccount("B62qsender", "150", 0)]);
        },
      );

      Then(
        "rollback account activity for {string} on target ledger {string} records balance_before {string} and balance_after {string}",
        (
          _context,
          publicKey: string,
          ledger: string,
          balanceBefore: string,
          balanceAfter: string,
        ) => {
          expect(
            [...store.accountActivities.values()].find(
              (activity) =>
                activity.account_public_key === publicKey &&
                activity.target_ledger_hash === ledger &&
                activity.role === "rollback",
            ),
          ).toMatchObject({
            balance_before: balanceBefore,
            balance_after: balanceAfter,
          });
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

  Scenario(
    "Re-included command hashes preserve reverted transaction history",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a payment transaction for ledger {string} with command hash {string}",
        async (_context, ledger: string, commandHash: string) => {
          reset();
          await consumePayment(ledger, undefined, undefined, timestamp, commandHash);
        },
      );

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string} with command hash {string}",
        async (_context, source: string, target: string, commandHash: string) => {
          await consumePayment(target, source, undefined, timestamp, commandHash);
        },
      );

      And(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      Then("transaction hash {string} has {int} rows", (_context, hash: string, count: number) => {
        expect(
          [...store.transactions.values()].filter((transaction) => transaction.hash === hash),
        ).toHaveLength(count);
      });

      And(
        "replacement transaction hash {string} on ledger {string} has status {string}",
        (_context, hash: string, ledger: string, status: string) => {
          expect(
            [...store.transactions.values()].find(
              (transaction) =>
                transaction.hash === hash && transaction.target_ledger_hash === ledger,
            )?.status,
          ).toBe(status);
        },
      );

      And(
        "transaction hash {string} on ledger {string} has status {string}",
        (_context, hash: string, ledger: string, status: string) => {
          expect(
            [...store.transactions.values()].find(
              (transaction) =>
                transaction.hash === hash && transaction.target_ledger_hash === ledger,
            )?.status,
          ).toBe(status);
        },
      );

      And("transaction rows have unique block heights", () => {
        const heights = [...store.transactions.values()].map(
          (transaction) => transaction.block_height,
        );
        expect(new Set(heights).size).toBe(heights.length);
      });
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

  Scenario(
    "Proved finality before L2 transaction is materialized when the ledger arrives",
    ({ When, And, Then }) => {
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

      And(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      Then(
        "batch for ledger {string} has proof_status {string}",
        (_context, ledger: string, proofStatus: string) => {
          expect(store.batchByLedger(ledger)?.proof_status).toBe(proofStatus);
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

      And("no pending DA attestation remains for {string}", (_context, ledger: string) => {
        expect(store.pendingDa.has(ledger)).toBe(false);
      });
    },
  );

  Scenario(
    "Materialized proved finality projects deletion for transferred pending DA",
    ({ Given, When, And, Then }) => {
      Given(
        "the indexer flushed proved finality before L2 transaction for ledger {string}",
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
          await writeIndexerProjectionToSurreal(projectionClient, store);
          projectionStatements = [];
        },
      );

      When(
        "the indexer consumes a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

      And("the full indexer projection is flushed again", async () => {
        await writeIndexerProjectionToSurreal(projectionClient, store);
      });

      Then(
        "the SurrealDB SQL deletes pending DA attestation for {string}",
        (_context, ledger: string) => {
          expect(projectionStatements.join("\n")).toContain(
            `DELETE pending_da_attestation:${encodedRecordId(ledger)}`,
          );
        },
      );
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

  Scenario(
    "Additional direct DA signers preserve the quorum attestation time",
    ({ Given, When, Then, And }) => {
      Given(
        "batch for ledger {string} is attested from source {string} at {string} with signers {string} and {string}",
        (
          _context,
          ledger: string,
          source: "proved" | "settlement" | "da-direct",
          attestedAt: string,
          first: string,
          second: string,
        ) => {
          reset();
          store.upsertBatchForTest(ledger, {
            da_status: "attested",
            da_source: source,
            da_attested_at: attestedAt,
            da_quorum_threshold: 2,
            da_signers: [
              { publicKey: first, signedAt: attestedAt, instanceId: `instance-${first}` },
              { publicKey: second, signedAt: attestedAt, instanceId: `instance-${second}` },
            ],
          });
        },
      );

      When(
        "the indexer consumes a valid DA signature for ledger {string} from {string} at {string}",
        async (_context, ledger: string, publicKey: string, signedAt: string) => {
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey, signedAt),
          });
        },
      );

      Then(
        "batch for ledger {string} keeps da_attested_at {string}",
        (_context, ledger: string, attestedAt: string) => {
          expect(store.batchByLedger(ledger)?.da_attested_at).toBe(attestedAt);
        },
      );

      And(
        "batch for ledger {string} records DA signers {string}, {string}, and {string}",
        (_context, ledger: string, first: string, second: string, third: string) => {
          expect(
            store.batchByLedger(ledger)?.da_signers?.map((signer) => signer.publicKey),
          ).toEqual([first, second, third]);
        },
      );
    },
  );

  Scenario(
    "Pending direct DA signatures keep precedence when proved finality creates the batch",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed valid DA signatures for ledger {string} from {string} and {string}",
        async (_context, ledger: string, first: string, second: string) => {
          reset();
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

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

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

  Scenario(
    "Pending direct DA signatures use quorum time when the batch is later created",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a valid DA signature for ledger {string} from {string} at {string}",
        async (_context, ledger: string, publicKey: string, signedAt: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey, signedAt),
          });
        },
      );

      And(
        "the indexer consumes a valid DA signature for ledger {string} from {string} at {string}",
        async (_context, ledger: string, publicKey: string, signedAt: string) => {
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey, signedAt),
          });
        },
      );

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

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
        "batch for ledger {string} has da_status {string} and da_source {string}",
        (_context, ledger: string, status: string, source: string) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            da_status: status,
            da_source: source,
          });
        },
      );

      And(
        "batch for ledger {string} keeps da_attested_at {string}",
        (_context, ledger: string, attestedAt: string) => {
          expect(store.batchByLedger(ledger)?.da_attested_at).toBe(attestedAt);
        },
      );
    },
  );

  Scenario(
    "Below-quorum direct DA signatures are persisted before batch creation",
    ({ Given, Then, And }) => {
      Given(
        "the indexer consumed a valid DA signature for ledger {string} from {string}",
        async (_context, ledger: string, publicKey: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey),
          });
        },
      );

      Then(
        "pending DA attestation for {string} has source {string}",
        (_context, ledger: string, source: string) => {
          expect(store.pendingDa.get(ledger)?.source).toBe(source);
        },
      );

      And(
        "pending DA attestation for {string} records DA signer {string}",
        (_context, ledger: string, publicKey: string) => {
          expect(store.pendingDa.get(ledger)?.signers?.map((signer) => signer.publicKey)).toEqual([
            publicKey,
          ]);
        },
      );
    },
  );

  Scenario(
    "Sub-quorum direct DA signatures do not override proved finality",
    ({ Given, And, When, Then }) => {
      Given(
        "the indexer consumed a valid DA signature for ledger {string} from {string}",
        async (_context, ledger: string, publicKey: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey),
          });
        },
      );

      And(
        "the indexer consumed a payment transaction for ledger {string}",
        async (_context, ledger: string) => {
          await consumePayment(ledger);
        },
      );

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
        "batch for ledger {string} has da_status {string} and da_source {string}",
        (_context, ledger: string, status: string, source: string) => {
          expect(store.batchByLedger(ledger)).toMatchObject({
            da_status: status,
            da_source: source,
          });
        },
      );

      And(
        "batch for ledger {string} records DA signer {string}",
        (_context, ledger: string, publicKey: string) => {
          expect(
            store.batchByLedger(ledger)?.da_signers?.map((signer) => signer.publicKey),
          ).toEqual([publicKey]);
        },
      );
    },
  );

  Scenario(
    "Direct DA signatures are cleared and ignored for L2 rolled-back ledgers",
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
        "the indexer consumed a valid DA signature for ledger {string} from {string}",
        async (_context, ledger: string, publicKey: string) => {
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey),
          });
        },
      );

      When(
        "the indexer consumes a replacement transaction from source ledger {string} to target ledger {string}",
        async (_context, source: string, target: string) => {
          await consumePayment(target, source);
        },
      );

      Then("no pending DA attestation remains for {string}", (_context, ledger: string) => {
        expect(store.pendingDa.has(ledger)).toBe(false);
      });

      When(
        "the indexer consumes a valid DA signature for ledger {string} from {string}",
        async (_context, ledger: string, publicKey: string) => {
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey),
          });
        },
      );

      Then(
        "no pending DA attestation remains after replay for {string}",
        (_context, ledger: string) => {
          expect(store.pendingDa.has(ledger)).toBe(false);
        },
      );
    },
  );

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

    And("batch for ledger {string} has no da_status", (_context, ledger: string) => {
      expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
    });

    And(
      "pending DA attestation for {string} has source {string}",
      (_context, ledger: string, source: string) => {
        expect(store.pendingDa.get(ledger)?.source).toBe(source);
      },
    );
  });

  Scenario(
    "Replayed rolled-back settlements do not restore orphaned L1 fields",
    ({ Given, When, And, Then }) => {
      Given(
        "the indexer consumed a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          reset();
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
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

      And(
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

      And("batch for ledger {string} has no da_status", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
      });

      And("batch for ledger {string} has no l1_tx_hash", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.l1_tx_hash).toBeUndefined();
      });

      And("batch for ledger {string} has no settlement_id", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.settlement_id).toBeUndefined();
      });
    },
  );

  Scenario(
    "L1 rollback before settlement invalidates the delayed settlement ID",
    ({ Given, When, Then }) => {
      Given(
        "the indexer consumed an L1 rollback affecting settlement {string}",
        async (_context, settlementId: string) => {
          reset();
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

      When(
        "the indexer consumes a settlement message for ledger {string}",
        async (_context, ledger: string) => {
          await indexer.consume({ subject: "zeko.l1.settlements", payload: settlement(ledger) });
        },
      );

      Then("no batch row exists for ledger {string}", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)).toBeUndefined();
      });
    },
  );

  Scenario(
    "L1 rollback preserves direct DA signer details for later rebinding",
    ({ Given, When, Then, And }) => {
      Given(
        "batch for ledger {string} is directly attested with signers {string} and {string}",
        (_context, ledger: string, first: string, second: string) => {
          reset();
          store.upsertBatchForTest(ledger, {
            settlement_id: `settlement-${ledger}`,
            settlement_status: "settling",
            da_status: "attested",
            da_source: "da-direct",
            da_attested_at: timestamp,
            da_implementation: "zeko-multisig-v1",
            da_quorum_threshold: 2,
            da_signers: [
              { publicKey: first, signedAt: timestamp, instanceId: `instance-${first}` },
              { publicKey: second, signedAt: timestamp, instanceId: `instance-${second}` },
            ],
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

      Then("batch for ledger {string} has no da_status", (_context, ledger: string) => {
        expect(store.batchByLedger(ledger)?.da_status).toBeUndefined();
      });

      And(
        "pending DA attestation for {string} records DA signers {string} and {string}",
        (_context, ledger: string, first: string, second: string) => {
          expect(store.pendingDa.get(ledger)?.signers?.map((signer) => signer.publicKey)).toEqual([
            first,
            second,
          ]);
        },
      );
    },
  );

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

  Scenario(
    "Pruning stale pending direct DA signatures clears signer buffers",
    ({ Given, When, And, Then }) => {
      Given(
        "the indexer consumed a valid DA signature for ledger {string} from {string} at {string}",
        async (_context, ledger: string, publicKey: string, signedAt: string) => {
          reset();
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey, signedAt),
          });
        },
      );

      When(
        "the pending DA pruner runs with a {int} day max age",
        (_context, maxAgeDays: number) => {
          indexer.prunePendingDa("2026-05-13T00:00:00.000Z", maxAgeDays);
        },
      );

      And(
        "the indexer consumes a valid DA signature for ledger {string} from {string} at {string}",
        async (_context, ledger: string, publicKey: string, signedAt: string) => {
          await indexer.consume({
            subject: "zeko.da.signatures",
            payload: daSignature(ledger, publicKey, signedAt),
          });
        },
      );

      Then(
        "pending DA attestation for {string} records only DA signer {string}",
        (_context, ledger: string, publicKey: string) => {
          expect(store.pendingDa.get(ledger)?.signers?.map((signer) => signer.publicKey)).toEqual([
            publicKey,
          ]);
        },
      );

      And("pending DA attestation for {string} has no attested_at", (_context, ledger: string) => {
        expect(store.pendingDa.get(ledger)?.attested_at).toBeUndefined();
      });
    },
  );

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

  Scenario("Dev entrypoint configuration resolves under raw Node", ({ Then }) => {
    Then("node can execute the zeko-indexer dev entrypoint config check", async () => {
      await execFileAsync(process.execPath, ["src/index.ts"], {
        cwd: serviceRoot,
        env: { ...process.env, ZEKO_INDEXER_CHECK_CONFIG: "1" },
      });
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
  settlementId = `settlement-${ledger}`,
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
    confirmationDepth: finalityLevel === "finalized" ? 290 : 12,
  },
  eventType: finalityLevel === "finalized" ? "finalized" : "detected",
  settlementId,
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

const daSignature = (ledger: string, publicKey: string, signedAt = timestamp) => ({
  schemaVersion: 1,
  implementation: "zeko-multisig-v1",
  ledgerHash: ledger,
  accSet: "acc-set",
  publicKey,
  signature: `sig-${publicKey}`,
  instanceId: `instance-${publicKey}`,
  signedAt,
});

function encodedRecordId(id: string): string {
  return `hex_${Buffer.from(id, "utf8").toString("hex")}`;
}
