import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (isDirectEntrypoint(import.meta.url)) {
  try {
    if (process.env.ZEKO_INDEXER_CHECK_CONFIG === "1") {
      process.exitCode = 0;
    } else {
      const runtimeModule = await import(new URL("../dist/runtime.mjs", import.meta.url).href);
      await runtimeModule.runIndexerFromEnv();
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

function isDirectEntrypoint(importMetaUrl: string, argv = process.argv): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && resolve(fileURLToPath(importMetaUrl)) === resolve(entrypoint);
}
