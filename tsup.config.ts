import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
  bundle: false,
  splitting: false,
  shims: false,
  minify: true,
});
