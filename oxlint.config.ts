import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  rules: {
    "no-unused-vars": "warn",
    "no-console": "error",
    eqeqeq: "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "no-await-in-loop": "off",
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "require-yield": "off",
  },
  settings: {},
  env: {
    builtin: true,
    node: true,
  },
  globals: {},
  ignorePatterns: ["src/examples/**"],
});
