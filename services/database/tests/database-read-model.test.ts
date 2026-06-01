import { loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll } from "vitest";
import { startSurreal, stopSurreal } from "./lib/surreal-client.ts";
import { describeDatabaseFeature } from "./support/database-steps.ts";

const featureFiles = [
  "tests/features/initial_schema.feature",
  "tests/features/da_status_storage.feature",
  "tests/features/graph_model.feature",
  "tests/features/idempotency.feature",
  "tests/features/query_catalog.feature",
  "tests/features/rollback.feature",
  "tests/features/schema_inventory.feature",
] as const;

beforeAll(async () => {
  await startSurreal();
}, 60_000);

afterAll(async () => {
  await stopSurreal();
});

for (const feature of await Promise.all(
  featureFiles.map((featureFile) => loadFeature(featureFile)),
)) {
  describeDatabaseFeature(feature);
}
