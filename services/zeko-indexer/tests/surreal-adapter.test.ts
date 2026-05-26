import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  InMemoryIndexerStore,
  type OuterActionRow,
  type SurrealClient,
  writeBridgeProjectionToSurreal,
  writeIndexerProjectionToSurreal,
} from "../src/public";

const feature = await loadFeature("tests/features/surreal-adapter.feature");

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let statements: string[];
  let client: SurrealClient;

  const reset = () => {
    store = new InMemoryIndexerStore();
    statements = [];
    client = {
      async query(surql: string): Promise<void> {
        statements.push(surql);
      },
    };
  };

  Scenario("Relation rows are idempotent across repeated flushes", ({ Given, When, Then, And }) => {
    Given("the in-memory projection has L1 and L2 action links", () => {
      reset();
      store.l1ActionLinks.set("outer-1:bridge-1:witness", {
        id: "outer-1:bridge-1:witness",
        in: "outer-1",
        out: "bridge-1",
        role: "witness",
      });
      store.l2ActionLinks.set("bridge-1:inner-1:mint", {
        id: "bridge-1:inner-1:mint",
        in: "bridge-1",
        out: "inner-1",
        role: "mint",
      });
    });

    When("the bridge projection is flushed twice", async () => {
      await writeBridgeProjectionToSurreal(client, store);
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("every graph relation write uses insert relation with duplicate handling", () => {
      expect(statements.join("\n")).not.toContain("RELATE ");
      expect(statements.join("\n")).toContain("INSERT RELATION INTO l1_action_link");
      expect(statements.join("\n")).toContain("ON DUPLICATE KEY UPDATE");
    });

    And("repeated flushes emit the same relation record IDs", () => {
      expect(statements).toHaveLength(2);
      expect(statements[1]).toBe(statements[0]);
    });
  });

  Scenario("Bridge transaction links are persisted", ({ Given, When, Then }) => {
    Given("the in-memory projection has a bridge transaction link", () => {
      reset();
      store.bridgeTransactionLinks.set("bridge-1:tx-1:l2_finalize", {
        id: "bridge-1:tx-1:l2_finalize",
        in: "bridge-1",
        out: "tx-1",
        role: "l2_finalize",
      });
    });

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL contains a bridge transaction relation", () => {
      expect(statements.join("\n")).toContain("INSERT RELATION INTO bridge_transaction_link");
      expect(statements.join("\n")).toContain('role: "l2_finalize"');
    });
  });

  Scenario(
    "Bridge transaction links write transaction rows before enforced relations",
    ({ Given, When, Then }) => {
      Given("the in-memory projection has a bridge transaction link to a transaction row", () => {
        reset();
        store.transactions.set("tx-1:ledger-1", {
          id: "tx-1",
          hash: "tx-1",
          sequence_number: 1,
          type: "zkapp_command",
          status: "applied",
          sender_public_key: "B62qSender",
          receiver_public_key: "B62qReceiver",
          amount: "42",
          block_height: 10,
          tx_index: 0,
          sort_block_height: -10,
          sort_tx_index: 0,
          timestamp: "2026-05-13T00:00:00.000Z",
          source_ledger_hash: "ledger-0",
          target_ledger_hash: "ledger-1",
        });
        store.bridgeTransactionLinks.set("bridge-1:tx-1:l2_finalize", {
          id: "bridge-1:tx-1:l2_finalize",
          in: "bridge-1",
          out: "tx-1",
          role: "l2_finalize",
        });
      });

      When("the bridge projection is flushed once", async () => {
        await writeBridgeProjectionToSurreal(client, store);
      });

      Then(
        "the SurrealDB SurrealQL writes the transaction before the bridge transaction relation",
        () => {
          const surql = statements.join("\n");
          const transactionIndex = surql.indexOf("UPSERT transaction:");
          expect(transactionIndex).toBeGreaterThanOrEqual(0);
          expect(surql.indexOf("INSERT RELATION INTO bridge_transaction_link")).toBeGreaterThan(
            transactionIndex,
          );
        },
      );
    },
  );

  Scenario("Full projection keeps bridge-linked transaction details", ({ Given, When, Then }) => {
    Given("the in-memory projection has a complete bridge-linked transaction row", () => {
      reset();
      store.accounts.set("B62qSender:1", {
        id: "account-sender",
        public_key: "B62qSender",
        token_id: "1",
        balance: "100",
        nonce: 1,
      });
      store.accounts.set("B62qReceiver:1", {
        id: "account-receiver",
        public_key: "B62qReceiver",
        token_id: "1",
        balance: "200",
        nonce: 0,
      });
      store.transactions.set("tx-bridge:ledger-1", {
        id: "tx-bridge",
        hash: "tx-bridge",
        sequence_number: 1,
        type: "zkapp_command",
        status: "applied",
        sender_public_key: "B62qSender",
        receiver_public_key: "B62qReceiver",
        amount: "42",
        block_height: 10,
        tx_index: 0,
        sort_block_height: -10,
        sort_tx_index: 0,
        timestamp: "2026-05-13T00:00:00.000Z",
        source_ledger_hash: "ledger-0",
        target_ledger_hash: "ledger-1",
      });
      store.bridgeTransactionLinks.set("bridge-1:tx-bridge:l2_finalize", {
        id: "bridge-1:tx-bridge:l2_finalize",
        in: "bridge-1",
        out: "tx-bridge",
        role: "l2_finalize",
      });
    });

    When("the full indexer projection is flushed once", async () => {
      await writeIndexerProjectionToSurreal(client, store);
    });

    Then(
      "the SurrealDB SurrealQL writes the bridge-linked transaction once with account details",
      () => {
        const surql = statements.join("\n");
        const transactionId = `transaction:${encodedRecordId("tx-bridge")}`;
        expect(surql.match(new RegExp(`UPSERT ${transactionId}`, "g")) ?? []).toHaveLength(1);
        expect(surql).toContain(`"sender": account:${encodedRecordId("account-sender")}`);
        expect(surql).toContain(`"receiver": account:${encodedRecordId("account-receiver")}`);
        expect(surql).toContain('"search_text": "tx-bridge zkapp_command B62qSender B62qReceiver"');
      },
    );
  });

  Scenario("Inner actions retain their source transaction record", ({ Given, When, Then }) => {
    Given(
      "the in-memory projection has an inner action from transaction {string}",
      (_, tx: string) => {
        reset();
        store.innerActions.set("inner-after", {
          id: "inner-1",
          after_state: "inner-after",
          before_state: "inner-before",
          action_index: 1,
          block_height: 42,
          timestamp: "2026-05-13T00:00:00.000Z",
          txn_hash: tx,
          transaction: tx,
          fields: ["1", "aux-inner", "B62qRecipient", "42"],
          aux: "aux-inner",
          marked_as_canonical_at: "2026-05-13T00:00:00.000Z",
          target_ledger_hash: "ledger-inner",
        });
      },
    );

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL stores the inner action transaction link", () => {
      expect(statements.join("\n")).toContain('"transaction": transaction:');
    });
  });

  Scenario(
    "Raw transaction object keys are quoted in SurrealDB literals",
    ({ Given, When, Then }) => {
      Given(
        "the in-memory projection has a bridge-linked transaction with producer-owned raw keys",
        () => {
          reset();
          store.transactions.set("tx-raw:ledger-raw", {
            id: "tx-raw",
            hash: "tx-raw",
            sequence_number: 1,
            type: "zkapp_command",
            status: "applied",
            sender_public_key: "B62qSender",
            block_height: 10,
            tx_index: 0,
            sort_block_height: -10,
            sort_tx_index: 0,
            timestamp: "2026-05-13T00:00:00.000Z",
            source_ledger_hash: "ledger-0",
            target_ledger_hash: "ledger-raw",
            raw_command: {
              "account-updates": [{ "weird.key": "value", 'quote"key': "escaped" }],
            },
          });
          store.bridgeTransactionLinks.set("bridge-raw:tx-raw:l2_finalize", {
            id: "bridge-raw:tx-raw:l2_finalize",
            in: "bridge-raw",
            out: "tx-raw",
            role: "l2_finalize",
          });
        },
      );

      When("the bridge projection is flushed once", async () => {
        await writeBridgeProjectionToSurreal(client, store);
      });

      Then("the SurrealDB SurrealQL quotes raw object keys", () => {
        const surql = statements.join("\n");
        expect(surql).toContain('"account-updates":');
        expect(surql).toContain('"weird.key":');
        expect(surql).toContain('"quote\\"key":');
        expect(surql).not.toContain("account-updates:");
        expect(surql).not.toContain("weird.key:");
      });
    },
  );

  Scenario("Incremental flush does not delete existing bridge rows", ({ Given, When, Then }) => {
    Given("the in-memory projection has L1 and L2 action links", () => {
      reset();
      store.l1ActionLinks.set("outer-1:bridge-1:witness", {
        id: "outer-1:bridge-1:witness",
        in: "outer-1",
        out: "bridge-1",
        role: "witness",
      });
      store.l2ActionLinks.set("bridge-1:inner-1:mint", {
        id: "bridge-1:inner-1:mint",
        in: "bridge-1",
        out: "inner-1",
        role: "mint",
      });
    });

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL does not delete bridge projection tables", () => {
      expect(statements.join("\n")).not.toContain("DELETE bridge_transaction_link;");
      expect(statements.join("\n")).not.toContain("DELETE l2_action_link;");
      expect(statements.join("\n")).not.toContain("DELETE l1_action_link;");
      expect(statements.join("\n")).not.toContain("DELETE outer_action;");
      expect(statements.join("\n")).not.toContain("DELETE inner_action;");
      expect(statements.join("\n")).not.toContain("DELETE bridge_operation;");
    });
  });

  Scenario("Tracked removals delete only stale bridge records", ({ Given, When, Then }) => {
    Given("the in-memory projection has a removed L2 action link", () => {
      reset();
      store.bridgeProjectionRemovals.l2ActionLinkIds.add("bridge-1:inner-1:mint");
    });

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL deletes only the removed L2 relation", () => {
      expect(statements.join("\n")).toContain("DELETE l2_action_link:");
      expect(statements.join("\n")).not.toContain("DELETE bridge_operation;");
      expect(statements.join("\n")).not.toContain("DELETE outer_action;");
      expect(statements.join("\n")).not.toContain("DELETE inner_action;");
    });
  });

  Scenario("Tracked core removals delete stale zkApp rows", ({ Given, When, Then }) => {
    Given("the in-memory projection has removed zkApp child rows", () => {
      reset();
      store.coreProjectionRemovals.zkappEventIds.add("zk-event-1");
      store.coreProjectionRemovals.zkappActionIds.add("zk-action-1");
    });

    When("the full indexer projection is flushed once", async () => {
      await writeIndexerProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL deletes the stale zkApp rows", () => {
      const surql = statements.join("\n");
      expect(surql).toContain(`DELETE zkapp_event:${encodedRecordId("zk-event-1")}`);
      expect(surql).toContain(`DELETE zkapp_action:${encodedRecordId("zk-action-1")}`);
    });
  });

  Scenario(
    "Moved batch links delete stale batch transaction relations",
    ({ Given, When, Then }) => {
      Given(
        "the in-memory projection has a removed batch transaction link and a replacement link",
        () => {
          reset();
          store.coreProjectionRemovals.batchTransactionIds.add("batch-old:tx-moved");
          store.batches.set("ledger-new", {
            id: "batch-new",
            target_ledger_hash: "ledger-new",
            batch_height: 1,
            sort_batch_height: -1,
            first_tx_height: 1,
            last_tx_height: 1,
            transaction_count: 1,
            proof_status: "pending",
            settlement_status: "pending",
          });
          store.transactions.set("tx-moved:ledger-new", {
            id: "tx-moved",
            hash: "tx-moved",
            sequence_number: 1,
            type: "payment",
            status: "applied",
            block_height: 1,
            tx_index: 0,
            sort_block_height: -1,
            sort_tx_index: 0,
            timestamp: "2026-05-13T00:00:00.000Z",
            source_ledger_hash: "ledger-old",
            target_ledger_hash: "ledger-new",
            batch: "batch-new",
          });
        },
      );

      When("the full indexer projection is flushed once", async () => {
        await writeIndexerProjectionToSurreal(client, store);
      });

      Then(
        "the SurrealDB SurrealQL deletes the stale batch transaction relation before inserting the replacement",
        () => {
          const surql = statements.join("\n");
          const deleteIndex = surql.indexOf(
            `DELETE batch_transaction:${encodedRecordId("batch-old:tx-moved")}`,
          );
          expect(deleteIndex).toBeGreaterThanOrEqual(0);
          expect(surql.indexOf("INSERT RELATION INTO batch_transaction")).toBeGreaterThan(
            deleteIndex,
          );
        },
      );
    },
  );

  Scenario(
    "Concurrent flushes preserve removals recorded during an in-flight write",
    ({ Given, When, Then }) => {
      let releaseFirstFlush: (() => void) | undefined;

      Given("the in-memory projection has a removed L2 action link", () => {
        reset();
        store.bridgeProjectionRemovals.l2ActionLinkIds.add("bridge-1:inner-1:mint");
        client = {
          async query(surql: string): Promise<void> {
            statements.push(surql);
            if (releaseFirstFlush) {
              return;
            }
            await new Promise<void>((resolve) => {
              releaseFirstFlush = resolve;
            });
          },
        };
      });

      When(
        "a second removed L2 action link is recorded while the first flush is in flight",
        async () => {
          const firstFlush = writeBridgeProjectionToSurreal(client, store);
          await eventually(() => expect(statements).toHaveLength(1));
          store.bridgeProjectionRemovals.l2ActionLinkIds.add("bridge-2:inner-2:mint");
          releaseFirstFlush?.();
          await firstFlush;
          await writeBridgeProjectionToSurreal(client, store);
        },
      );

      Then("the next SurrealDB flush deletes the second removed L2 relation", () => {
        expect(statements).toHaveLength(2);
        expect(statements[0]).toContain(encodedRecordId("bridge-1:inner-1:mint"));
        expect(statements[1]).toContain(encodedRecordId("bridge-2:inner-2:mint"));
      });
    },
  );

  Scenario("Record IDs preserve source identifier uniqueness", ({ Given, When, Then }) => {
    Given("the in-memory projection has outer actions with punctuation-variant IDs", () => {
      reset();
      store.outerActions.set("outer-a", outerAction("outer-a"));
      store.outerActions.set("outer_a", outerAction("outer_a"));
    });

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL uses distinct record IDs for each outer action", () => {
      const surql = statements.join("\n");
      expect(surql).toContain("outer_action:hex_6f757465722d61");
      expect(surql).toContain("outer_action:hex_6f757465725f61");
    });
  });

  Scenario("Full indexer projection persists ordinary L2 rows", ({ Given, When, Then, And }) => {
    Given("the in-memory projection has ordinary L2 account transaction rows", () => {
      reset();
      store.accounts.set("B62qCore:1", {
        id: "account-1",
        public_key: "B62qCore",
        token_id: "1",
        balance: "100",
        nonce: 1,
        first_seen_height: 1,
        last_activity_height: 1,
        last_activity_at: "2026-05-13T00:00:00.000Z",
      });
      store.transactions.set("tx-core:ledger-core", {
        id: "tx-core",
        hash: "tx-core",
        sequence_number: 1,
        type: "payment",
        status: "applied",
        sender_public_key: "B62qCore",
        block_height: 1,
        tx_index: 0,
        sort_block_height: -1,
        sort_tx_index: 0,
        timestamp: "2026-05-13T00:00:00.000Z",
        source_ledger_hash: "ledger-0",
        target_ledger_hash: "ledger-core",
      });
      store.accountActivities.set("activity-1", {
        id: "activity-1",
        account: "account-1",
        account_public_key: "B62qCore",
        transaction: "tx-core",
        role: "sender",
        block_height: 1,
        tx_index: 0,
        activity_index: 0,
        sort_block_height: -1,
        sort_tx_index: 0,
        sort_activity_index: 0,
        timestamp: "2026-05-13T00:00:00.000Z",
        target_ledger_hash: "ledger-core",
      });
    });

    When("the full indexer projection is flushed once", async () => {
      await writeIndexerProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SurrealQL writes the account before its activity", () => {
      const surql = statements.join("\n");
      const accountIndex = surql.indexOf("UPSERT account:");
      expect(accountIndex).toBeGreaterThanOrEqual(0);
      expect(surql.indexOf("UPSERT account_activity:")).toBeGreaterThan(accountIndex);
    });

    And("the SurrealDB SurrealQL writes the transaction before its activity", () => {
      const surql = statements.join("\n");
      const transactionIndex = surql.indexOf("UPSERT transaction:");
      expect(transactionIndex).toBeGreaterThanOrEqual(0);
      expect(surql.indexOf("UPSERT account_activity:")).toBeGreaterThan(transactionIndex);
    });
  });
});

function outerAction(id: string): OuterActionRow {
  return {
    id,
    outer_action_id: id,
    after_state: `${id}-after`,
    before_state: `${id}-before`,
    kind: "witness" as const,
    action_index: 1,
    block_height: 10,
    block_state_hash: "l1-block-10",
    timestamp: "2026-05-13T00:00:00.000Z",
    network: "zeko-m-devnet",
    provider: "mina",
    txn_hash: `${id}-tx`,
    fields: ["1", "aux"],
    slot_range_lower: 100,
    slot_range_upper: 130,
  };
}

function encodedRecordId(id: string): string {
  return `hex_${Buffer.from(id, "utf8").toString("hex")}`;
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
