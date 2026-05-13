import { renderSurrealMigration } from "@zeko/db";
import { NATS_SUBJECTS } from "@zeko/nats-protocol";

console.log(
  JSON.stringify(
    {
      component: "zeko-indexer",
      consumes: [
        NATS_SUBJECTS.l2Transactions,
        NATS_SUBJECTS.l2Finality,
        NATS_SUBJECTS.l1Settlements,
        NATS_SUBJECTS.l1Rollbacks,
        NATS_SUBJECTS.health,
      ],
      migrationsLoaded: renderSurrealMigration().split("\n").length,
    },
    null,
    2,
  ),
);
