import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolver: "tsc",
  },
  clean: true,
  sourcemap: true,
});
