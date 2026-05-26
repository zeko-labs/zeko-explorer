import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { consumeNatsMessage, resolveNatsEnvelopeSourceConfig } from "../src/public";

const feature = await loadFeature("tests/features/nats-adapter.feature");
const textEncoder = new TextEncoder();

describeFeature(feature, ({ Scenario }) => {
  let resolved: ReturnType<typeof resolveNatsEnvelopeSourceConfig>;
  let acknowledged: boolean;
  let delivered: ReturnType<typeof consumeNatsMessage>;

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

  Scenario("Invalid subscribed payloads are acknowledged and dropped", ({ When, Then, And }) => {
    When(
      "a schema-invalid NATS message is consumed on subject {string}",
      (_context, subject: string) => {
        acknowledged = false;
        delivered = consumeNatsMessage({
          subject,
          data: textEncoder.encode(JSON.stringify({ schemaVersion: 1 })),
          ack() {
            acknowledged = true;
          },
        });
      },
    );

    Then("the NATS message is acknowledged", () => {
      expect(acknowledged).toBe(true);
    });

    And("no envelope is delivered", () => {
      expect(delivered).toBeUndefined();
    });
  });
});
