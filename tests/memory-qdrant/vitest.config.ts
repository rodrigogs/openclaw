import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: ["node_modules/", "dist/", "build/", "coverage/"],
      lines: 70,
      functions: 70,
      branches: 55,
      statements: 70,
    },
    pool: "forks",
    poolOptions: {
      forks: {
        singleThread: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
