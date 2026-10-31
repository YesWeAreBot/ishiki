import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// Vite cannot reliably reproduce Koishi's package loader chain from an isolated
// linker. Resolve the core entries through the workspace package's Koishi
// installation so both pnpm and Bun's isolated layouts share the same path.
const packageRequire = createRequire(new URL("./packages/koishi-plugin-ishiki/package.json", import.meta.url));
const koishiRequire = createRequire(packageRequire.resolve("koishi"));
const koishiCore = koishiRequire.resolve("@koishijs/core");
const satoriCore = koishiRequire.resolve("@satorijs/core");

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
