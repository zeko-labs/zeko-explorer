import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (isDirectEntrypoint(import.meta.url)) {
  try {
    if (process.env.ZEKO_INDEXER_CHECK_CONFIG === "1") {
      process.exitCode = 0;
    } else {
      registerTypeScriptBundlerResolution();
      const { runIndexerFromEnv } = await import("./runtime");
      await runIndexerFromEnv();
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

function registerTypeScriptBundlerResolution(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        isExtensionlessRelativeSpecifier(specifier) &&
        !context.parentURL?.includes("/node_modules/")
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

function isExtensionlessRelativeSpecifier(specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return false;
  }
  const lastSegment = specifier.split("/").at(-1);
  return lastSegment !== undefined && !lastSegment.includes(".");
}
