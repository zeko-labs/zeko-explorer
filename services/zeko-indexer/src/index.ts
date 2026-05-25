import { pathToFileURL } from "node:url";
import { SURREALKIT_PROJECT_DIR } from "@zeko/database";
import { NATS_SUBJECTS } from "@zeko/nats";

export * from "./indexer";
export * from "./store";
export * from "./types";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(
    JSON.stringify(
      {
        component: "zeko-indexer",
        consumes: [
          NATS_SUBJECTS.l2Transactions,
          NATS_SUBJECTS.l2Finality,
          NATS_SUBJECTS.l1Settlements,
          NATS_SUBJECTS.l1Rollbacks,
          NATS_SUBJECTS.daSignatures,
        ],
        surrealKitProject: SURREALKIT_PROJECT_DIR,
      },
      null,
      2,
    ),
  );
}
