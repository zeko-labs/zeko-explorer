import { NATS_SUBJECTS } from "@zeko/nats";

console.log(
  JSON.stringify(
    {
      component: "da-monitor",
      mode: "disabled",
      reason:
        "Spike 007 keeps baseline DA status derivation in zeko-indexer; direct signatures are published by DA nodes.",
      optionalPath: {
        publishes: [NATS_SUBJECTS.daSignatures, NATS_SUBJECTS.health],
      },
    },
    null,
    2,
  ),
);
