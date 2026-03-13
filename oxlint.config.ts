import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  rules: {
    "no-unused-vars": "error",
    "no-console": "error",
    eqeqeq: "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
  },
  settings: {},
  env: {
    builtin: true,
    node: true,
  },
  globals: {},
  ignorePatterns: ["examples/**"],
});
