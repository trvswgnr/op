import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/platform-globals.d.ts",
        "src/core/types.ts",
        "src/result.ts",
        "src/test-utils.ts",
      ],
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "coverage",
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["src/**/*.test.ts"],
    },
  },
});
