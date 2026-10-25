import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".omp/**",
    "**/dist/**",
    "**/lib/**",
    "**/node_modules/**",
    "**/CHANGELOG.md",
    "packages/onebot-actions/src/catalog/generated.ts",
    "docs/**",
  ],
  sortImports: {
    newlinesBetween: true,
  },
  sortPackageJson: {
    sortDependencies: true,
    sortDevDependencies: true,
    sortPeerDependencies: true,
    sortScripts: true,
  },
  endOfLine: "lf",
  semi: true,
  printWidth: 160,
  objectWrap: "preserve",
  singleQuote: false,
  insertFinalNewline: true,
  trailingComma: "all",
});
