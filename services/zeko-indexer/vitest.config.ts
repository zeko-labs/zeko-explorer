import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@zeko/database": `${root}/services/database/src/index.ts`,
      "@zeko/nats": `${root}/services/nats/src/index.ts`,
    },
  },
  test: {
    environment: "node",
  },
});
