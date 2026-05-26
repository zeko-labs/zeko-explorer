import { isDirectEntrypoint, runIndexerFromEnv } from "#src/runtime";

if (isDirectEntrypoint(import.meta.url)) {
  try {
    await runIndexerFromEnv();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
