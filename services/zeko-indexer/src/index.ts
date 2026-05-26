import { isDirectEntrypoint, runIndexerFromEnv } from "./runtime.ts";

export * from "./action-state.ts";
export * from "./adapters/nats.ts";
export * from "./adapters/surreal.ts";
export * from "./bridge.ts";
export * from "./indexer.ts";
export * from "./runtime.ts";
export * from "./store.ts";
export * from "./types.ts";

if (isDirectEntrypoint(import.meta.url)) {
  try {
    await runIndexerFromEnv();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
