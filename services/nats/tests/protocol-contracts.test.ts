import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { parse, safeParse } from "valibot";
import { expect } from "vitest";
import {
  DaSignatureEventSchema,
  EventSchemas,
  HealthEventSchema,
  NATS_MESSAGE_ID,
  NATS_SUBJECTS,
  NetworkIdSchema,
} from "../src/index.ts";
import { invalidFixtures, validFixtures } from "./fixtures/protocol-events.ts";

const feature = await loadFeature("tests/protocol-contracts.feature");

const schemaFixtures = [
  ["l2Transactions", EventSchemas.l2Transactions],
  ["l2Finality", EventSchemas.l2Finality],
  ["l1Settlements", EventSchemas.l1Settlements],
  ["l1Rollbacks", EventSchemas.l1Rollbacks],
  ["l1OuterActions", EventSchemas.l1OuterActions],
  ["l1BridgeEvents", EventSchemas.l1BridgeEvents],
  ["daSignatures", DaSignatureEventSchema],
  ["daSignaturesCelestia", DaSignatureEventSchema],
  ["sequencerHealth", HealthEventSchema],
  ["l1WatcherHealth", HealthEventSchema],
  ["daNodeHealth", HealthEventSchema],
] as const;

describeFeature(feature, ({ Scenario }) => {
  Scenario("Fixture payloads match their schemas", ({ Given, Then, And }) => {
    Given("the NATS protocol event fixtures", () => {
      expect(schemaFixtures).toHaveLength(11);
    });

    Then("every valid fixture is accepted by its event schema", () => {
      for (const [name, schema] of schemaFixtures) {
        expect(safeParse(schema, validFixtures[name]).success, `${name} should be valid`).toBe(
          true,
        );
      }
    });

    And("every invalid fixture is rejected by its event schema", () => {
      for (const [name, schema] of schemaFixtures) {
        expect(safeParse(schema, invalidFixtures[name]).success, `${name} should be invalid`).toBe(
          false,
        );
      }
    });
  });

  Scenario("DA signatures use the resolved subject", ({ Then, And }) => {
    Then('the NATS subjects include "zeko.da.signatures"', () => {
      expect(Object.values(NATS_SUBJECTS)).toContain("zeko.da.signatures");
    });

    And('the NATS subjects do not include "zeko.da.attestations"', () => {
      expect(Object.values(NATS_SUBJECTS)).not.toContain("zeko.da.attestations");
    });
  });

  Scenario("Producer-owned fields survive validation", ({ Given, When, Then }) => {
    let parsedL2Transaction: unknown;

    Given("an L2 transaction with producer-owned raw fields", () => {
      parsedL2Transaction = {
        ...validFixtures.l2Transactions,
        raw_da_layer_field: { retained: true },
      };
    });

    When("the L2 transaction event is parsed", () => {
      parsedL2Transaction = parse(EventSchemas.l2Transactions, parsedL2Transaction);
    });

    Then("the producer-owned raw fields are retained", () => {
      expect(parsedL2Transaction).toEqual({
        ...validFixtures.l2Transactions,
        raw_da_layer_field: { retained: true },
      });
    });
  });

  Scenario("Bridge events reject deprecated ordering fields", ({ Then }) => {
    Then('an L1 bridge event with "aux_sequence" is rejected', () => {
      expect(
        safeParse(EventSchemas.l1BridgeEvents, {
          ...validFixtures.l1BridgeEvents,
          aux_sequence: 1,
        }).success,
      ).toBe(false);
    });
  });

  Scenario("Sequencer health requires freshness fields", ({ Then }) => {
    Then("a sequencer health heartbeat without freshness fields is rejected", () => {
      expect(
        safeParse(HealthEventSchema, {
          service: "sequencer-nats-publisher",
        }).success,
      ).toBe(false);
    });
  });

  Scenario("L1 watcher health accepts provider-specific limitations", ({ Then }) => {
    Then("an L1 watcher health heartbeat with a provider-specific limitation is accepted", () => {
      expect(
        safeParse(HealthEventSchema, {
          ...validFixtures.l1WatcherHealth,
          limitations: ["mina_archive_provider_rate_limited"],
        }).success,
      ).toBe(true);
    });
  });

  Scenario("Network identifiers follow the PRD", ({ Then, And }) => {
    Then("the PRD Zeko-E testnet network id is accepted", () => {
      expect(safeParse(NetworkIdSchema, "zeko-e-testnet").success).toBe(true);
    });

    And("the spike-only Zeko-E testnet variant is rejected", () => {
      expect(safeParse(NetworkIdSchema, "zeko-e-testnet-1").success).toBe(false);
    });
  });

  Scenario("Message identifiers are deterministic", ({ Then }) => {
    Then("the NATS message id helpers produce the documented keys", () => {
      expect(NATS_MESSAGE_ID.l2Transaction("ledger-1")).toBe("ledger-1");
      expect(NATS_MESSAGE_ID.l2Finality("proved", "ledger-1")).toBe("finality-proved-ledger-1");
      expect(NATS_MESSAGE_ID.l1Settlement("zeko-m-devnet", "tx:au:0", "detected", 12)).toBe(
        "l1-settlement:zeko-m-devnet:tx:au:0:detected:12",
      );
      expect(NATS_MESSAGE_ID.l1Settlement("zeko-m-devnet", "tx:au:0", "finalized", 290)).toBe(
        "l1-settlement:zeko-m-devnet:tx:au:0:finalized",
      );
      expect(NATS_MESSAGE_ID.l1OuterAction("zeko-m-devnet", "tx:au:0")).toBe(
        "l1-outer-action:zeko-m-devnet:tx:au:0",
      );
      expect(NATS_MESSAGE_ID.l1BridgeEvent("zeko-m-devnet", "tx:au:0:deposit_submitted")).toBe(
        "l1-bridge-event:zeko-m-devnet:tx:au:0:deposit_submitted",
      );
      expect(NATS_MESSAGE_ID.l1Rollback("zeko-m-devnet", "ancestor:old:new")).toBe(
        "l1-rollback:zeko-m-devnet:ancestor:old:new",
      );
      expect(NATS_MESSAGE_ID.daSignature(validFixtures.daSignatures)).toBe(
        "da-sig-B62qdaoperator-ledger-1",
      );
      expect(NATS_MESSAGE_ID.daSignature(validFixtures.daSignaturesCelestia)).toBe(
        "da-sig-celestia-ledger-1",
      );
    });
  });
});
