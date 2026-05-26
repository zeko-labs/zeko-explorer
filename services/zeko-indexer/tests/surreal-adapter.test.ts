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
      expect(statements.join("\n")).toContain("id: l1_action_link:outer_1_bridge_1_witness");
      expect(statements.join("\n")).toContain("id: l2_action_link:bridge_1_inner_1_mint");
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
      expect(statements.join("\n")).toContain("out: transaction:tx_1");
      expect(statements.join("\n")).toContain('role: "l2_finalize"');
    });
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

    Then("the SurrealDB SQL stores the inner action transaction link", () => {
      expect(statements.join("\n")).toContain("transaction: transaction:tx_1");
    });
  });

  Scenario(
    "Snapshot flush deletes stale bridge rows and relations",
    ({ Given, When, Then, And }) => {
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

      When(
        "the bridge projection is flushed, L2 evidence is removed, and the projection is flushed again",
        async () => {
          await writeBridgeProjectionToSurreal(client, store);
          store.l2ActionLinks.clear();
          await writeBridgeProjectionToSurreal(client, store);
        },
      );

      Then("the second SurrealDB SQL deletes stale bridge projection rows", () => {
        expect(statements).toHaveLength(2);
        expect(statements[1]).toContain("DELETE l2_action_link");
        expect(statements[1]).toContain("DELETE l1_action_link");
        expect(statements[1]).toContain("DELETE bridge_operation");
      });

      And("the second SurrealDB SQL does not reinsert the removed L2 relation", () => {
        expect(statements[1]).not.toContain("INSERT RELATION INTO l2_action_link");
      });
    },
  );
});
