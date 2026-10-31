import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// Vite cannot reliably reproduce Koishi's package loader chain from an isolated
// linker. Resolve the same installed core entries as Koishi without coupling the
// test runner to one package manager or dependency version.
const require = createRequire(import.meta.url);
const koishiCore = require.resolve("@koishijs/core");
const satoriCore = require.resolve("@satorijs/core");

export default defineConfig({
  resolve: {
    alias: {
      koishi: koishiCore,
      "@satorijs/core": satoriCore,
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/.git/**"],
    include: ["packages/*/tests/**/*.spec.ts", "scripts/tests/**/*.spec.ts"],
  },
});
