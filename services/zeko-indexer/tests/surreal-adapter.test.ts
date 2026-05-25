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
});
