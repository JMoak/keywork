import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
