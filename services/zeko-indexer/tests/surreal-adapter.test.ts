import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  InMemoryIndexerStore,
  type SurrealHttpClient,
  writeBridgeProjectionToSurreal,
} from "../src/index";

const feature = await loadFeature("tests/surreal-adapter.feature");

describeFeature(feature, ({ Scenario }) => {
  let store: InMemoryIndexerStore;
  let statements: string[];
  let client: SurrealHttpClient;

  const reset = () => {
    store = new InMemoryIndexerStore();
    statements = [];
    client = {
      async query(sql: string): Promise<void> {
        statements.push(sql);
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

    Then("the SurrealDB SQL contains a bridge transaction relation", () => {
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
        "the SurrealDB SQL writes the transaction before the bridge transaction relation",
        () => {
          const sql = statements.join("\n");
          const transactionIndex = sql.indexOf("UPSERT transaction:");
          expect(transactionIndex).toBeGreaterThanOrEqual(0);
          expect(sql.indexOf("INSERT RELATION INTO bridge_transaction_link")).toBeGreaterThan(
            transactionIndex,
          );
        },
      );
    },
  );

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

    Then("the SurrealDB SQL stores the inner action transaction link", () => {
      expect(statements.join("\n")).toContain("transaction: transaction:");
    });
  });

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

    Then("the SurrealDB SQL does not delete bridge projection tables", () => {
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

    Then("the SurrealDB SQL deletes only the removed L2 relation", () => {
      expect(statements.join("\n")).toContain("DELETE l2_action_link:");
      expect(statements.join("\n")).not.toContain("DELETE bridge_operation;");
      expect(statements.join("\n")).not.toContain("DELETE outer_action;");
      expect(statements.join("\n")).not.toContain("DELETE inner_action;");
    });
  });

  Scenario("Record IDs preserve source identifier uniqueness", ({ Given, When, Then }) => {
    Given("the in-memory projection has outer actions with punctuation-variant IDs", () => {
      reset();
      store.outerActions.set("outer-a", outerAction("outer-a"));
      store.outerActions.set("outer_a", outerAction("outer_a"));
    });

    When("the bridge projection is flushed once", async () => {
      await writeBridgeProjectionToSurreal(client, store);
    });

    Then("the SurrealDB SQL uses distinct record IDs for each outer action", () => {
      const sql = statements.join("\n");
      expect(sql).toContain("outer_action:hex_6f757465722d61");
      expect(sql).toContain("outer_action:hex_6f757465725f61");
    });
  });
});

function outerAction(id: string) {
  return {
    id,
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
