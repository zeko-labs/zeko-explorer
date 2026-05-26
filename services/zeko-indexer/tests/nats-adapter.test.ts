import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { resolveNatsEnvelopeSourceConfig } from "../src/index";

const feature = await loadFeature("tests/nats-adapter.feature");

describeFeature(feature, ({ Scenario }) => {
  let resolved: ReturnType<typeof resolveNatsEnvelopeSourceConfig>;

  Scenario("Minimal source config resolves to the default L1 stream", ({ When, Then, And }) => {
    When(
      "the NATS envelope source config is resolved with only servers {string}",
      (_context, servers: string) => {
        resolved = resolveNatsEnvelopeSourceConfig({ servers });
      },
    );
    Then("the source consumes stream {string}", (_context, stream: string) => {
      expect(resolved.stream).toBe(stream);
    });
    And("the source filters subject {string}", (_context, subject: string) => {
      expect(resolved.subject).toBe(subject);
    });
  });

  Scenario(
    "Stream-only source config uses the matching subject wildcard",
    ({ When, Then, And }) => {
      When(
        "the NATS envelope source config is resolved with stream {string}",
        (_context, stream: string) => {
          resolved = resolveNatsEnvelopeSourceConfig({
            servers: "nats://127.0.0.1:4222",
            stream,
          });
        },
      );
      Then("the source consumes stream {string}", (_context, stream: string) => {
        expect(resolved.stream).toBe(stream);
      });
      And("the source filters subject {string}", (_context, subject: string) => {
        expect(resolved.subject).toBe(subject);
      });
    },
  );
});
