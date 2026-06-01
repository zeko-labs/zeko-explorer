import { runIndexerFromEnv } from "./runtime.ts";

try {
  await runIndexerFromEnv();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
